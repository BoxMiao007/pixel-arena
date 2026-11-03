// encoding 域的界面会话态：编码阶梯参数（按轮）、候选就地编辑展开项。
//
// 三类状态分开（对齐 core/ui-state.ts 的口径）：
// - 按评测轮隔离（roundScoped）：阶梯参数、取点缓存、探测缓存、就地展开项；
// - 全局（模块级 Map）：参数变体会话（logic/entries，按组 → 轮）、原图标识缓存（logic/runtime）；
// - 不持久化：以上全部重启归零，工作区里的跑分结果不受影响（界面须如实说明）。
//
// 阶梯状态拆成两条互不误伤的缓存轴（决策 0042）：
// - 质量轴 `ladder + ladderKey`：只由方式（单点/阶梯）与基准质量决定；
// - 大小轴 `sizeOutcomes + sizeErrors + sizeKey`：只由目标大小与原图标识决定。
// 切方式不清另一轴，避免来回切重复探测；换原图只清大小轴。

import { roundScoped } from '../../core/ui-state';
import type { CandidateImage, Round, Workspace } from '../../core/model';
import {
  LOSSY_FORMATS,
  buildLadderPreview,
  defaultSelection,
  toggleFormat,
  type LadderItem,
  type LadderMode,
  type LadderPreview,
  type OnestopSelection,
  type SizeSearchOutcome,
} from './logic/ladder';

/** 质量方式的默认基准（与核心库 quality_ladder(75) 的默认阶梯一致）。 */
export const DEFAULT_BASELINE = 75;

/** 目标大小方式的默认目标（200 KB）。 */
export const DEFAULT_TARGET_BYTES = 200 * 1024;

/** 一个评测轮的编码阶梯界面状态。 */
export interface LadderUiState {
  /** 三种互斥方式：单点 / 阶梯 / 目标大小 */
  mode: LadderMode;
  /** 单点与阶梯共用的基准质量 0–100 */
  baseline: number;
  /** 目标大小方式的目标字节数（KB/MB 只是显示口径，真值一律字节） */
  targetBytes: number;
  unit: 'KB' | 'MB';
  selection: OnestopSelection;
  /** 用户是否动过勾选：目录晚到时只补默认全选，不覆盖用户的选择 */
  selectionTouched: boolean;
  /** 显式要求重新生成已有档位（默认跳过同档位的已跑分项） */
  regenerateExisting: boolean;
  /** 单点/阶梯的完整阶梯（未按格式过滤）；null = 还没取到 */
  ladder: LadderItem[] | null;
  /** 上面那份阶梯对应的质量轴键 */
  ladderKey: string;
  ladderLoading: boolean;
  ladderError: string | null;
  /** 目标大小方式：format → 探测结果 */
  sizeOutcomes: Record<string, SizeSearchOutcome>;
  /** 目标大小方式：format → 探测失败原因 */
  sizeErrors: Record<string, string>;
  /** 探测缓存对应的键（目标字节 + 原图标识） */
  sizeKey: string;
  /** 当前原图标识（path + size）；变化时清大小轴与提示 */
  referenceKey: string;
  /** 上次生成的失败项（就地展开，不折叠进状态栏） */
  failures: string[];
  /** 编码器可用性预检的结论（null = 未发现缺失） */
  encoderIssue: string | null;
}

/** 候选分区的「就地展开参数」状态（按轮）。 */
export interface CandidatesUiState {
  /** 正在就地编辑的条目 id；null = 都收起 */
  expanded: string | null;
  /** 就地编辑区的错误/提示（如目录加载失败） */
  message: string | null;
  /** 结构性改动（加卡/删卡/换图）的版本号：命中它才允许外层重建编辑区 */
  version: number;
}

function defaultLadderState(): LadderUiState {
  return {
    mode: 'single',
    baseline: DEFAULT_BASELINE,
    targetBytes: DEFAULT_TARGET_BYTES,
    unit: 'KB',
    selection: defaultSelection(),
    selectionTouched: false,
    regenerateExisting: false,
    ladder: null,
    ladderKey: '',
    ladderLoading: false,
    ladderError: null,
    sizeOutcomes: {},
    sizeErrors: {},
    sizeKey: '',
    referenceKey: '',
    failures: [],
    encoderIssue: null,
  };
}

/** 取该评测轮的编码阶梯状态（首次访问按默认值创建）。 */
export function ladderStateFor(roundId: string): LadderUiState {
  return roundScoped<LadderUiState>('encoding.ladder', roundId, defaultLadderState);
}

/** 取该评测轮的候选展开状态。 */
export function candidatesStateFor(roundId: string): CandidatesUiState {
  return roundScoped<CandidatesUiState>('encoding.candidates', roundId, () => ({
    expanded: null,
    message: null,
    version: 0,
  }));
}

/** 质量轴缓存键；目标大小方式不取质量阶梯，返回 null。 */
export function qualityKeyOf(state: LadderUiState): string | null {
  return state.mode === 'size' ? null : `${state.mode}:${state.baseline}`;
}

/** 大小轴缓存键：目标字节 + 原图标识。 */
export function sizeKeyOf(state: LadderUiState): string {
  return `${state.targetBytes}|${state.referenceKey}`;
}

