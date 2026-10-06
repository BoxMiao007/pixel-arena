// 跑分组标签页与评测轮管理（T05）+ 评测轮内容（选图 / 跑分 / 结果表，T06）。
// 前端不持有任何持久化逻辑：每次改动都经 IPC 命令落到核心库并立即写盘，
// 命令返回最新工作区整份状态，前端照着重渲染即可，不自己算状态。

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { mountViewer } from './viewer';
import { mountVideoBlock, type VideoCandidate } from './video'; // T14 接线点：视频评测区块
import { fileName } from './util';
// T11 接线点：一站式跑分升级为完整编码阶梯（格式/质量档/无损组可勾选），
// 清单与生成循环在 src/onestop.ts，本文件只做勾选 UI、触发与进度显示
import {
  runOnestop as runOnestopLadder,
  buildLadder,
  defaultSelection,
  initOnestopCatalog,
  LOSSY_FORMATS,
  QUALITIES,
  LOSSLESS_FORMATS,
  type OnestopSelection,
} from './onestop';
import './style.css';

// 与核心库 workspace.rs 的 serde 输出（camelCase）一一对应

// 指标值：有限数值，或 "inf" 哨兵（两图完全一致时 PSNR 的情形）
type MetricValue = number | 'inf';

interface CandidateImage {
  path: string;
  fileSize: number;
  sizeRatio: number | null;
  metrics: Record<string, MetricValue> | null;
  /** 编码参数文本（如「JPEG q75」「PNG 无损」），一站式模式写入；外部导入为 null
   *（参数用户自备，工具不知晓），界面显示 —。 */
  encodingParams?: string | null;
  error: string | null;
}

interface Round {
  id: string;
  name: string;
  referencePath: string | null;
  candidates: CandidateImage[];
  // T14 接线点：视频评测字段（核心库 serde default，旧文件为空；实现都在 src/video.ts）
  videoReferencePath?: string | null;
  videoCandidates?: VideoCandidate[];
}

// T17：跑分组类型（核心库 GroupKind 的 serde 输出），新建时选定、后端无修改入口
type GroupKind = 'image' | 'video';

/** 类型的界面文案（标签页悬浮提示与评测轮栏用）。 */
function groupKindLabel(kind: GroupKind): string {
  return kind === 'video' ? '视频跑分组' : '图片跑分组';
}

interface Group {
  id: string;
  name: string;
  kind: GroupKind;
  rounds: Round[];
  activeRoundId: string | null;
}

// 导出给 onestop.ts 复用（one-stop 回传最新工作区用），字段与 workspace.rs 的 serde 输出一致
export interface Workspace {
  formatVersion: number;
  groups: Group[];
  activeGroupId: string | null;
}

let ws: Workspace | null = null;

// ---------- 跑分与排序的界面状态（不持久化，重启归零） ----------

// 跑分进行中：三个操作按钮置灰，逐张完成后整份工作区刷新
let scoring = false;
// 正在跑分的那张（行内显示「跑分中…」，跑分进度可见）
let scoringPath: string | null = null;
// 结果表排序：null 按选入顺序；dir=1 升序 / -1 降序
let sortState: { key: string; dir: 1 | -1 } | null = null;
// 排序状态跟随评测轮：切到另一轮就归零
let sortRoundId: string | null = null;

// T11 接线点：一站式编码阶梯的勾选状态（界面会话态，重启归零，默认全开 = 决策 0003）
let onestopSelection: OnestopSelection = defaultSelection();

const $tabs = document.querySelector<HTMLDivElement>('#tabs')!;
const $rounds = document.querySelector<HTMLDivElement>('#rounds')!;
const $content = document.querySelector<HTMLElement>('#content')!;
const $status = document.querySelector<HTMLSpanElement>('#status')!;
const $addGroup = document.querySelector<HTMLButtonElement>('#add-group')!;
const $newGroupKind = document.querySelector<HTMLSelectElement>('#new-group-kind')!;
const $roundbarLabel = document.querySelector<HTMLSpanElement>('#roundbar-label')!;
const $addRound = document.querySelector<HTMLButtonElement>('#add-round')!;

function activeGroup(): Group | null {
  if (!ws || !ws.activeGroupId) return null;
  return ws.groups.find((g) => g.id === ws!.activeGroupId) ?? null;
}

function setStatus(text: string, isError = false): void {
  $status.textContent = text;
  $status.classList.toggle('status-error', isError);
}

