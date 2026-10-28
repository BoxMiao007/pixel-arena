// 查看器选图逻辑（纯函数，无 DOM）：
// - 单槽模式（滑动/叠加/差异/闪烁）共用一个跑分图槽，按「轮 × 模式」隔离；
// - 分屏每栏与网格每格共用同一套「显式选择 / 显式留空 / 失效回落 / 越界」语义；
// - 胶片条点击落到哪个槽位，也在这里决定（mode / pane / cell）。
//
// 由 src/features/viewer/selection.test.ts 守护。

import type { RoundLike, SingleSlotMode, ViewerMode } from './types';

/** 单槽模式手动选中的跑分图（键缺省 = 该模式未手动选过，跟随当前候选顺序）。 */
export type ModeCandidateChoices = Partial<Record<SingleSlotMode, string>>;

/**
 * 单槽槽位解析：显式选择仍在本轮候选里则用之，否则回落第一张（候选删光时为 null）。
 * 换图路径必须每次经此解析（回归：槽位状态曾与画布条目脱钩，画布持续画旧图）。
 */
export function resolveCandidatePath(
  chosen: string | null,
  round: Pick<RoundLike, 'candidates'>,
): string | null {
  if (chosen !== null && chosen !== undefined && round.candidates.some((c) => c.path === chosen)) {
    return chosen;
  }
  return round.candidates[0]?.path ?? null;
}

/** 某单槽模式的槽位解析（该模式自己的选择；未选过/已失效 → 第一张）。 */
export function resolveModeCandidatePath(
  choices: ModeCandidateChoices,
  mode: SingleSlotMode,
  round: Pick<RoundLike, 'candidates'>,
): string | null {
  return resolveCandidatePath(choices[mode] ?? null, round);
}

/**
 * 第 index 位的默认选图：第 0 位原图，其余按跑分图顺序填入，不够的留空。
 * 分屏每栏与网格每格的默认布局完全同构，共用本函数。
 */
export function defaultPaneImage(index: number, round: RoundLike): string | null {
  if (index === 0) return round.referencePath;
  return round.candidates[index - 1]?.path ?? null;
}

/**
 * 第 index 位最终显示的图：显式选择仍有效则用之（''=显式留空），否则回落默认布局。
 * 分屏不提供「（空）」选项，但空串语义仍由本函数承载（网格用）。
 */
export function resolvePaneImage(
  paths: ReadonlyArray<string | null | undefined> | null | undefined,
  index: number,
  round: RoundLike,
): string | null {
  const chosen = paths?.[index];
  if (chosen !== null && chosen !== undefined) {
    if (chosen === '') return null; // 显式留空
    const valid = chosen === round.referencePath || round.candidates.some((c) => c.path === chosen);
    if (valid) return chosen;
    // 图已不在本轮（被删除等）：回落默认，不显示失效图
  }
  return defaultPaneImage(index, round);
}

/** 胶片条一次点击写到哪里。 */
export type PickSlot =
  | { kind: 'mode' }
  | { kind: 'pane'; index: number }
  | { kind: 'cell'; index: number };

function clampIndex(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

/**
 * 胶片条点击的落点：
 * - 单槽四模式 → 该模式的隔离槽；
 * - 分屏 → 当前聚焦栏（无聚焦则第 1 栏：第 0 栏默认是原图）；
 * - 网格 → 当前聚焦格（无聚焦则第 1 格：第 0 格默认是原图）。
 * index 会钳制到合法范围：删图后聚焦索引越界不会写到不存在的栏/格。
 */
export function pickSlot(
  mode: ViewerMode,
  focusIndex: number | null,
  counts: { panes: number; cells: number },
): PickSlot {
  if (mode === 'slider' || mode === 'overlay' || mode === 'diff' || mode === 'blink') {
    return { kind: 'mode' };
  }
  if (mode === 'split') {
    return { kind: 'pane', index: clampIndex(focusIndex ?? 1, counts.panes - 1) };
  }
  return { kind: 'cell', index: clampIndex(focusIndex ?? 1, counts.cells - 1) };
}

/**
 * 把一次选图写成新的状态切片（不改入参，返回要写回的字段）：
 * 空串表示显式留空（只对网格有意义），胶片条不提供该值。
 */
export function applyPick(
  current: {
    candidateChoices: ModeCandidateChoices;
    panePaths: readonly (string | null)[];
    cellPaths: readonly (string | null)[];
    paneCount: number;
    cellCount: number;
  },
  slot: PickSlot,
  mode: SingleSlotMode | null,
  path: string,
): {
  candidateChoices?: ModeCandidateChoices;
  panePaths?: (string | null)[];
  cellPaths?: (string | null)[];
} {
  if (slot.kind === 'mode') {
    if (mode === null) return {};
    return { candidateChoices: { ...current.candidateChoices, [mode]: path } };
  }
  if (slot.kind === 'pane') {
    const next: (string | null)[] = Array.from(
      { length: current.paneCount },
      (_, i) => current.panePaths[i] ?? null,
    );
    next[slot.index] = path;
    return { panePaths: next };
  }
  const next: (string | null)[] = Array.from(
    { length: current.cellCount },
    (_, i) => current.cellPaths[i] ?? null,
  );
  next[slot.index] = path;
  return { cellPaths: next };
}