/**
 * 质量轴失效：方式或基准变了就丢弃旧阶梯。
 * 返回 true 表示需要重新取点；目标大小方式不动质量轴缓存（切回来还能复用）。
 */
export function syncQualityKey(state: LadderUiState): boolean {
  const key = qualityKeyOf(state);
  if (key === null || key === state.ladderKey) return false;
  state.ladderKey = key;
  state.ladder = null;
  state.ladderLoading = false;
  state.ladderError = null;
  state.failures = [];
  state.encoderIssue = null;
  return true;
}

/** 大小轴失效：目标或原图变了就丢弃旧探测结果。返回 true 表示缓存被清空。 */
export function syncSizeKey(state: LadderUiState): boolean {
  const key = sizeKeyOf(state);
  if (key === state.sizeKey) return false;
  state.sizeKey = key;
  state.sizeOutcomes = {};
  state.sizeErrors = {};
  state.failures = [];
  return true;
}

/** 原图标识变化：清掉与旧图绑定的探测结果与提示。返回 true 表示发生了变化。 */
export function syncReference(state: LadderUiState, round: Round): boolean {
  const key =
    round.referencePath === null ? '' : `${round.referencePath}|${round.referenceSize ?? ''}`;
  if (key === state.referenceKey) return false;
  state.referenceKey = key;
  state.sizeOutcomes = {};
  state.sizeErrors = {};
  state.sizeKey = '';
  state.failures = [];
  state.encoderIssue = null;
  return true;
}

/**
 * 目录晚到时补默认勾选（有损全选、无损不选）。
 * 只在用户没动过勾选时生效，避免把「用户全取消」误判成「还没初始化」。
 */
export function ensureDefaultSelection(state: LadderUiState): boolean {
  if (state.selectionTouched) return false;
  const lossy = LOSSY_FORMATS.map((format) => format.format);
  const same =
    state.selection.lossyFormats.length === lossy.length &&
    lossy.every((format) => state.selection.lossyFormats.includes(format)) &&
    state.selection.losslessFormats.length === 0;
  if (same) return false;
  state.selection = { lossyFormats: lossy, losslessFormats: [] };
  return true;
}

/** 切换方式：清掉上一次的失败与编码器问题；两轴缓存各自按自己的键失效。 */
export function setLadderMode(state: LadderUiState, mode: LadderMode): void {
  if (state.mode === mode) return;
  state.mode = mode;
  state.ladderError = null;
  state.ladderLoading = false;
  state.failures = [];
  state.encoderIssue = null;
}

/** 改基准质量：只落值，不立刻清阶梯（松手提交时才取点，避免拖动中被重建）。 */
export function setBaseline(state: LadderUiState, value: number): void {
  const next = Math.min(100, Math.max(0, Math.round(value)));
  if (next === state.baseline) return;
  state.baseline = next;
  state.failures = [];
  state.encoderIssue = null;
}

/** 改目标大小：立刻清大小轴缓存（旧目标的实测字节不能复用）。 */
export function setTargetBytes(state: LadderUiState, bytes: number): void {
  const next = Math.max(1, Math.round(bytes));
  if (next === state.targetBytes) return;
  state.targetBytes = next;
  state.failures = [];
  state.encoderIssue = null;
  syncSizeKey(state);
}

/** 勾选/取消一个格式（有损与无损共用同一套切换语义）。 */
export function toggleSelectionFormat(
  state: LadderUiState,
  scope: 'lossy' | 'lossless',
  format: string,
): void {
  if (scope === 'lossy') {
    state.selection.lossyFormats = toggleFormat(state.selection.lossyFormats, format);
  } else {
    state.selection.losslessFormats = toggleFormat(state.selection.losslessFormats, format);
  }
  state.selectionTouched = true;
  state.failures = [];
  state.encoderIssue = null;
}

/** 是否重新生成已有档位：默认跳过同档位的已跑分项，打开后全部重新生成。 */
export function setRegenerateExisting(state: LadderUiState, value: boolean): void {
  if (state.regenerateExisting === value) return;
  state.regenerateExisting = value;
  state.failures = [];
  state.encoderIssue = null;
}

/** 当前参数下的矩阵与生成清单（界面与动作共用的唯一出口）。 */
export function previewOf(
  state: LadderUiState,
  candidates: readonly CandidateImage[] = [],
): LadderPreview {
  return buildLadderPreview({
    mode: state.mode,
    selection: state.selection,
    ladder: state.ladder,
    sizeOutcomes: state.sizeOutcomes,
    sizeErrors: state.sizeErrors,
    existingCandidates: candidates.map((candidate) => ({
      path: candidate.path,
      encodingParams: candidate.encodingParams ?? null,
      scored: candidate.metrics !== null && candidate.error === null,
    })),
    regenerateExisting: state.regenerateExisting,
  });
}

/** 工作区里某轮当前的结果条数（通知文案与确认文案用）。 */
export function candidateCountIn(workspace: Workspace | null, roundId: string): number {
  if (!workspace) return 0;
  for (const group of workspace.groups) {
    const round = group.rounds.find((item) => item.id === roundId);
    if (round) return round.candidates.length;
  }
  return 0;
}