function markSaved(): void {
  setStatus(`已自动保存 ${new Date().toLocaleTimeString('zh-CN')}`);
}

// 所有改动走这里：调 IPC -> 用返回的工作区替换本地状态 -> 重渲染。
// 失败时把中文错误亮在状态栏，不弹窗打断。
async function apply(action: () => Promise<Workspace>): Promise<void> {
  try {
    ws = await action();
    render();
    markSaved();
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  }
}

function createGroup(): void {
  const name = `跑分组 ${ws ? ws.groups.length + 1 : 1}`;
  // T17：类型随下拉菜单选定（image / video），后端创建后不可更改
  const kind = $newGroupKind.value as GroupKind;
  void apply(() => invoke('group_create', { name, kind }));
}

function createRound(): void {
  const group = activeGroup();
  if (!group) return;
  const name = `评测轮 ${group.rounds.length + 1}`;
  void apply(() => invoke('round_create', { groupId: group.id, name }));
}

// ---------- 选图与跑分（T06） ----------

// 文件对话框可选格式按核心库 decode.rs 实际支持范围开（PNG/JPEG/WebP 走 image crate
// 进程内解码；JPEG XL 走 jxl-oxide 进程内，AVIF 走 avifdec 子进程——首次一站式生成
// AVIF 产物时自动安装，外部直接导入 AVIF 时若尚未安装会在跑分时报中文提示）
const IMAGE_FILTER = {
  name: '图片（PNG / JPEG / WebP / AVIF / JPEG XL）',
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'jxl'],
};

function activeRound(): { group: Group; round: Round } | null {
  const group = activeGroup();
  const round = group?.rounds.find((r) => r.id === group.activeRoundId);
  return group && round ? { group, round } : null;
}

/** 弹系统文件对话框选原图。取消选择则不动工作区。 */
async function pickReference(): Promise<void> {
  const session = activeRound();
  if (!session || scoring) return;
  const selected = await open({ title: '选择原图', multiple: false, filters: [IMAGE_FILTER] });
  if (typeof selected !== 'string') return; // 用户取消
  await apply(() =>
    invoke('round_set_reference', {
      groupId: session.group.id,
      roundId: session.round.id,
      path: selected,
    }),
  );
}

/** 弹系统文件对话框多选跑分图。取消或空选则不动工作区。 */
async function pickCandidates(): Promise<void> {
  const session = activeRound();
  if (!session || scoring) return;
  const selected = await open({
    title: '添加跑分图（可多选）',
    multiple: true,
    filters: [IMAGE_FILTER],
  });
  if (selected === null) return; // 用户取消
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return;
  await apply(() =>
    invoke('round_add_candidates', { groupId: session.group.id, roundId: session.round.id, paths }),
  );
}

/**
 * 触发跑分：忙标志置好后交给逐张跑分循环（T06）。
 */
async function startScoring(): Promise<void> {
  const session = activeRound();
  if (!session || scoring || !session.round.referencePath) return;
  if (session.round.candidates.length === 0) return;

  scoring = true;
  scoringPath = null;
  render();

  try {
    await scoreAllCandidates();
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  } finally {
    scoring = false;
    scoringPath = null;
    render();
  }
}

/**
 * 逐张跑分循环（T06）：前端逐张调用跑分命令，每张回来整份工作区刷新一次——
 * 进度（状态栏「跑分中 i/N」+ 行内「跑分中…」）与单张失败（行内标「失败」）天然可见。
 * 命令本身出错（如评测轮被删）时中止整个循环。
 * 忙标志（scoring）由调用方管理：手动「开始跑分」与一站式跑分（runOnestop）共用本循环。
 */
async function scoreAllCandidates(): Promise<void> {
  const session = activeRound();
  if (!session || !session.round.referencePath) return;
  if (session.round.candidates.length === 0) return;

  // 队列快照：跑分期间工作区每张都在被替换，按选入顺序逐张跑
  const queue = session.round.candidates.map((c) => c.path);

  for (let i = 0; i < queue.length; i++) {
    scoringPath = queue[i];
    setStatus(`跑分中 ${i + 1}/${queue.length}：${fileName(queue[i])}`);
    render();
    ws = await invoke('round_score_candidate', {
      groupId: session.group.id,
      roundId: session.round.id,
      candidatePath: queue[i],
    });
    render();
  }
  markSaved();
  setStatus(`跑分完成，共 ${queue.length} 张`);
}

