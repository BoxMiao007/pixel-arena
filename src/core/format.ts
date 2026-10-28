// 数值与时间的统一格式化：结果表、检视器、报告链接口都从这里取，
// 保证同一数据在界面各处显示一致（避免各模块各写一套 toFixed）。

import type { MetricValue } from './model';

/** 文件大小：B / KB / MB，按 1024 进制。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 体积比：变小用百分比，变大用倍数（跑分图比原图大时仍可读）。 */
export function formatRatio(ratio: number): string {
  return ratio < 1 ? `${(ratio * 100).toFixed(1)}%` : `×${ratio.toFixed(2)}`;
}

/** 指标值：≥10（PSNR 等 dB）两位小数，小值（SSIM 等）四位；∞ 用数学符号。 */
export function formatMetric(metric: MetricValue): string {
  if (metric === 'inf') return '∞';
  return Math.abs(metric) >= 10 ? metric.toFixed(2) : metric.toFixed(4);
}

/** 耗时（毫秒）：小于 1s 用 ms，否则用 s 保留一位小数。 */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** 本地时间（24 小时制），状态栏「已保存 14:03:22」用。 */
export function formatClock(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
