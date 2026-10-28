// 指标语义与格式化：结果表表头、排序方向、单元格小数位、BD-rate 文本都从这里取。
//
// 指标键是核心库落库的存储键（workspace.json 里就叫 PSNR / MS-SSIM / …），
// 本模块只负责「怎么展示、往哪个方向排」，不改键名、不改后端契约。
// 已知指标固定小数位，避免同一列随数值大小在 2 位与 4 位之间跳变。

import type { MetricValue } from '../../core/model';

export type MetricBetter = 'higher' | 'lower';

export interface MetricMeta {
  /** 存储键，排序与导出都用它。 */
  key: string;
  /** 表头文案（含单位，如 `PSNR (dB)`）。 */
  label: string;
  /** 单位；无单位时为 null（单元格只显示数值，单位进表头）。 */
  unit: string | null;
  /** 固定小数位。 */
  decimals: number;
  /** 优方向：决定首次点击的排序方向与「最佳值」高亮。 */
  better: MetricBetter;
  /** 悬浮说明（含量纲与方向），用在表头 title。 */
  hint: string;
  /** 是否是我们认识的指标；未知键原样显示键名，按「越大越好」兜底。 */
  known: boolean;
}

interface KnownMetric {
  label: string;
  unit?: string;
  decimals: number;
  better?: MetricBetter;
  hint: string;
}

const KNOWN_METRICS: Record<string, KnownMetric> = {
  PSNR: { label: 'PSNR', unit: 'dB', decimals: 2, hint: '峰值信噪比，单位 dB；越大越好' },
  SSIM: { label: 'SSIM', decimals: 4, hint: '结构相似度（0–1）；越大越好' },
  'MS-SSIM': { label: 'MS-SSIM', decimals: 4, hint: '多尺度结构相似度（0–1）；越大越好' },
  SSIMULACRA2: { label: 'SSIMULACRA2', decimals: 2, hint: '感知质量分（0–100）；越大越好' },
  Butteraugli: {
    label: 'Butteraugli',
    decimals: 3,
    better: 'lower',
    hint: '感知差异距离；越小越好',
  },
  VMAF: { label: 'VMAF', decimals: 2, hint: '视频质量分（0–100）；越大越好' },
};

/** 图片结果表的固定指标列序；未登记的键按字典序追加在其后。 */
export const IMAGE_METRIC_ORDER: readonly string[] = [
  'PSNR',
  'SSIM',
  'MS-SSIM',
  'SSIMULACRA2',
  'Butteraugli',
];

/** 未知指标的兜底小数位（沿用旧界面对小值的四位精度）。 */
const UNKNOWN_DECIMALS = 4;

export function metricMeta(key: string): MetricMeta {
  const known = KNOWN_METRICS[key];
  if (!known) {
    return {
      key,
      label: key,
      unit: null,
      decimals: UNKNOWN_DECIMALS,
      better: 'higher',
      hint: '自定义指标；数值越大越好',
      known: false,
    };
  }
  return {
    key,
    label: known.unit ? `${known.label} (${known.unit})` : known.label,
    unit: known.unit ?? null,
    decimals: known.decimals,
    better: known.better ?? 'higher',
    hint: known.hint,
    known: true,
  };
}

/**
 * 指标列顺序：优先序里出现过的键按优先序在前，其余键按字典序追加。
 * 结果表的固定序用 IMAGE_METRIC_ORDER；视频表传自己的 ['VMAF','PSNR','SSIM']。
 */
export function orderMetricKeys(
  keys: Iterable<string>,
  preferred: readonly string[] = IMAGE_METRIC_ORDER,
): string[] {
  const present = new Set(keys);
  const ordered = preferred.filter((key) => present.has(key));
  const seen = new Set(ordered);
  const rest = [...present].filter((key) => !seen.has(key)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest];
}

/** 指标值的排序取值：缺值 null（沉底），"inf" 哨兵按 +Infinity。 */
export function metricSortValue(value: MetricValue | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return value === 'inf' ? Number.POSITIVE_INFINITY : value;
}

/** 指标单元格文本：∞ / 固定小数位 / 缺值破折号。 */
export function formatMetricValue(meta: MetricMeta, value: MetricValue | undefined | null): string {
  if (value === undefined || value === null) return '—';
  if (value === 'inf') return '∞';
  return value.toFixed(meta.decimals);
}

/** 按存储键格式化（表头与单元格共用同一套小数位）。 */
export function formatMetricFor(key: string, value: MetricValue | undefined | null): string {
  return formatMetricValue(metricMeta(key), value);
}

/** 表头悬浮说明：`PSNR (dB)，峰值信噪比…`。 */
export function metricHeaderTitle(meta: MetricMeta): string {
  return `${meta.label}，${meta.hint}`;
}

/** 首次点击该列的排序方向：越小越好的指标先升序。 */
export function metricPreferredDir(meta: MetricMeta): 1 | -1 {
  return meta.better === 'lower' ? 1 : -1;
}

/** BD-rate 数值：带符号两位小数百分数（与导出报告同格式）。 */
export function formatBdRate(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** BD-rate 单元格：不可算时破折号。 */
export function formatBdRateCell(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatBdRate(value);
}