// ---------- 一站式跑分（T11 完整编码阶梯，清单实现在 src/onestop.ts） ----------

/**
 * 触发一站式跑分：按勾选的格式 × 质量档 + 无损组逐项生成 → 产物自动纳入本轮 →
 * 复用上面的逐张跑分循环出分。期间沿用 scoring 忙标志置灰全部操作按钮。
 * 某项失败不回滚已成功的项，失败项的中文原因在跑分结束后补充提示。
 */
async function runOnestop(): Promise<void> {
  const session = activeRound();
  if (!session || scoring || !session.round.referencePath) return;
  const ladder = buildLadder(onestopSelection);
  if (ladder.length === 0) {
    setStatus('请先勾选至少一个编码格式、质量档或无损组', true);
    return;
  }

  scoring = true;
  scoringPath = null;
  render();

  try {
    const result = await runOnestopLadder({
      groupId: session.group.id,
      roundId: session.round.id,
      referencePath: session.round.referencePath,
      ladder,
      onProgress: setStatus,
      onWorkspace: (updated) => {
        ws = updated;
        render();
        markSaved();
      },
    });
    if (result.generated > 0) {
      await scoreAllCandidates();
      if (result.failures.length > 0) {
        setStatus(`跑分完成；生成失败的项：${result.failures.join('；')}`, true);
      }
    } else {
      setStatus(`一站式生成全部失败：${result.failures.join('；')}`, true);
    }
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  } finally {
    scoring = false;
    scoringPath = null;
    render();
  }
}

/**
 * T11 接线点：一站式勾选区（格式 × 质量档 × 无损组，默认全开）。
 * 勾选状态放在模块级 onestopSelection，重渲染后按它恢复勾选框。
 */
function buildOnestopOptions(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'onestop-options';

  const group = (labelText: string): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
    const wrap = document.createElement('label');
    wrap.className = 'onestop-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.disabled = scoring;
    const span = document.createElement('span');
    span.textContent = labelText;
    wrap.append(input, span);
    return { wrap, input };
  };

  const formats = document.createElement('span');
  formats.className = 'onestop-group-label';
  formats.textContent = '格式';
  box.append(formats);
  for (const { format, label } of LOSSY_FORMATS) {
    const { wrap, input } = group(label);
    input.checked = onestopSelection.lossyFormats.includes(format);
    input.addEventListener('change', () => {
      onestopSelection.lossyFormats = input.checked
        ? [...onestopSelection.lossyFormats, format]
        : onestopSelection.lossyFormats.filter((f) => f !== format);
    });
    box.append(wrap);
  }

  const qualities = document.createElement('span');
  qualities.className = 'onestop-group-label';
  qualities.textContent = '质量档';
  box.append(qualities);
  for (const quality of QUALITIES) {
    const { wrap, input } = group(`q${quality}`);
    input.checked = onestopSelection.qualities.includes(quality);
    input.addEventListener('change', () => {
      onestopSelection.qualities = input.checked
        ? [...onestopSelection.qualities, quality]
        : onestopSelection.qualities.filter((q) => q !== quality);
    });
    box.append(wrap);
  }

  const lossless = document.createElement('span');
  lossless.className = 'onestop-group-label';
  lossless.textContent = '无损组';
  box.append(lossless);
  for (const { format, label } of LOSSLESS_FORMATS) {
    const { wrap, input } = group(label);
    input.checked = onestopSelection.losslessFormats.includes(format);
    input.addEventListener('change', () => {
      onestopSelection.losslessFormats = input.checked
        ? [...onestopSelection.losslessFormats, format]
        : onestopSelection.losslessFormats.filter((f) => f !== format);
    });
    box.append(wrap);
  }
  return box;
}

/**
 * T11 接线点：AVIF/JXL 产物 WebView 原生解不了，查看器改看核心库生成产物时
 * 旁路写出的 PNG 代片（<产物>.png，像素与产物解码一致，见决策 0012）。
 * 只影响查看显示；跑分与结果表仍用产物本身。
 */
function viewerPath(path: string): string {
  return path.endsWith('.avif') || path.endsWith('.jxl') ? `${path}.png` : path;
}

/**
 * T14 接线点：视频跑分单对执行（src/video.ts 的跑分循环逐对调用本函数），
 * 与图片的 startScoring 同一模式：invoke → 替换工作区 → 重渲染。
 */
