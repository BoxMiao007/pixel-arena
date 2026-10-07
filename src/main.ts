// 跑分组标签页与评测轮管理（T05）+ 评测轮内容（选图 / 跑分 / 结果表，T06）。
// 前端不持有任何持久化逻辑：每次改动都经 IPC 命令落到核心库并立即写盘，
// 命令返回最新工作区整份状态，前端照着重渲染即可，不自己算状态。

import { invoke, Channel } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { mountViewer } from './viewer';
import { mountVideoBlock, type VideoCandidate } from './video'; // T14 接线点：视频评测区块
import { fileName, truncateFileName } from './util';
import { buildPill, buildPillList } from './pills'; // T18 接线点：已选文件胶囊（T22 复用同一套）
// T23 接线点：设置中心（面板 UI + 数据形状 + 主题应用）
import { applyTheme } from './theme';
import {
  exportDefaultPath,
  openDefaultPath,
  nextRecentDir,
  type SettingsData,
} from './settings';
import { openSettingsPanel } from './settings-ui';
// T29-3 接线点：高级创建（多编码器 + 独立参数 + 命令行预览；面板与纯逻辑在
// src/advanced-ui.ts / src/advanced.ts）
import { openAdvancedPanel, type AdvancedProductDto } from './advanced-ui';
// T11/T22 接线点：一站式跑分升级为两种模式（质量优先拉杆 / 大小优先逼近），
// 编码格式用胶囊多选；取点全部走核心库（onestop_quality_ladder / onestop_size_search），
// 清单与生成循环在 src/onestop.ts，本文件只做模式 UI、触发与进度显示
import {
  runOnestop as runOnestopLadder,
  fetchQualityLadder,
  filterLadder,
  losslessLadder,
  searchSizeFormat,
  sizeOutcomeLadder,
  defaultSelection,
  initOnestopCatalog,
  toggleFormat,
  LOSSY_FORMATS,
  LOSSLESS_FORMATS,
  type LadderItem,
  type OnestopMode,
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
  /** 备注（US22 大小优先不可达标注）：随评测轮持久化，重启后仍显示；其余模式为 null。 */
  note?: string | null;
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

// T23 接线点：设置（boot 时加载；所有改动经 saveSettings 整体保存到设置文件）
let settings: SettingsData | null = null;

/** 设置整体保存：后端做空串归一与存在性校验，返回归一后的设置。 */
async function saveSettings(next: SettingsData): Promise<SettingsData> {
  settings = await invoke<SettingsData>('settings_save', { settings: next });
  return settings;
}

/** 打开对话框的默认位置：记录状态开启时恢复最近目录（T23）。 */
function defaultOpenPath(): string | undefined {
  return settings ? openDefaultPath(settings) : undefined;
}

/** 记录最近使用目录（T23）：用户成功选了文件后调用。恢复与写入共用记录状态
 * 门控（US27：关 = 不恢复也不写）；保存失败不炸主流程，console.warn 留上下文可定位。 */
function notePickedPath(path: string): void {
  if (!settings) return;
  const next = nextRecentDir(settings, path);
  if (!next) return;
  void saveSettings(next).catch((err) => {
    console.warn('记录最近使用的目录失败（不影响主流程）:', err);
  });
}

// ---------- 跑分与界面状态（按评测轮键控：切走保留、切回还原；不持久化，重启归零） ----------

// 跑分进行中：三个操作按钮置灰，整轮完成后整份工作区刷新
// （T25：scoring/scoringPaths 仍是全局忙标志——同一时刻只有一条跑分会话，不按轮键控）
let scoring = false;
// 本轮正在跑分的跑分图/视频集合（T24 并行：多张同时在算，命中即在行内显示「跑分中…」）
let scoringPaths: ReadonlySet<string> = new Set();

/** 结果表排序：null 按选入顺序；dir=1 升序 / -1 降序 */
type SortState = { key: string; dir: 1 | -1 };

/** T25 第 2 项：排序按评测轮保存（此前换轮归零）；键是评测轮 id */
const sortStates = new Map<string, SortState | null>();
/** 当前渲染轮的排序状态（renderContent 时从 sortStates 取出，点表头后写回） */
let sortState: SortState | null = null;

/** 一站式界面状态（模式/基准/目标大小/单位/格式与无损组勾选），T25 起每评测轮一份 */
interface OnestopUiState {
  mode: OnestopMode;
  /** 质量优先的拉杆基准 0–100 */
  baseline: number;
  /** 大小优先的目标字节数（KB/MB 只是显示口径，真值一律是字节） */
  targetBytes: number;
  unit: 'KB' | 'MB';
  selection: OnestopSelection;
}

/** 一站式默认基准（拉杆初始值；启动时预取该基准的质量阶梯） */
const DEFAULT_ONESTOP_BASELINE = 75;
const DEFAULT_SIZE_TARGET_BYTES = 200 * 1024;

/** 新评测轮的一站式默认值 */
function defaultOnestopUi(): OnestopUiState {
  return {
    mode: 'quality',
    baseline: DEFAULT_ONESTOP_BASELINE,
    targetBytes: DEFAULT_SIZE_TARGET_BYTES,
    unit: 'KB',
    selection: defaultSelection(),
  };
}

/** T25 第 2 项：一站式控件状态按评测轮保存（此前模块级共享，切标签会串扰） */
const onestopStates = new Map<string, OnestopUiState>();

/** 取该评测轮的一站式状态；首次用到时按默认值创建 */
function onestopStateFor(roundId: string): OnestopUiState {
  let st = onestopStates.get(roundId);
  if (!st) {
    st = defaultOnestopUi();
    onestopStates.set(roundId, st);
  }
  return st;
}

// 质量阶梯缓存（键 = 拉杆基准）：取点在核心库，启动预取 75，拉杆 change 时按需补拉，
// 供阶梯预览与「一站式跑分」按钮计数使用。与具体评测轮无关，全局共享。
const qualityLadderCache = new Map<number, LadderItem[]>();

/** T25 第 2 项：内容区滚动位置按评测轮记录（离开时记、渲染后恢复；首见轮为 0） */
const contentScrollByRound = new Map<string, number>();
/** 当前内容区渲染的评测轮 id（renderContent 开头据此记录离开前的滚动位置） */
let contentRoundId: string | null = null;
/** 当前渲染轮的滚动目标（异步内容填充完再套一次，防高度未就绪被钳制） */
let contentScrollTarget = 0;

/** 拉取并缓存指定基准的质量阶梯（失败上抛交调用方提示）。 */
async function refreshQualityLadder(baseline: number): Promise<LadderItem[]> {
  const ladder = await fetchQualityLadder(baseline);
  qualityLadderCache.set(baseline, ladder);
  return ladder;
}

const $tabs = document.querySelector<HTMLDivElement>('#tabs')!;
const $rounds = document.querySelector<HTMLDivElement>('#rounds')!;
const $content = document.querySelector<HTMLElement>('#content')!;
const $status = document.querySelector<HTMLSpanElement>('#status')!;
const $addGroup = document.querySelector<HTMLButtonElement>('#add-group')!;
// fb3（issue #28）：单一「新建跑分组」入口的类型下拉菜单（点开选类型即直接建组）
const $newGroupMenu = document.querySelector<HTMLDivElement>('#new-group-menu')!;
const $roundbarLabel = document.querySelector<HTMLSpanElement>('#roundbar-label')!;
const $addRound = document.querySelector<HTMLButtonElement>('#add-round')!;
// T23 接线点：标题栏「设置」按钮
const $openSettings = document.querySelector<HTMLButtonElement>('#open-settings')!;

function activeGroup(): Group | null {
  if (!ws || !ws.activeGroupId) return null;
  return ws.groups.find((g) => g.id === ws!.activeGroupId) ?? null;
}

function setStatus(text: string, isError = false, title: string = text): void {
  $status.textContent = text;
  // T18：状态栏放截断后的文件名时，悬浮仍能看到完整内容
  $status.title = title;
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

function createGroup(kind: GroupKind): void {
  const name = `跑分组 ${ws ? ws.groups.length + 1 : 1}`;
  // fb3（issue #28）：类型来自下拉菜单点选的项（image / video），
  // 后端创建后不可更改，且自动附带一个同类型评测轮（核心库 create_group_with_round）
  void apply(() => invoke('group_create', { name, kind }));
}

// fb3（issue #28）：「新建跑分组」下拉菜单的开合与点选。
// 菜单是 DOM 里的真按钮（role=menuitem），选中即建组、无中间确认；
// 点外部或 Esc 关闭，不建组。
function closeGroupMenu(): void {
  $newGroupMenu.hidden = true;
  $addGroup.setAttribute('aria-expanded', 'false');
}

function toggleGroupMenu(): void {
  const open = $newGroupMenu.hidden;
  $newGroupMenu.hidden = !open;
  $addGroup.setAttribute('aria-expanded', String(open));
}

$addGroup.addEventListener('click', (e) => {
  e.stopPropagation(); // 别触发下面的「点外部关闭」监听
  toggleGroupMenu();
});

for (const item of $newGroupMenu.querySelectorAll<HTMLButtonElement>('.group-menu-item')) {
  item.addEventListener('click', () => {
    closeGroupMenu();
    createGroup(item.dataset.kind === 'video' ? 'video' : 'image');
  });
}

document.addEventListener('click', (e) => {
  if (!$newGroupMenu.hidden && !$newGroupMenu.contains(e.target as Node)) closeGroupMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$newGroupMenu.hidden) closeGroupMenu();
});

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
  const selected = await open({
    title: '选择原图',
    multiple: false,
    filters: [IMAGE_FILTER],
    defaultPath: defaultOpenPath(), // T23：最近目录（记录状态开启时）
  });
  if (typeof selected !== 'string') return; // 用户取消
  notePickedPath(selected);
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
    defaultPath: defaultOpenPath(), // T23：最近目录（记录状态开启时）
  });
  if (selected === null) return; // 用户取消
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return;
  notePickedPath(paths[0]);
  await apply(() =>
    invoke('round_add_candidates', { groupId: session.group.id, roundId: session.round.id, paths }),
  );
}

