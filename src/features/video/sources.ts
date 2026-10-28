// 视频源列表、默认两路、网格排布与每格选路（纯函数，无 DOM）。
//
// 语义与旧 src/video-compare.ts 一致（复制而非 import，旧文件由 lead 收尾时删除）：
// - 原视频排最前，跑分视频按加入顺序跟后；
// - 分屏 = 原视频固定最左 + 其余源各一栏；
// - 网格行列按源总数自动排布，格子多于源数时留空；
// - 每格显式选路：'' 表示显式留空，失效路径回落默认布局。

/** 本轮可选的视频源：原视频排最前，跑分视频按加入顺序跟后。 */
export function videoSources(
  referencePath: string | null,
  candidatePaths: readonly string[],
): string[] {
  return referencePath ? [referencePath, ...candidatePaths] : [...candidatePaths];
}

/** 默认两路：左=原视频（第一项），右=第一段跑分视频（第二项）；不足两段返回 null。 */
export function defaultPair(sources: readonly string[]): { left: string; right: string } | null {
  if (sources.length < 2) return null;
  return { left: sources[0], right: sources[1] };
}

/** 分屏栏位：基准（原视频；没有则第一源）固定最左，其余源按顺序各一栏。 */
export function splitPanes(referencePath: string | null, sources: readonly string[]): string[] {
  const base = referencePath ?? sources[0];
  if (!base) return [];
  return [base, ...sources.filter((path) => path !== base)];
}

/** 网格行列按源总数自动排布：1→1×1、2→1×2、3-4→2×2、5-6→2×3、7-9→3×3、更多按 3 列折行。 */
export function gridLayout(count: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.floor(count));
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  if (n <= 9) return { rows: 3, cols: 3 };
  return { rows: Math.ceil(n / 3), cols: 3 };
}

/** 网格格子总数（含留空格）。 */
export function gridCellCount(count: number): number {
  const { rows, cols } = gridLayout(count);
  return rows * cols;
}

/** 放大态每行保底高度（px）：矮窗口 + 多源时仍保证每格可用。 */
export const GRID_ZOOM_ROW_MIN_PX = 180;

/** 放大/还原按钮文案。 */
export function gridZoomLabel(zoomed: boolean): string {
  return zoomed ? '还原' : '放大';
}

/** 第 index 格的默认选路：第 0 格基准（左路），其余按「除基准外的源顺序」填入。 */
export function defaultCellVideo(
  index: number,
  leftPath: string,
  sources: readonly string[],
): string | null {
  if (index === 0) return leftPath;
  const others = sources.filter((path) => path !== leftPath);
  return others[index - 1] ?? null;
}

/**
 * 每格最终显示的源：显式选择仍有效则用之（''=显式留空），否则回落默认布局；
 * 显式路径已不在本轮（视频被移除）时同样回落，不显示失效源。
 */
export function resolveCellVideo(
  index: number,
  cellPaths: readonly (string | null)[] | null,
  leftPath: string,
  sources: readonly string[],
): string | null {
  const chosen = cellPaths?.[index];
  if (chosen !== null && chosen !== undefined) {
    if (chosen === '') return null;
    if (sources.includes(chosen)) return chosen;
  }
  return defaultCellVideo(index, leftPath, sources);
}