async function scoreVideoOne(candidatePath: string): Promise<void> {
  const session = activeRound();
  if (!session) return;
  ws = await invoke('round_score_video_candidate', {
    groupId: session.group.id,
    roundId: session.round.id,
    candidatePath,
  });
  render();
  markSaved();
}

// ---------- T13 接线点：BD-rate 汇总与报告导出 ----------
// 汇总与导出都走核心库（bdrate / report 模块）的同一份数据源，保证界面与导出一致。

// 与核心库 bdrate.rs 的 serde 输出（camelCase）一一对应
interface BdrateEntry {
  format: string;
  bdRatePercent: number | null;
  pointCount: number;
  note: string | null;
}

interface BdrateSummary {
  referenceFormat: string | null;
  note: string | null;
  entries: BdrateEntry[];
}

/** BD-rate 数值与导出报告同格式：带符号两位小数百分数 */
function formatBdRate(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function buildBdrateTable(summary: BdrateSummary): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'result-table bdrate-table';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['格式', 'BD-rate', '样本点', '说明']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  for (const entry of summary.entries) {
    const tr = document.createElement('tr');
    const format = document.createElement('td');
    format.textContent = entry.format;
    const bd = document.createElement('td');
    bd.textContent =
      entry.bdRatePercent === null ? '—' : formatBdRate(entry.bdRatePercent);
    const count = document.createElement('td');
    count.textContent = String(entry.pointCount);
    const note = document.createElement('td');
    note.textContent = entry.note ?? '';
    if (entry.note === '参照格式') format.classList.add('bdrate-reference');
    tr.append(format, bd, count, note);
    body.append(tr);
  }
  table.append(body);
  return table;
}

/**
 * 异步填充 BD-rate 汇总区：invoke → 只更新容器内部，不触发整页重渲染（避免循环）。
 * 渲染期间切了评测轮时容器已被整页重渲染丢弃，写进脱离的 DOM 无副作用。
 */
async function fillBdrateSummary(
  box: HTMLDivElement,
  groupId: string,
  roundId: string,
): Promise<void> {
  try {
    const summary = await invoke<BdrateSummary>('round_bdrate', { groupId, roundId });
    box.replaceChildren();
    const title = document.createElement('h3');
    title.className = 'bdrate-title';
    title.textContent = summary.referenceFormat
      ? `BD-rate 汇总（参照格式：${summary.referenceFormat}）`
      : 'BD-rate 汇总';
    box.append(title);
    if (summary.note) {
      const note = document.createElement('p');
      note.className = 'muted bdrate-note';
      note.textContent = summary.note;
      box.append(note);
    }
    box.append(buildBdrateTable(summary));
  } catch (err) {
    box.textContent = `BD-rate 汇总计算失败：${String(err)}`;
  }
}

/** 保存对话框默认文件名：轮名里的文件系统非法字符换成下划线 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : '评测轮';
}

/** 导出报告的默认文件名主干（票 18）：优先原图文件名主干（xxx.jpg → xxx），
 * 无原图或主干清洗后为空时回落轮名。 */
function exportBaseName(round: Round): string {
  if (round.referencePath) {
    const name = fileName(round.referencePath);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const cleaned = stem.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (cleaned.length > 0) return cleaned;
  }
  return sanitizeFileName(round.name);
}

/** 导出当前评测轮报告：save 对话框选路径 → round_export 写文件（后端返回中文错误） */
async function exportRound(kind: 'csv' | 'html'): Promise<void> {
  const session = activeRound();
  if (!session) return;
  const path = await save({
    title: kind === 'csv' ? '导出 CSV' : '导出 HTML 报告',
    defaultPath: `${exportBaseName(session.round)}.${kind}`,
    filters: [
      kind === 'csv'
        ? { name: 'CSV（逗号分隔）', extensions: ['csv'] }
        : { name: 'HTML 报告', extensions: ['html'] },
    ],
  });
  if (!path) return; // 用户取消
  try {
    const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    const written = await invoke<string>('round_export', {
      groupId: session.group.id,
      roundId: session.round.id,
      kind,
      path,
      generatedAt,
    });
    setStatus(`已导出：${written}`);
  } catch (err) {
    setStatus(`导出失败：${String(err)}`, true);
  }
}