/** T18：从评测轮移除一张跑分图（胶囊 ×）。经 IPC 落库后整页重渲染，
 * 结果表与对比查看器随之只少这一行。 */
function removeCandidate(candidatePath: string): void {
  const session = activeRound();
  if (!session || scoring) return;
  void apply(() =>
    invoke('round_remove_candidate', {
      groupId: session.group.id,
      roundId: session.round.id,
      candidatePath,
    }),
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
  scoringPaths = new Set();
  render();

  try {
    await scoreAllCandidates();
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  } finally {
    scoring = false;
    scoringPaths = new Set();
    render();
  }
}

/**
 * 整轮并行跑分（T24）：一次 IPC 把整轮跑分图全部提交，后端按设置的并发度
 * （默认一半逻辑核）同时计算，进度经 Channel 以 N/M 推回状态栏，跑分期间
 * 界面不阻塞。行内「跑分中…」按本轮全部待跑行显示，单张失败照旧行内标「失败」。
 * 忙标志（scoring）由调用方管理：手动「开始跑分」与一站式跑分（runOnestop）共用本函数。
 */
async function scoreAllCandidates(): Promise<void> {
  const session = activeRound();
  if (!session || !session.round.referencePath) return;
  if (session.round.candidates.length === 0) return;

  // 本轮待跑清单快照：并行期间行内状态按它显示「跑分中…」
  scoringPaths = new Set(session.round.candidates.map((c) => c.path));
  const total = scoringPaths.size;

  const channel = new Channel<{ completed: number; total: number }>();
  channel.onmessage = (progress) => {
    setStatus(`跑分中 ${progress.completed}/${progress.total}`, false);
  };
  setStatus(`跑分中 0/${total}`, false);
  render();

  ws = await invoke('round_score_candidates', {
    groupId: session.group.id,
    roundId: session.round.id,
    onProgress: channel,
  });
  render();
  markSaved();
  setStatus(`跑分完成，共 ${total} 张`);
}

// ---------- 一站式跑分（T11 完整编码阶梯，清单实现在 src/onestop.ts） ----------

/**
 * 触发一站式跑分（T22 两种模式）：质量优先 = 拉杆基准经核心库取点展开清单；
 * 大小优先 = 每个勾选格式先逼近搜索（探测编码在后端执行），命中点 + 邻近补点入
 * 清单，不可达标注挂到产物路径（结果表备注列）。产物自动纳入本轮 → 复用逐张跑分
 * 循环出分。期间沿用 scoring 忙标志置灰全部操作按钮。某项失败不回滚已成功的项。
 */
async function runOnestop(): Promise<void> {
  const session = activeRound();
  if (!session || scoring || !session.round.referencePath) return;
  // T25：模式/基准/目标/勾选取本轮自己的状态并快照（跑分期间即使界面重渲染也不中途变卦）
  const ui = onestopStateFor(session.round.id);

  scoring = true;
  scoringPaths = new Set();
  render();

  try {
    let ladder: LadderItem[];
    const notesByFormat = new Map<string, string>();
    if (ui.mode === 'quality') {
      // 质量优先：核心库 quality_ladder 取点（缓存优先），按格式勾选过滤
      const full =
        qualityLadderCache.get(ui.baseline) ?? (await refreshQualityLadder(ui.baseline));
      ladder = filterLadder(full, ui.selection);
    } else {
      if (!Number.isFinite(ui.targetBytes) || ui.targetBytes < 1) {
        setStatus('目标大小无效：请输入大于 0 的数值', true);
        return;
      }
      // 大小优先：每格式逐次逼近搜索（每次调用天然形成进度）
      ladder = [];
      const selected = LOSSY_FORMATS.filter((f) =>
        ui.selection.lossyFormats.includes(f.format),
      );
      for (const { format, label } of selected) {
        setStatus(`正在搜索 ${label} 逼近目标大小…`);
        render();
        const outcome = await searchSizeFormat({
          groupId: session.group.id,
          roundId: session.round.id,
          referencePath: session.round.referencePath,
          format,
          targetBytes: ui.targetBytes,
        });
        ladder.push(...sizeOutcomeLadder(outcome));
        if (outcome.note) notesByFormat.set(format, outcome.note);
      }
      // 无损对照组大小固定、不参与搜索，按勾选原样补入（US24）
      ladder.push(...losslessLadder(ui.selection));
    }
    if (ladder.length === 0) {
      setStatus('请先选择至少一个编码格式或无损组', true);
      return;
    }

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
    // 大小优先：不可达标注按产物路径经 IPC 持久化进评测轮（US22，重启后
    // 结果表与导出仍可读；与核心库 annotation_note 同源）
    for (const product of result.products) {
      const note = notesByFormat.get(product.format);
      if (note) {
        await apply(() =>
          invoke('round_set_candidate_note', {
            groupId: session.group.id,
            roundId: session.round.id,
            candidatePath: product.path,
            note,
          }),
        );
      }
    }
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
    scoringPaths = new Set();
    render();
  }
}

/**
 * T22 接线点：一站式操作区（模式二选一 + 参数行 + 格式胶囊 + 无损组胶囊）。
 * ui 是该评测轮的一站式状态（T25：按轮持有，切标签不串扰、切走保留），控件读写它、不自己存状态。
 */
function buildOnestopControls(ui: OnestopUiState): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'onestop-controls';

  // 模式二选一：质量优先 / 大小优先，互斥生效（分段按钮，active 高亮）
  const modeSwitch = document.createElement('div');
  modeSwitch.className = 'onestop-modes';
  modeSwitch.role = 'group';
  modeSwitch.ariaLabel = '一站式模式';
  const modes = [
    ['quality', '质量优先', '统一拉杆定基准，自动在基准附近取多个质量点（保 BD-rate 曲线）'],
    ['size', '大小优先', '输入期望文件大小，每个格式自动逼近；不可达时取最接近点并标注'],
  ] as const;
  for (const [mode, label, title] of modes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.disabled = scoring;
    btn.classList.toggle('active', ui.mode === mode);
    btn.ariaPressed = ui.mode === mode ? 'true' : 'false';
    btn.addEventListener('click', () => {
      if (ui.mode !== mode) {
        ui.mode = mode;
        render();
      }
    });
    modeSwitch.append(btn);
  }
  box.append(modeSwitch);

  if (ui.mode === 'quality') {
    const row = document.createElement('div');
    row.className = 'onestop-param-row';

    const label = document.createElement('span');
    label.className = 'onestop-param-label';
    label.textContent = '基准质量';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'onestop-slider';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(ui.baseline);
    slider.disabled = scoring;
    slider.title = '统一基准质量（0–100），自动映射到各格式自身质量参数';

    const value = document.createElement('span');
    value.className = 'onestop-param-value';
    value.textContent = String(ui.baseline);

    // 拖动中只更新数值显示；松手（change）才取点重渲染，避免拖动期间频繁 IPC
    slider.addEventListener('input', () => {
      value.textContent = slider.value;
    });
    slider.addEventListener('change', () => {
      ui.baseline = Number(slider.value);
      void refreshQualityLadder(ui.baseline)
        .then(() => render())
        .catch((err) => setStatus(`取点失败: ${String(err)}`, true));
    });

    row.append(label, slider, value);
    box.append(row);

    const cached = qualityLadderCache.get(ui.baseline);
    const preview = document.createElement('span');
    preview.className = 'muted onestop-preview';
    preview.textContent = cached
      ? `按基准 ${ui.baseline} 自动取点：共 ${filterLadder(cached, ui.selection).length} 项（每格式 ≥3 点，含无损对照组）`
      : '正在计算取点…';
    box.append(preview);
  } else {
    const row = document.createElement('div');
    row.className = 'onestop-param-row';

    const label = document.createElement('span');
    label.className = 'onestop-param-label';
    label.textContent = '目标大小';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'onestop-size-input';
    input.min = '0';
    input.step = 'any';
    input.disabled = scoring;
    input.title = '期望的跑分图文件大小；每格式自动逼近，不可达时取最接近点并标注';
    // 显示口径：字节为唯一真值，单位切换只换显示数值，传后端一律是字节
    const unitBytes = ui.unit === 'KB' ? 1024 : 1024 * 1024;
    const displayValue = ui.targetBytes / unitBytes;
    input.value = Number.isInteger(displayValue) ? String(displayValue) : displayValue.toFixed(2);
    input.addEventListener('change', () => {
      const bytes = Math.round(Number(input.value) * unitBytes);
      if (!Number.isFinite(bytes) || bytes < 1) {
        setStatus('目标大小无效：请输入大于 0 的数值', true);
      } else {
        ui.targetBytes = bytes;
      }
      render(); // 无效输入回显原值；有效输入同步预览文案
    });

    const unit = document.createElement('select');
    unit.className = 'onestop-size-unit';
    unit.disabled = scoring;
    unit.title = '大小单位（默认 KB；切换只改显示口径，同一目标大小不变）';
    for (const unitName of ['KB', 'MB'] as const) {
      const opt = document.createElement('option');
      opt.value = unitName;
      opt.textContent = unitName;
      unit.append(opt);
    }
    unit.value = ui.unit;
    unit.addEventListener('change', () => {
      ui.unit = unit.value as 'KB' | 'MB';
      render();
    });

    row.append(label, input, unit);
    box.append(row);

    const hint = document.createElement('span');
    hint.className = 'muted onestop-preview';
    hint.textContent = `每个格式自动逼近目标并补邻近点（保 BD-rate）；不可达时取最接近点并标注`;
    box.append(hint);
  }

  // 格式 + 无损组胶囊（fb3/issue #28 第 3、4 项）：合并到同一行 .pill-list——
  // flex wrap 自动「放得下一行、放不下才换行」；有损格式点击切换选中（原行为）；
  // 无损组不再有 × 移除，点胶囊本体即可切换选中/取消（选中态 pill-on 高亮）。
  const formatList = buildPillList(
    LOSSY_FORMATS.map((f) => {
      const selected = ui.selection.lossyFormats.includes(f.format);
      return {
        label: f.label,
        title: selected ? `点击移除 ${f.label}` : `点击选择 ${f.label}`,
        onClick: () => {
          ui.selection.lossyFormats = toggleFormat(
            ui.selection.lossyFormats,
            f.format,
          );
          render();
        },
        disabled: scoring,
        extraClass: selected ? 'pill-on' : undefined,
      };
    }),
    '格式：',
    '一站式格式与无损组选择',
  );
  // 无损组接在同一行里：第二个前置灰字 + 无损胶囊（点击本体切换，无 ×）
  const losslessLead = document.createElement('span');
  losslessLead.className = 'pill-lead muted pill-lead-gap';
  losslessLead.textContent = '无损组：';
  formatList.append(losslessLead);
  for (const f of LOSSLESS_FORMATS) {
    const selected = ui.selection.losslessFormats.includes(f.format);
    formatList.append(
      buildPill({
        label: f.label,
        title: selected ? `点击取消 ${f.label}（无损对照组）` : `点击选择 ${f.label}（无损对照组）`,
        onClick: () => {
          ui.selection.losslessFormats = toggleFormat(
            ui.selection.losslessFormats,
            f.format,
          );
          render();
        },
        disabled: scoring,
        extraClass: selected ? 'pill-on' : undefined,
      }),
    );
  }
  box.append(formatList);

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
 * T25：汇总比「计算中…」占位高，填充完再套一次本轮的滚动目标——否则渲染时高度还没长出来，
 * 恢复滚动位置会被浏览器钳到较小值（切标签回来滚动位置对不上）。
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
    if (box.isConnected && contentRoundId === roundId) {
      $content.scrollTop = contentScrollTarget;
    }
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
    // T23：设置过默认导出目录则定位到该目录，否则用纯文件名
    defaultPath: exportDefaultPath(settings?.defaultExportDir, `${exportBaseName(session.round)}.${kind}`),
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
  // T23：先加载设置并应用主题（工作区渲染前，避免界面闪一次旧主题）
  try {
    settings = await invoke<SettingsData>('settings_load');
    applyTheme(settings.theme);
    // 跟随系统：系统深浅变化时若正处于「跟随系统」，即时重解析并重渲染画布
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (settings?.theme === 'system') {
        applyTheme('system');
        render();
      }
    });
  } catch (err) {
    setStatus(`加载设置失败: ${String(err)}`, true);
  }
  // T21 接线点：一站式目录（格式清单）改由核心库驱动，必须先于首次渲染拉取；
  // T22：随后预取默认基准 75 的质量阶梯（拉杆预览与按钮计数用）。
  // T25：勾选状态改为「每评测轮一份」，首轮首次渲染时按默认全选创建，无需在启动时预置。
  try {
    await initOnestopCatalog();
    await refreshQualityLadder(DEFAULT_ONESTOP_BASELINE);
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
  // T25 第 2 项：先把离开前的内容区滚动位置记到上一轮名下，渲染完再恢复本轮的
  if (contentRoundId) contentScrollByRound.set(contentRoundId, $content.scrollTop);
  contentRoundId = null;
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
  contentRoundId = round.id;
  // T25 第 2 项：排序与一站式控件状态都按评测轮取用（此前换轮归零 / 跨轮串扰）
  sortState = sortStates.get(round.id) ?? null;

  $content.classList.add('filled');

  // T17：跑分组分类型——图片组只有图片流程（无视频导入），视频组只有视频导入与
  // 逐帧同步对比（无一站式与编码阶梯入口）。类型创建时已锁定，界面没有更改入口。
  if (session.group.kind === 'video') {
    renderVideoGroupContent(session);
  } else {
    renderImageGroupContent(session, onestopStateFor(round.id));
  }

  // T25：恢复本轮的滚动位置（新轮为 0）
  contentScrollTarget = contentScrollByRound.get(round.id) ?? 0;
  $content.scrollTop = contentScrollTarget;
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
 * 不挂载视频评测区块（视频导入只在视频跑分组出现）。ui = 本评测轮的一站式界面状态（T25）。 */
function renderImageGroupContent(session: { group: Group; round: Round }, ui: OnestopUiState): void {
  const { round } = session;
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const pickReferenceBtn = document.createElement('button');
  pickReferenceBtn.className = 'add-btn';
  pickReferenceBtn.textContent = round.referencePath ? '重选原图' : '选择原图';
  pickReferenceBtn.title = '从文件系统选一张原图作为画质与压缩的基准';
  pickReferenceBtn.disabled = scoring;
  pickReferenceBtn.addEventListener('click', () => void pickReference());

  // T18 胶囊：原图为单选胶囊，点击弹对话框替换（走 round_set_reference 既有覆盖
  // 语义：换图后旧跑分结果作废、体积比按新原图重算，核心库已处理）
  let referenceSlot: HTMLElement;
  if (round.referencePath) {
    referenceSlot = buildPill({
      label: truncateFileName(fileName(round.referencePath)),
      title: round.referencePath,
      onClick: () => void pickReference(),
      disabled: scoring,
      extraClass: 'pill-reference',
    });
  } else {
    const none = document.createElement('span');
    none.className = 'reference-label';
    none.textContent = '尚未选择原图';
    referenceSlot = none;
  }

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

  // T22 接线点：一站式跑分按钮。质量优先可按缓存阶梯给出项数；大小优先的项数要
  // 搜索后才知道（每格式命中点 + 邻近补点），只提示行为不报数
  const cachedLadder = qualityLadderCache.get(ui.baseline);
  const ladderCount =
    ui.mode === 'quality' && cachedLadder
      ? filterLadder(cachedLadder, ui.selection).length
      : null;
  const onestopBtn = document.createElement('button');
  onestopBtn.className = 'add-btn onestop-btn';
  onestopBtn.textContent = scoring ? '一站式跑分中…' : '一站式跑分';
  const downloadHint = '编码器首次使用需联网下载；AVIF/JXL 编码较慢';
  onestopBtn.title =
    !round.referencePath
      ? '需要先选择原图'
      : ladderCount === 0
        ? '请先在下方选择至少一个格式或无损组'
        : ui.mode === 'quality'
          ? `按基准 ${ui.baseline} 自动取点生成 ${ladderCount ?? '—'} 份跑分图并逐张跑分（${downloadHint}）`
          : `按目标大小为每个格式自动搜索最接近点并补邻近点，逐张跑分（${downloadHint}）`;
  onestopBtn.disabled = scoring || !round.referencePath || ladderCount === 0;
  onestopBtn.addEventListener('click', () => void runOnestop());

  // T13 接线点：导出评测轮报告（CSV / 自包含 HTML），无任何跑分内容时置灰
  const exportable =
    round.candidates.length > 0 || (round.videoCandidates?.length ?? 0) > 0;
  toolbar.append(
    pickReferenceBtn,
    referenceSlot,
    addCandidatesBtn,
    scoreBtn,
    onestopBtn,
    ...buildExportButtons(exportable),
  );
  $content.append(toolbar);

  // T18 胶囊：已选跑分图逐颗列出，× 单独移除；移除经 IPC 落库后整页重渲染，
  // 结果表与对比查看器随之只少这一行（其余文件与跑分结果不受影响）
  if (round.candidates.length > 0) {
    $content.append(
      buildPillList(
        round.candidates.map((c) => ({
          label: truncateFileName(fileName(c.path)),
          title: c.path,
          onRemove: () => removeCandidate(c.path),
          disabled: scoring,
        })),
        '已选跑分图：',
        '已选跑分图列表',
      ),
    );
  }
  // T22 接线点：一站式操作区（模式二选一 + 拉杆/大小输入 + 格式与无损组胶囊）；
  // 有原图才可触发，故仅在已选原图时展示；ui 是本轮自己的状态（T25）
  if (round.referencePath) {
    $content.append(buildOnestopControls(ui));
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

    // 备注列随行内 note 持久化（US22），悬浮 title 看完整文本
    $content.append(buildResultTable(round.id, round.candidates));

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
    $content.append(buildResultTable(round.id, round.candidates));
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
    scoringPaths,
    apply,
    // T23：视频选择对话框同样接入最近目录（记录状态开启时恢复，选完记录）
    openDefaultPath: defaultOpenPath,
    notePicked: notePickedPath,
    setScoring: (active, paths) => {
      scoring = active;
      scoringPaths = paths;
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

function buildResultTable(roundId: string, candidates: CandidateImage[]): HTMLTableElement {
  // US22：大小优先不可达标注随评测轮持久化，直接读行内 note——任一行有备注
  // 才追加尾随「备注」列（对齐 CLI 大小优先模式的 note 列）；其余模式列序不变
  const noteFor = (candidate: CandidateImage): string | null => candidate.note ?? null;
  const hasNotes = candidates.some((c) => noteFor(c) !== null);

  const table = document.createElement('table');
  table.className = 'result-table';

  // 列：排名 | 跑分图 | 文件大小 | 体积比 | 编码参数 | 指标列… | 状态 |（备注）
  const columns: { key: string; label: string; sortable: boolean }[] = [
    { key: 'name', label: '跑分图', sortable: true },
    { key: 'fileSize', label: '文件大小', sortable: true },
    { key: 'sizeRatio', label: '体积比', sortable: true },
    { key: 'encodingParams', label: '编码参数', sortable: true },
    ...metricKeys(candidates).map((key) => ({ key, label: key, sortable: true })),
    { key: 'status', label: '状态', sortable: false },
  ];
  if (hasNotes) columns.push({ key: 'note', label: '备注', sortable: false });

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
      sortStates.set(roundId, sortState); // T25：排序按轮保存，切走切回仍在
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
    // T18：名称列统一中间截断，悬浮 title 看全路径
    name.textContent = truncateFileName(fileName(candidate.path));
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
    } else if (scoringPaths.has(candidate.path)) {
      status.textContent = '跑分中…';
      status.classList.add('status-running');
    } else if (candidate.metrics === null) {
      status.textContent = '待跑分';
      status.classList.add('status-pending');
    } else {
      status.textContent = '完成';
    }

    tr.append(rank, name, fileSize, ratio, encodingParams, ...metricCells, status);

    // T22：备注列（大小优先不可达标注），悬浮 title 看完整文本
    if (hasNotes) {
      const note = document.createElement('td');
      note.className = 'cell-note';
      const text = noteFor(candidate);
      note.textContent = text ?? '';
      if (text) note.title = text;
      tr.append(note);
    }
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

// fb3：$addGroup 的点击处理已上移到「新建跑分组」下拉菜单接线处（toggleGroupMenu）。

// T29-3：「新建评测轮」同样改为下拉菜单（默认创建 / 高级创建…），交互模式与
// 「新建跑分组」下拉完全一致：点开选项即执行、点外部或 Esc 关闭。
const $newRoundMenu = document.querySelector<HTMLDivElement>('#new-round-menu')!;

function closeRoundMenu(): void {
  $newRoundMenu.hidden = true;
  $addRound.setAttribute('aria-expanded', 'false');
}

function toggleRoundMenu(): void {
  const open = $newRoundMenu.hidden;
  $newRoundMenu.hidden = !open;
  $addRound.setAttribute('aria-expanded', String(open));
}

$addRound.addEventListener('click', (e) => {
  e.stopPropagation(); // 别触发下面的「点外部关闭」监听
  toggleRoundMenu();
});

for (const item of $newRoundMenu.querySelectorAll<HTMLButtonElement>('.group-menu-item')) {
  item.addEventListener('click', () => {
    closeRoundMenu();
    if (item.dataset.kind === 'advanced') {
      openAdvancedCreation();
    } else {
      createRound();
    }
  });
}

document.addEventListener('click', (e) => {
  if (!$newRoundMenu.hidden && !$newRoundMenu.contains(e.target as Node)) closeRoundMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$newRoundMenu.hidden) closeRoundMenu();
});

/**
 * T29-3 接线点：高级创建面板（src/advanced-ui.ts）的宿主依赖。编码流程走
 * advanced_encode（参数合并在核心库），产物带 encodingParams 纳入新建的评测轮
 * 后复用整轮跑分循环。会话态在 advanced.ts 按跑分组键控（重启归零，D19）。
 */
function openAdvancedCreation(): void {
  const group = activeGroup();
  if (!group || scoring) return;

  /** 不吞错误的改动流程（面板要在错误行里汇总报错，与 apply 的状态栏口径并存）。 */
  const mutate = async (action: () => Promise<Workspace>): Promise<void> => {
    ws = await action();
    render();
    markSaved();
  };

  void openAdvancedPanel(group.id, {
    kind: group.kind,
    pickReference: async () => {
      const selected = await open({
        title: '选择原图（高级创建）',
        multiple: false,
        filters: [IMAGE_FILTER],
        defaultPath: defaultOpenPath(),
      });
      if (typeof selected !== 'string') return null;
      notePickedPath(selected);
      return selected;
    },
    isBusy: () => scoring,
    initialReference: () => activeRound()?.round.referencePath ?? null,
    setStatus,
    createRound: async () => {
      const current = activeGroup();
      if (!current) throw new Error('跑分组不存在或已被关闭');
      const beforeIds = new Set(current.rounds.map((r) => r.id));
      const name = `评测轮 ${current.rounds.length + 1}`;
      const updated = await invoke<Workspace>('round_create', {
        groupId: current.id,
        name,
      });
      const createdGroup = updated.groups.find((g) => g.id === current.id);
      const newRound = createdGroup?.rounds.find((r) => !beforeIds.has(r.id));
      if (!newRound) throw new Error('无法定位新建的评测轮');
      await mutate(() => invoke('round_activate', { groupId: current.id, roundId: newRound.id }));
      return { groupId: current.id, roundId: newRound.id };
    },
    setReference: (groupId, roundId, path) =>
      mutate(() => invoke('round_set_reference', { groupId, roundId, path })),
    encode: (groupId, roundId, referencePath, entry) =>
      invoke<AdvancedProductDto>('advanced_encode', {
        groupId,
        roundId,
        referencePath,
        job: {
          formatId: entry.encoderId,
          lossless: entry.lossless,
          mode: entry.mode,
          quality: entry.quality,
          targetBytes: entry.targetBytes,
          rows: entry.rows.map((row) => ({
            name: row.name,
            flag: row.flag,
            value: row.value.trim() === '' ? null : row.value.trim(),
            note: row.note === '' ? null : row.note,
            enabled: row.enabled,
          })),
        },
      }),
    addCandidates: async (groupId, roundId, paths, params) => {
      await mutate(() =>
        invoke('round_add_candidates', { groupId, roundId, paths, encodingParams: params }),
      );
    },
    setNote: async (groupId, roundId, path, note) => {
      await mutate(() =>
        invoke('round_set_candidate_note', { groupId, roundId, candidatePath: path, note }),
      );
    },
    scoreRound: () => scoreAllCandidates(),
    rerender: () => render(),
  });
}

// T23：设置面板（挂在 body 的覆盖层，不受内容区整页重渲染影响）
$openSettings.addEventListener('click', () => {
  if (!settings) return;
  openSettingsPanel(settings, {
    save: saveSettings,
    // 主题变化需要重渲染：画布底色等从 CSS 变量/新挂载立即生效
    onApplied: () => render(),
  });
});

void boot();
