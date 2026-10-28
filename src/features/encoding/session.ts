// encoding 域的界面会话态：一站式参数（按轮）、阶梯点勾选、候选就地编辑展开项。
//
// 三类状态分开（对齐 core/ui-state.ts 的口径）：
// - 按评测轮隔离（roundScoped）：阶梯参数、排除的阶梯点、大小搜索缓存、就地展开项；
// - 全局（模块级 Map）：图片条目队列（logic/entries 的 Map）、原图标识缓存（logic/runtime）；
// - 不持久化：以上全部重启归零，工作区里的跑分结果不受影响（界面须如实说明）。

import { roundScoped } from '../../core/ui-state';
import type { Workspace } from '../../core/model';
import {
  LOSSLESS_FORMATS,
  LOSSY_FORMATS,
  defaultSelection,
  filterLadder,
  ladderItemKey,
  losslessLadder,
  sizeOutcomeLadder,
  toggleFormat,
  type LadderItem,
  type OnestopMode,
  type OnestopSelection,
  type SizeSearchOutcome,
} from './logic/ladder';

/** 质量优先的默认基准（与核心库 quality_ladder(75) 的现行默认阶梯一致）。 */
export const DEFAULT_BASELINE = 75;

/** 大小优先的默认目标（200 KB）。 */
export const DEFAULT_TARGET_BYTES = 200 * 1024;

/** 一个评测轮的一站式界面状态。 */
export interface LadderUiState {
  mode: OnestopMode;
  /** 质量优先的基准质量 0–100 */
  baseline: number;
  /** 大小优先的目标字节数（KB/MB 只是显示口径，真值一律字节） */
  targetBytes: number;
  unit: 'KB' | 'MB';
  /** 单点模式：每有损格式只压基准质量 1 点，质量/模式/目标大小锁死 */
  singlePoint: boolean;
  selection: OnestopSelection;
  /** 当前参数对应的完整阶梯（未按点排除前）；null = 还没取到 */
  ladder: LadderItem[] | null;
  /** 上面那份阶梯对应的参数键（参数一变就作废重取） */
  ladderKey: string;
  /** 被用户逐点取消的阶梯项键（ladderKey 变化时清空） */
  excluded: Set<string>;
  /** 大小优先：format → 搜索结果（与 sizeKey 绑定） */
  sizeOutcomes: Record<string, SizeSearchOutcome>;
  /** sizeOutcomes 对应的目标大小键 */
  sizeKey: string;
  /** 上次自动编码的失败项（就地展开，不折叠进状态栏） */
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
    mode: 'quality',
    baseline: DEFAULT_BASELINE,
    targetBytes: DEFAULT_TARGET_BYTES,
    unit: 'KB',
    singlePoint: false,
    selection: defaultSelection(),
    ladder: null,
    ladderKey: '',
    excluded: new Set(),
    sizeOutcomes: {},
    sizeKey: '',
    failures: [],
    encoderIssue: null,
  };
}

/** 取该评测轮的一站式状态（首次访问按默认值创建）。 */
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

/**
 * 当前参数键：质量优先 = 基准（单点模式单独一档），大小优先 = 目标字节。
 * 键一变就得重新取点（缓存与「逐点排除」都按它作废）。
 */
export function ladderKeyOf(state: LadderUiState): string {
  if (state.singlePoint) return `single:${state.baseline}`;
  if (state.mode === 'quality') return `quality:${state.baseline}`;
  return `size:${state.targetBytes}`;
}

/**
 * 参数变化后整理缓存：键变了就作废旧阶梯与逐点排除。
 * 返回 true 表示需要重新取点（调用方负责发起 IPC）。
 */
export function syncLadderKey(state: LadderUiState): boolean {
  const key = ladderKeyOf(state);
  if (key === state.ladderKey) return false;
  state.ladderKey = key;
  state.ladder = null;
  state.excluded = new Set();
  state.failures = [];
  if (key.startsWith('size:')) {
    state.sizeOutcomes = {};
    state.sizeKey = '';
  }
  return true;
}

/** 按格式清单列出当前勾选的格式串（有损在前、无损在后）。 */
export function selectedFormats(state: LadderUiState): string[] {
  return [...state.selection.lossyFormats, ...state.selection.losslessFormats];
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
}

/**
 * 当前参数下的「格式 + 勾选」清单（未按点排除）：质量/单点 = 过滤核心库阶梯；
 * 大小优先 = 各勾选格式的搜索结果展开 + 无损对照组（搜索结果还没回来时只有无损项）。
 */
export function formatLadderOf(state: LadderUiState): LadderItem[] {
  if (state.mode === 'size' && !state.singlePoint) {
    const lossy = LOSSY_FORMATS.filter((f) => state.selection.lossyFormats.includes(f.format))
      .flatMap((f) => {
        const outcome = state.sizeOutcomes[f.format];
        return outcome ? sizeOutcomeLadder(outcome) : [];
      });
    return [...lossy, ...losslessLadder(state.selection)];
  }
  return filterLadder(state.ladder ?? [], state.selection);
}

/** 最终要生成的清单：格式过滤后再去掉用户逐点取消的项。 */
export function planItemsOf(state: LadderUiState): LadderItem[] {
  const base = formatLadderOf(state);
  if (state.excluded.size === 0) return base;
  return base.filter((item) => !state.excluded.has(ladderItemKey(item)));
}

/** 切换某个阶梯点的勾选（只影响本轮的生成清单，不改核心库取点结果）。 */
export function toggleLadderItem(state: LadderUiState, item: LadderItem): void {
  const key = ladderItemKey(item);
  if (state.excluded.has(key)) state.excluded.delete(key);
  else state.excluded.add(key);
}

/** 大小优先：搜索结果是否覆盖了全部勾选的有损格式（决定能否提交）。 */
export function sizeSearchComplete(state: LadderUiState): boolean {
  return LOSSY_FORMATS.filter((f) => state.selection.lossyFormats.includes(f.format)).every(
    (f) => state.sizeOutcomes[f.format] !== undefined,
  );
}

/** 格式串 → 该格式的显示名（勾选区与预览网格共用）。 */
export function formatLabel(format: string): string {
  return (
    LOSSY_FORMATS.find((f) => f.format === format)?.label ??
    LOSSLESS_FORMATS.find((f) => f.format === format)?.label ??
    format
  );
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