async function boot(): Promise<void> {
  const versionEl = document.querySelector<HTMLSpanElement>('#core-version');
  try {
    const version = await invoke<string>('core_version');
    if (versionEl) versionEl.textContent = `核心库 v${version}`;
  } catch (err) {
    if (versionEl) versionEl.textContent = `IPC 调用失败: ${String(err)}`;
  }
  // T21 接线点：一站式目录（格式清单 + 默认质量档）改由核心库取点驱动，
  // 必须先于首次渲染拉取，并按目录重设默认全开的勾选状态
  try {
    await initOnestopCatalog();
    onestopSelection = defaultSelection();
  } catch (err) {
    setStatus(`加载编码阶梯目录失败: ${String(err)}`, true);
  }
  try {
    ws = await invoke<Workspace>('workspace_load');
    render();
    if (ws.groups.length > 0) setStatus('已恢复上次的工作区');
  } catch (err) {
    setStatus(`恢复工作区失败: ${String(err)}`, true);
    render(); // 用空状态渲染，保证界面可用
  }
}

// ---------- 渲染 ----------

function render(): void {
  renderTabs();
  renderRounds();
  renderContent();
}

function renderTabs(): void {
  $tabs.replaceChildren();
  if (!ws) return;
  for (const group of ws.groups) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (group.id === ws.activeGroupId ? ' active' : '');
    // T17：标签页悬浮提示带上类型（图片跑分组/视频跑分组）
    tab.title = `${group.name}（${groupKindLabel(group.kind)}，单击切换，双击重命名）`;

    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = group.name;
    label.addEventListener('click', () => {
      if (ws && ws.activeGroupId !== group.id) {
        void apply(() => invoke('group_activate', { id: group.id }));
      }
    });
    label.addEventListener('dblclick', () => startRename(label, group.name, (name) => {
      void apply(() => invoke('group_rename', { id: group.id, name }));
    }));

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭跑分组';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void apply(() => invoke('group_close', { id: group.id }));
    });

    tab.append(label, close);
    $tabs.append(tab);
  }
  $addGroup.disabled = false;
  $addRound.disabled = !activeGroup();
}

function renderRounds(): void {
  $rounds.replaceChildren();
  const group = activeGroup();
  $addRound.disabled = !group;
  // T17：评测轮栏标注当前跑分组类型
  $roundbarLabel.textContent = group ? `评测轮 · ${groupKindLabel(group.kind)}` : '评测轮';
  if (!ws || !group) return;

  if (group.rounds.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = '还没有评测轮，点右侧按钮新建';
    $rounds.append(hint);
    return;
  }
  for (const round of group.rounds) {
    const chip = document.createElement('div');
    chip.className = 'round' + (round.id === group.activeRoundId ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'round-name';
    label.textContent = round.name;
    label.title = `${round.name}（单击切换，双击改名）`;
    label.addEventListener('click', () => {
      if (group.activeRoundId !== round.id) {
        void apply(() => invoke('round_activate', { groupId: group.id, roundId: round.id }));
      }
    });
    label.addEventListener('dblclick', () => startRename(label, round.name, (name) => {
      void apply(() => invoke('round_rename', { groupId: group.id, roundId: round.id, name }));
    }));

    const del = document.createElement('button');
    del.className = 'round-delete';
    del.textContent = '×';
    del.title = '删除评测轮';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void apply(() => invoke('round_delete', { groupId: group.id, roundId: round.id }));
    });

    chip.append(label, del);
    $rounds.append(chip);
  }
}

function renderContent(): void {
  $content.replaceChildren();
  $content.classList.remove('filled');
  if (!ws || ws.groups.length === 0) {
    $content.textContent = '点上方「＋ 新建跑分组」开始一次评测。';
    return;
  }
  const session = activeRound();
  if (!session) {
    $content.textContent = '新建或选择一轮评测，开始对比查看与跑分。';
    return;
  }
  const { round } = session;
  // 排序状态跟随评测轮：切到另一轮就归零
  if (sortRoundId !== round.id) {
    sortRoundId = round.id;
    sortState = null;
  }

  $content.classList.add('filled');

  // T17：跑分组分类型——图片组只有图片流程（无视频导入），视频组只有视频导入与
  // 逐帧同步对比（无一站式与编码阶梯入口）。类型创建时已锁定，界面没有更改入口。
  if (session.group.kind === 'video') {
    renderVideoGroupContent(session);
  } else {
    renderImageGroupContent(session);
  }
}

