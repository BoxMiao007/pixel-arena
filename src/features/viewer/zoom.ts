// 缩放读数与快速档位（纯函数）：百分比格式化、键盘步进、菜单档位。
// 由 src/features/viewer/zoom.test.ts 守护。

/** 键盘 / 工具栏 +/- 的每档倍数。 */
export const ZOOM_STEP = 1.25;

/** 缩放菜单里的固定档位。 */
export const ZOOM_PRESETS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/**
 * 缩放百分比文案：
 * - ≥100% 取整（100%、400%）；
 * - 10%~99% 保留一位小数、去掉多余的 .0（12.5%、37%）；
 * - <10% 保留两位小数（1%、2.5%、0.5%）。
 * 数值用 Number 计算后再拼字符串，避免 toFixed 的 -0 与尾零噪音。
 */
export function formatZoomPercent(zoom: number): string {
  const percent = zoom * 100;
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent >= 100) return `${Math.round(percent)}%`;
  if (percent >= 10) return `${trimZeros(percent.toFixed(1))}%`;
  return `${trimZeros(percent.toFixed(2))}%`;
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** 键盘缩进/缩出：返回新的 zoom（调用方再 clamp）。 */
export function steppedZoom(current: number, direction: 1 | -1): number {
  return current * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
}
