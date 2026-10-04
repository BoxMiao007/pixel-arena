// 跑分组标签页与评测轮管理（T05）+ 评测轮内容（选图 / 跑分 / 结果表，T06）。
// 前端不持有任何持久化逻辑：每次改动都经 IPC 命令落到核心库并立即写盘，
// 命令返回最新工作区整份状态，前端照着重渲染即可，不自己算状态。

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { mountViewer } from './viewer';
import { mountVideoBlock, type VideoCandidate } from './video'; // T14 接线点：视频评测区块
import { fileName } from './util';
import './style.css';

// 与核心库 workspace.rs 的 serde 输出（camelCase）一一对应

// 指标值：有限数值，或 "inf" 哨兵（两图完全一致时 PSNR 的情形）
type MetricValue = number | 'inf';

interface CandidateImage {
  path: string;
  fileSize: number;
  sizeRatio: number | null;
  metrics: Record<string, MetricValue> | null;
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

interface Group {
  id: string;
  name: string;
  rounds: Round[];
  activeRoundId: string | null;
}

interface Workspace {
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

const $tabs = document.querySelector<HTMLDivElement>('#tabs')!;
const $rounds = document.querySelector<HTMLDivElement>('#rounds')!;
const $content = document.querySelector<HTMLElement>('#content')!;
const $status = document.querySelector<HTMLSpanElement>('#status')!;
const $addGroup = document.querySelector<HTMLButtonElement>('#add-group')!;
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
  void apply(() => invoke('group_create', { name }));
}

function createRound(): void {
  const group = activeGroup();
  if (!group) return;
  const name = `评测轮 ${group.rounds.length + 1}`;
  void apply(() => invoke('round_create', { groupId: group.id, name }));
}

// ---------- 选图与跑分（T06） ----------

// 核心库按 image 0.25 开启的 feature 只支持这三种格式
const IMAGE_FILTER = { name: '图片（PNG / JPEG / WebP）', extensions: ['png', 'jpg', 'jpeg', 'webp'] };

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
 * 触发跑分：前端逐张调用跑分命令，每张回来整份工作区刷新一次——
 * 进度（状态栏「跑分中 i/N」+ 行内「跑分中…」）与单张失败（行内标「失败」）天然可见。
 * 跑分中按钮置灰防重复触发；命令本身出错（如评测轮被删）时中止整个循环。
 */
async function startScoring(): Promise<void> {
  const session = activeRound();
  if (!session || scoring || !session.round.referencePath) return;
  if (session.round.candidates.length === 0) return;

  // 队列快照：跑分期间工作区每张都在被替换，按选入顺序逐张跑
  const queue = session.round.candidates.map((c) => c.path);
  scoring = true;
  scoringPath = null;
  render();

  try {
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
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  } finally {
    scoring = false;
    scoringPath = null;
    render();
  }
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

async function boot(): Promise<void> {
  const versionEl = document.querySelector<HTMLSpanElement>('#core-version');
  try {
    const version = await invoke<string>('core_version');
    if (versionEl) versionEl.textContent = `核心库 v${version}`;
  } catch (err) {
    if (versionEl) versionEl.textContent = `IPC 调用失败: ${String(err)}`;
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
    tab.title = `${group.name}（单击切换，双击重命名）`;

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

  toolbar.append(pickReferenceBtn, referenceLabel, addCandidatesBtn, scoreBtn);
  $content.append(toolbar);

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
        candidates: round.candidates.map((c) => ({ path: c.path })),
      });
    }

    $content.append(buildResultTable(round.candidates));
  }

  // T14 接线点：视频评测区块（选原视频/跑分视频/VMAF-PSNR-SSIM），与图片流程互不干扰
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
  const metric = candidate.metrics?.[key];
  if (metric === undefined) return null;
  return metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
}

function firstClickDir(key: string): 1 | -1 {
  // 文件大小越小越好、名称自然升序；指标与体积比默认降序（大的在前）
  return key === 'fileSize' || key === 'name' ? 1 : -1;
}

function buildResultTable(candidates: CandidateImage[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'result-table';

  // 列：排名 | 跑分图 | 文件大小 | 体积比 | 指标列… | 状态
  const columns: { key: string; label: string; sortable: boolean }[] = [
    { key: 'name', label: '跑分图', sortable: true },
    { key: 'fileSize', label: '文件大小', sortable: true },
    { key: 'sizeRatio', label: '体积比', sortable: true },
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

    tr.append(rank, name, fileSize, ratio, ...metricCells, status);
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