/** T17：导出按钮（图片/视频组共用；exportable = 本轮有任何可导出的跑分内容）。 */
function buildExportButtons(exportable: boolean): HTMLButtonElement[] {
  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.className = 'add-btn export-btn';
  exportCsvBtn.textContent = '导出 CSV';
  exportCsvBtn.title = '把本轮指标表（含视频与 BD-rate 汇总）导出为 CSV 文件';
  exportCsvBtn.disabled = scoring || !exportable;
  exportCsvBtn.addEventListener('click', () => void exportRound('csv'));

  const exportHtmlBtn = document.createElement('button');
  exportHtmlBtn.className = 'add-btn export-btn';
  exportHtmlBtn.textContent = '导出 HTML';
  exportHtmlBtn.title = '把本轮结果生成为可直接分享的自包含 HTML 报告';
  exportHtmlBtn.disabled = scoring || !exportable;
  exportHtmlBtn.addEventListener('click', () => void exportRound('html'));
  return [exportCsvBtn, exportHtmlBtn];
}

/** 图片跑分组的内容区（T17）：外部导入 + 一站式 + 编码阶梯 + 对比查看器；
 * 不挂载视频评测区块（视频导入只在视频跑分组出现）。 */
function renderImageGroupContent(session: { group: Group; round: Round }): void {
  const { round } = session;
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const pickReferenceBtn = document.createElement('button');
  pickReferenceBtn.className = 'add-btn';
  pickReferenceBtn.textContent = round.referencePath ? '重选原图' : '选择原图';
  pickReferenceBtn.title = '从文件系统选一张原图作为画质与压缩的基准';
  pickReferenceBtn.disabled = scoring;
  pickReferenceBtn.addEventListener('click', () => void pickReference());

  const referenceLabel = document.createElement('span');
  referenceLabel.className = 'reference-label';
  referenceLabel.textContent = round.referencePath
    ? `原图：${fileName(round.referencePath)}`
    : '尚未选择原图';
  referenceLabel.title = round.referencePath ?? '';

  const addCandidatesBtn = document.createElement('button');
  addCandidatesBtn.className = 'add-btn';
  addCandidatesBtn.textContent = '添加跑分图';
  addCandidatesBtn.title = '多选已用其他工具压好的图片';
  addCandidatesBtn.disabled = scoring;
  addCandidatesBtn.addEventListener('click', () => void pickCandidates());

  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'add-btn score-btn';
  scoreBtn.textContent = scoring ? '跑分中…' : '开始跑分';
  scoreBtn.title =
    !round.referencePath || round.candidates.length === 0
      ? '需要先选原图并至少添加一张跑分图'
      : '逐张计算各跑分图相对原图的指标';
  scoreBtn.disabled = scoring || !round.referencePath || round.candidates.length === 0;
  scoreBtn.addEventListener('click', () => void startScoring());

  // T11 接线点：一站式跑分（完整编码阶梯）——勾选项逐个生成并跑分，进度亮在状态栏
  const ladderCount = buildLadder(onestopSelection).length;
  const onestopBtn = document.createElement('button');
  onestopBtn.className = 'add-btn onestop-btn';
  onestopBtn.textContent = scoring ? '一站式跑分中…' : '一站式跑分';
  onestopBtn.title =
    !round.referencePath
      ? '需要先选择原图'
      : ladderCount === 0
        ? '请先在下方勾选至少一个格式、质量档或无损组'
        : `按下方勾选自动生成 ${ladderCount} 份跑分图并逐张跑分（编码器首次使用需联网下载；AVIF/JXL 编码较慢）`;
  onestopBtn.disabled = scoring || !round.referencePath || ladderCount === 0;
  onestopBtn.addEventListener('click', () => void runOnestop());

  // T13 接线点：导出评测轮报告（CSV / 自包含 HTML），无任何跑分内容时置灰
  const exportable =
    round.candidates.length > 0 || (round.videoCandidates?.length ?? 0) > 0;
  toolbar.append(
    pickReferenceBtn,
    referenceLabel,
    addCandidatesBtn,
    scoreBtn,
    onestopBtn,
    ...buildExportButtons(exportable),
  );
  $content.append(toolbar);
  // T11 接线点：格式/质量档/无损组勾选区（有原图才可触发，故仅在已选原图时展示）
  if (round.referencePath) {
    $content.append(buildOnestopOptions());
  }

  if (round.candidates.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'content-placeholder';
    hint.textContent = round.referencePath
      ? '原图已就位。点「添加跑分图」多选已压缩的图片，再「开始跑分」。'
      : '先「选择原图」作为基准，再添加跑分图。';
    $content.append(hint);
  } else {
    // 对比查看器（T07）：选好原图与跑分图后即可用，跑分与否不影响查看
    if (round.referencePath) {
      const viewerBox = document.createElement('div');
      $content.append(viewerBox);
      mountViewer(viewerBox, {
        roundId: round.id,
        referencePath: round.referencePath,
        // T11 接线点：AVIF/JXL 跑分图换成查看器代片路径显示（真实路径仍用于跑分与结果表）
        candidates: round.candidates.map((c) => ({ path: viewerPath(c.path) })),
      });
    }

    $content.append(buildResultTable(round.candidates));

    // T13 接线点：BD-rate 汇总区（与导出报告同一数据源；异步填充，不触发整页重渲染）
    const bdrateBox = document.createElement('div');
    bdrateBox.className = 'bdrate-summary';
    bdrateBox.textContent = 'BD-rate 汇总计算中…';
    $content.append(bdrateBox);
    void fillBdrateSummary(bdrateBox, session.group.id, round.id);
  }
}

