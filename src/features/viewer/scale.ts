// 比例尺刻度（纯函数）：在 1 / 2 / 5 × 10ⁿ 里挑一条整数像素长度。
// 由 src/features/viewer/scale.test.ts 守护。

export interface ScaleTick {
  /** 这条刻度代表的原始像素宽度（整数，读数直接用）。 */
  pixels: number;
  /** 它在屏幕上的实际宽度（四舍五入后的像素数）。 */
  screenPx: number;
}

/**
 * 挑一条比例尺刻度：在尺身「不超过目标宽度」的候选里取最大的一条。
 *
 * 只在整数阶梯（1 / 2 / 5 × 10ⁿ）里取值，任意缩放下读数都是整数像素，不会出现
 * 「137 px」这种没法用的数。封顶（≤ targetPx）是为了极端缩小：2% 档位下若按
 * 「最接近目标」取，会挑出 5000 px 这种比图还大的读数、尺身比目标宽出一截，
 * 把工具条右侧的缩放组往右挤；封顶后尺身恒不长于目标，挤占空间可预期。
 * （放大倍率大于目标宽度的极端档位例外：最小刻度就是 1 个原始像素，物理上收不回来。）
 *
 * @param zoom     当前缩放（屏幕像素 / 图像像素）
 * @param targetPx 尺身目标宽度（屏幕像素）
 */
export function pickScaleTick(zoom: number, targetPx: number): ScaleTick | null {
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  if (!Number.isFinite(targetPx) || targetPx <= 0) return null;
  // 1×magnitude 恒 ≤ ideal，所以它一定能放进目标宽度里（作为兜底候选）
  const idealPx = targetPx / zoom;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(idealPx, 1)));
  let pixels = magnitude;
  for (const multiplier of [2, 5, 10]) {
    const candidate = multiplier * magnitude;
    // 浮点误差容忍：刚好等于目标宽度（如 48px 目标 × 1.0）不应被判超宽
    if (candidate * zoom <= targetPx + 1e-9) pixels = candidate;
  }
  return { pixels: Math.round(pixels), screenPx: Math.round(pixels * zoom) };
}
