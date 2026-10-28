// 效率对比页签的纯逻辑：画质指标选择、按体积排序、帕累托「划算」判定与支配关系说明。
//
// 只用「同体积下画质更高、同画质下体积更小」这一条支配关系：1 张图也有数据，
// 2 张图起就能给出结论，不需要凑一条率失真曲线（BD-rate 已按决策 0035 整体下线）。
//
// 全部纯函数，不碰 DOM / IPC，可在 node 里直接单测。

import { formatLabelForPath } from '../../core/format-label';
import type { CandidateImage, MetricValue, Round } from '../../core/model';
import { IMAGE_METRIC_ORDER, metricMeta } from './metrics';

/** 参与对比的画质指标（PSNR / SSIM / …）及其方向与小数位。 */
export interface QualityMetric {
  key: string;
  /** 表头文案（含单位，如 `PSNR (dB)`）。 */
  label: string;
  unit: string | null;
  decimals: number;
  better: 'higher' | 'lower';
  /** 表头悬浮说明（方向与量纲）。 */
  hint: string;
}

/** 一张被判「不如别人」的图，以及支配它的那张图。 */
export interface Dominator {
  path: string;
  /** 支配者展示名：有编码参数用参数（如 `JPEG q75`），否则用格式。 */
  label: string;
  /** 本行比支配者大多少（百分比，恒 ≥ 0）。 */
  sizeDeltaPercent: number;
  /** 本行画质比支配者差多少（指标原单位，恒 ≥ 0；任一方为 ∞ 时 null）。 */
  qualityDelta: number | null;
  /** 两边画质相同（含都无损）。 */
  qualitySame: boolean;
  /** 两边都是无损（PSNR = ∞），说明文字据此区分「都无损」与「同分」。 */
  bothLossless: boolean;
}

export interface EfficiencyRow {
  path: string;
  format: string;
  fileSize: number;
  sizeRatio: number | null;
  /** 指标原值（`inf` 表示无损）。 */
  value: MetricValue;
  /** 在帕累托前沿上；没有更小又更高画质的图。 */
  frontier: boolean;
  dominator: Dominator | null;
}

export interface EfficiencyTable {
  metric: QualityMetric;
  /** 按体积升序（同体积画质高的在前）。 */
  rows: EfficiencyRow[];
  /** 可比较的行数 ≥ 2；不足 2 张时不判「划算」。 */
  comparable: boolean;
  frontierCount: number;
  /** 没有参与对比的候选数（未跑分 / 失败 / 缺该指标 / 体积为 0）。 */
  skipped: number;
}

const EPSILON = 1e-9;

/** 指标原值 → 可比较的「画质分」（越大越好；无穷用 ±Infinity）。 */
export function qualityScore(value: MetricValue, better: 'higher' | 'lower'): number {
  const raw = value === 'inf' ? Number.POSITIVE_INFINITY : value;
  return better === 'lower' ? -raw : raw;
}

/** 参与对比的候选：跑分成功、有指标、体积可读。 */
function comparableCandidates(round: Round): CandidateImage[] {
  return round.candidates.filter(
    (candidate) => candidate.error === null && candidate.metrics !== null && candidate.fileSize > 0,
  );
}

/**
 * 选本轮使用的画质指标：按结果表的固定指标序取第一个有数据的（PSNR 优先），
 * 都没数据时退回任意出现过的键。没有可比指标返回 null。
 */
export function qualityMetricFor(round: Round): QualityMetric | null {
  const scored = comparableCandidates(round);
  const known = IMAGE_METRIC_ORDER.find((key) =>
    scored.some((candidate) => candidate.metrics?.[key] !== undefined),
  );
  const key =
    known ??
    [...new Set(scored.flatMap((candidate) => Object.keys(candidate.metrics ?? {})))].sort((a, b) =>
      a.localeCompare(b),
    )[0];
  if (key === undefined) return null;
  const meta = metricMeta(key);
  return {
    key,
    label: meta.label,
    unit: meta.unit,
    decimals: meta.decimals,
    better: meta.better,
    hint: meta.hint,
  };
}

/** a 是否支配 b：体积不更大且画质不更低，并且至少有一项严格更好。 */
function dominates(a: { size: number; score: number }, b: { size: number; score: number }): boolean {
  if (a.size > b.size || a.score < b.score) return false;
  return a.size < b.size || a.score > b.score;
}

/** 画质降序比较（不用相减：+∞ − +∞ 是 NaN，会让排序结果不确定）。 */
function byScoreDesc(a: { score: number }, b: { score: number }): number {
  if (a.score === b.score) return 0;
  return a.score > b.score ? -1 : 1;
}