/** 视频跑分组的内容区（T17）：只有视频导入与逐帧同步对比；选择原图/跑分图、
 * 一站式与编码阶梯入口一概不出现。旧工作区迁移带来的遗留图片评测内容只读展示
 * （结果表 + BD-rate 汇总），数据保留但不能新增图片内容（后端同样拒绝）。 */
function renderVideoGroupContent(session: { group: Group; round: Round }): void {
  const { round } = session;

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const exportable = round.candidates.length > 0 || (round.videoCandidates?.length ?? 0) > 0;
  toolbar.append(...buildExportButtons(exportable));
  $content.append(toolbar);

  // 遗留图片评测内容（旧工作区混用时期产生）：只读结果表，不提供图片操作入口
  if (round.candidates.length > 0) {
    $content.append(buildResultTable(round.candidates));
    const bdrateBox = document.createElement('div');
    bdrateBox.className = 'bdrate-summary';
    bdrateBox.textContent = 'BD-rate 汇总计算中…';
    $content.append(bdrateBox);
    void fillBdrateSummary(bdrateBox, session.group.id, round.id);
  }

  // 视频评测区块：选原视频 / 添加跑分视频 / 开始视频跑分 / 逐帧同步对比
  const videoBlock = document.createElement('div');
  $content.append(videoBlock);
  mountVideoBlock(videoBlock, {
    groupId: session.group.id,
    round: {
      id: round.id,
      videoReferencePath: round.videoReferencePath ?? null,
      videoCandidates: round.videoCandidates ?? [],
    },
    scoring,
    scoringPath,
    apply,
    scoreOne: scoreVideoOne,
    setScoring: (active, path) => {
      scoring = active;
      scoringPath = path;
      render();
    },
    setStatus,
    rerender: () => render(),
  });
}

// ---------- 结果表 ----------

