// 网格排布（纯函数）：行列按「参与对比的图片总数」自动排布。
// 由 src/features/viewer/layout.test.ts 守护；分屏栏数（N+1）不用本模块。

export interface GridLayout {
  rows: number;
  cols: number;
}

/**
 * 票面映射：1→单格、2→1×2、3-4→2×2、5-6→2×3、7-9→3×3、更多按 3 列折行。
 * count 由调用方按「原图 + 跑分图」总数传入。
 */
export function gridLayout(count: number): GridLayout {
  const n = Math.max(1, Math.floor(count));
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  if (n <= 9) return { rows: 3, cols: 3 };
  return { rows: Math.ceil(n / 3), cols: 3 };
}

/** 网格格子总数（= rows × cols，可能多于图片数：多出的格子留空）。 */
export function cellCount(count: number): number {
  const { rows, cols } = gridLayout(count);
  return rows * cols;
}

/** 分屏栏数：第 0 栏原图 + 每张跑分图一栏。 */
export function paneCount(candidateCount: number): number {
  return 1 + Math.max(0, Math.floor(candidateCount));
}

/** 网格区每行的最小可用高度（px），低于它就不再压缩格子，让网格区内部滚动。 */
export const GRID_MIN_ROW_PX = 180;

/** 网格每列的最小可用宽度（px）：多图时宁可横向滚动，也不把格子压成看不清的窄条。 */
export const GRID_MIN_CELL_PX = 280;

/** 分屏每栏的最小可用宽度（px）：7 栏时横向滚动，保证每栏能看清并放下错误态按钮。 */
export const SPLIT_MIN_PANE_PX = 240;

/** 宽高对（结构兼容 DOMRect / Size，避免为取值引入依赖）。 */
export interface Box {
  width: number;
  height: number;
}

/**
 * 窗格尺寸是否已被舞台约束（真窗首帧回归）：
 * 刚挂载的那一帧浏览器可能还没把祖先的网格/弹性约束算进来，canvas 会量到接近整窗的
 * 宽或高。这种值不能用于 fit，否则分屏 7 栏会按 78% 裁切、点一次「适应」才回到 15%。
 * 容差 1px：取整/边框造成的差值是正常的。
 */
export function isPaneSizeSane(pane: Box, stage: Box): boolean {
  return pane.width <= stage.width + 1 && pane.height <= stage.height + 1;
}

/** 两次量到的尺寸是否可视为同一个（默认容差 1px）。 */
export function sameBox(
  a: Box | null | undefined,
  b: Box | null | undefined,
  tolerance = 1,
): boolean {
  if (!a || !b) return false;
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}