function candidateLabel(candidate: CandidateImage): string {
  const params = candidate.encodingParams?.trim();
  return params && params.length > 0 ? params : formatLabelForPath(candidate.path);
}

/**
 * 生成本轮效率对比表。没有可比指标时返回 null；有指标但只有 1 张时 rows 长度为 1、
 * comparable 为 false（界面不判「划算」，只说明再加一张就能比）。
 */
export function buildEfficiencyTable(round: Round): EfficiencyTable | null {
  const metric = qualityMetricFor(round);
  if (metric === null) return null;

  const points = comparableCandidates(round)
    .filter((candidate) => candidate.metrics?.[metric.key] !== undefined)
    .map((candidate) => {
      const value = candidate.metrics?.[metric.key];
      // filter 已保证存在；这里收窄类型。
      const resolved = value as MetricValue;
      return {
        candidate,
        value: resolved,
        size: candidate.fileSize,
        score: qualityScore(resolved, metric.better),
        format: formatLabelForPath(candidate.path),
      };
    })
    .sort(
      (a, b) =>
        a.candidate.fileSize - b.candidate.fileSize ||
        byScoreDesc(a, b) ||
        a.candidate.path.localeCompare(b.candidate.path),
    );

  const comparable = points.length >= 2;
  const rows: EfficiencyRow[] = points.map((point) => {
    const dominators = comparable
      ? points.filter((other) => other !== point && dominates(other, point))
      : [];
    // 挑体积最接近的那张当「不如谁」的对照：差距最小，解释最好懂。
    const bySize = [...dominators].sort(
      (a, b) => b.candidate.fileSize - a.candidate.fileSize || byScoreDesc(a, b),
    );
    const dominator = bySize[0] ?? null;
    return {
      path: point.candidate.path,
      format: point.format,
      fileSize: point.candidate.fileSize,
      sizeRatio: point.candidate.sizeRatio,
      value: point.value,
      frontier: comparable && dominators.length === 0,
      dominator:
        dominator === null
          ? null
          : buildDominator(point, dominator, metric),
    };
  });

  return {
    metric,
    rows,
    comparable,
    frontierCount: rows.filter((row) => row.frontier).length,
    skipped: round.candidates.length - points.length,
  };
}

function buildDominator(
  row: { candidate: CandidateImage; score: number; value: MetricValue },
  dominator: { candidate: CandidateImage; score: number },
  metric: QualityMetric,
): Dominator {
  const sizeDeltaPercent =
    ((row.candidate.fileSize - dominator.candidate.fileSize) / dominator.candidate.fileSize) * 100;
  const dominatorValue = dominator.candidate.metrics?.[metric.key];
  const bothLossless = row.value === 'inf' && dominatorValue === 'inf';
  // +∞ − +∞ 是 NaN，先比相等再算差值（两张无损图要算「画质相同」）。
  const qualitySame = row.score === dominator.score || Math.abs(row.score - dominator.score) <= EPSILON;
  let qualityDelta: number | null = null;
  if (!qualitySame && typeof row.value === 'number' && typeof dominatorValue === 'number') {
    qualityDelta = Math.abs(row.value - dominatorValue);
  }
  return {
    path: dominator.candidate.path,
    label: candidateLabel(dominator.candidate),
    sizeDeltaPercent,
    qualityDelta,
    qualitySame,
    bothLossless,
  };
}

/** 支配关系的一句话说明：`不如 JPEG q75：体积多 12%、画质低 0.62 dB`。 */
export function dominatorText(row: EfficiencyRow, metric: QualityMetric): string {
  const dominator = row.dominator;
  if (dominator === null) return '';
  const parts: string[] = [];
  if (dominator.sizeDeltaPercent >= 0.05) {
    parts.push(`体积多 ${dominator.sizeDeltaPercent.toFixed(1)}%`);
  } else {
    parts.push('体积相同');
  }
  if (dominator.qualitySame) {
    parts.push(dominator.bothLossless ? '画质相同（都无损）' : '画质相同');
  } else if (dominator.qualityDelta === null) {
    parts.push('画质更低');
  } else {
    const unit = metric.unit === null ? '' : ` ${metric.unit}`;
    const worse = metric.better === 'higher' ? '画质低' : '画质差';
    parts.push(`${worse} ${dominator.qualityDelta.toFixed(metric.decimals)}${unit}`);
  }
  return `不如 ${dominator.label}：${parts.join('、')}`;
}