/** 指标列由数据驱动：所有行出现过的指标键都会成为一列（T04 新增指标自动多列）。 */
function metricKeys(candidates: CandidateImage[]): string[] {
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.metrics) continue;
    for (const key of Object.keys(candidate.metrics)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// fileName 移到 src/util.ts（查看器模块也要用）

/** 排序取值：缺指标（未跑分/失败）的行返回 null，排序时沉底。 */
function sortableValue(candidate: CandidateImage, key: string): number | string | null {
  if (key === 'name') return fileName(candidate.path);
  if (key === 'fileSize') return candidate.fileSize;
  if (key === 'sizeRatio') return candidate.sizeRatio;
  if (key === 'encodingParams') return candidate.encodingParams ?? null;
  const metric = candidate.metrics?.[key];
  if (metric === undefined) return null;
  return metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
}

function firstClickDir(key: string): 1 | -1 {
  // 文件大小越小越好、名称/编码参数自然升序；指标与体积比默认降序（大的在前）
  return key === 'fileSize' || key === 'name' || key === 'encodingParams' ? 1 : -1;
}

function buildResultTable(candidates: CandidateImage[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'result-table';

  // 列：排名 | 跑分图 | 文件大小 | 体积比 | 编码参数 | 指标列… | 状态
  const columns: { key: string; label: string; sortable: boolean }[] = [
    { key: 'name', label: '跑分图', sortable: true },
    { key: 'fileSize', label: '文件大小', sortable: true },
    { key: 'sizeRatio', label: '体积比', sortable: true },
    { key: 'encodingParams', label: '编码参数', sortable: true },
    ...metricKeys(candidates).map((key) => ({ key, label: key, sortable: true })),
    { key: 'status', label: '状态', sortable: false },
  ];

  const rows = [...candidates];
  if (sortState) {
    const { key, dir } = sortState;
    rows.sort((a, b) => {
      const va = sortableValue(a, key);
      const vb = sortableValue(b, key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // 缺值（未跑分/失败）沉底
      if (vb === null) return -1;
      if (typeof va === 'string' && typeof vb === 'string') {
        return va.localeCompare(vb, 'zh-CN') * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
  }

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const rankTh = document.createElement('th');
  rankTh.textContent = '排名';
  headRow.append(rankTh);
  for (const column of columns) {
    const th = document.createElement('th');
    if (!column.sortable) {
      th.textContent = column.label;
      headRow.append(th);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'sort-btn';
    btn.title = '点击排序（再点反向）';
    const arrow = sortState?.key === column.key ? (sortState.dir === 1 ? ' ↑' : ' ↓') : '';
    btn.textContent = column.label + arrow;
    btn.addEventListener('click', () => {
      if (scoring) return; // 跑分中表在逐张刷新，不允许改排序
      if (sortState?.key === column.key) {
        sortState.dir = (sortState.dir * -1) as 1 | -1;
      } else {
        sortState = { key: column.key, dir: firstClickDir(column.key) };
      }
      render();
    });
    th.append(btn);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  rows.forEach((candidate, index) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(index + 1);

    const name = document.createElement('td');
    name.className = 'cell-name';
    name.textContent = fileName(candidate.path);
    name.title = candidate.path;

    const fileSize = document.createElement('td');
    fileSize.textContent = formatSize(candidate.fileSize);

    const ratio = document.createElement('td');
    ratio.textContent =
      candidate.sizeRatio === null ? '—' : formatRatio(candidate.sizeRatio);

    // 编码参数列（C）：一站式写入的参数文本，外部导入为空显示 —
    const encodingParams = document.createElement('td');
    encodingParams.textContent = candidate.encodingParams || '—';

    const metricCells: HTMLTableCellElement[] = [];
    for (const key of metricKeys(candidates)) {
      const td = document.createElement('td');
      const metric = candidate.metrics?.[key];
      td.textContent = metric === undefined ? '—' : formatMetric(metric);
      td.classList.add('cell-metric');
      metricCells.push(td);
    }

    const status = document.createElement('td');
    status.className = 'cell-status';
    if (candidate.error !== null) {
      status.textContent = `失败：${candidate.error}`;
      status.classList.add('status-fail');
      status.title = candidate.error;
    } else if (scoringPath === candidate.path) {
      status.textContent = '跑分中…';
      status.classList.add('status-running');
    } else if (candidate.metrics === null) {
      status.textContent = '待跑分';
      status.classList.add('status-pending');
    } else {
      status.textContent = '完成';
    }

    tr.append(rank, name, fileSize, ratio, encodingParams, ...metricCells, status);
    body.append(tr);
  });
  table.append(body);
  return table;
}

// ---------- 格式化 ----------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRatio(ratio: number): string {
  // 常见情形（压缩后变小）用百分比读起来直观；变大则用倍数
  return ratio < 1 ? `${(ratio * 100).toFixed(1)}%` : `×${ratio.toFixed(2)}`;
}

function formatMetric(metric: MetricValue): string {
  if (metric === 'inf') return '∞';
  // ≥10 的指标（PSNR 等 dB 值）两位小数，小值（SSIM 等）四位
  return Math.abs(metric) >= 10 ? metric.toFixed(2) : metric.toFixed(4);
}

// ---------- 行内重命名 ----------

// 把 label 换成输入框：Enter / 失焦提交，Esc 取消。空名提交会得到后端「名称不能为空」。
function startRename(
  label: HTMLElement,
  current: string,
  commit: (name: string) => void,
): void {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = current;
  input.maxLength = 60;
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (submit: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    render(); // 先还原界面；提交成功后 apply 会再渲染一次
    if (submit && name !== current) commit(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

$addGroup.addEventListener('click', createGroup);
$addRound.addEventListener('click', createRound);

void boot();
