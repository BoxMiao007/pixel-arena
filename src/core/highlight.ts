// 本轮「判断徽标」：从跑分图的指标里挑出画质最好 / 体积最小 / 综合最优的那几张。
//
// 放在 core 是因为三处界面都要用同一份判定：结果表行、检视器「跑分图」列表、
// 多视图每格角标。判定口径一旦分叉，用户会在两个地方看到互相矛盾的「最好」。
//
// 口径（都是纯函数，由 highlight.test.ts 钉死）：
// - 只参与「跑分成功且拿到指标」的行：失败行、未跑分行不进比较；
// - 画质最好 = 本轮可用的感知指标里最有代表性的那一列的最大值。优先级
//   SSIMULACRA2 > SSIM > MS-SSIM > PSNR（感知指标优先，PSNR 只作兜底）；
// - 体积最小 = fileSize 最小（体积比与 fileSize 同向，用字节更直接）；
// - 综合最优 = 画质归一化 ×0.6 + 体积效率 ×0.4。体积按对数归一化：一轮里
//   几百 KB 到几 MB 的差距是数量级差，线性归一化会让「小格式」无脑赢；
// - 至少两张图才有比较意义，单张（或没有）返回空；并列时按「体积更小 → 画质更高
//   → 路径字典序」定唯一赢家，避免同一顶帽子扣给多行；
// - 每张图最多两枚徽标，顺序 综合最优 > 画质最好 > 体积最小：综合赢家通常就是
//   想要的那张，画质/体积两极再各挂一枚，三顶帽子扣在同一行只会显得吵。
//
// 徽标只表达「本轮相对最好」，不是绝对标准：全部图都很糊时，「画质最好」照样成立。

import { formatMetric, formatSize } from './format';
import type { CandidateImage, MetricValue } from './model';

/** 徽标种类（稳定 id：界面排序、ARIA 文案、测试都按它指认）。 */
export type HighlightKind = 'quality' | 'size' | 'balanced';

/** 种类 → 界面短文案。 */
export const HIGHLIGHT_LABELS: Record<HighlightKind, string> = {
  quality: '画质最好',
  size: '体积最小',
  balanced: '综合最优',
};

/** 一枚徽标：短文案 + 悬浮说明（说明里带具体数值，便于核对）。 */
export interface HighlightChip {
  kind: HighlightKind;
  label: string;
  detail: string;
}

/** 画质指标的取舍顺序：感知指标优先，PSNR 只作兜底。 */
const QUALITY_PRIORITY: readonly string[] = ['SSIMULACRA2', 'SSIM', 'MS-SSIM', 'PSNR'];

/** 综合评分里画质的权重（剩下的给体积效率）。 */
const QUALITY_WEIGHT = 0.6;

/** 内部算出来的数值 → 展示用的 MetricValue（∞ 哨兵还原成 'inf'，toFixed 不认 Infinity）。 */
function displayValue(value: number): MetricValue {
  return Number.isFinite(value) ? value : 'inf';
}

function numeric(value: MetricValue | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  if (value === 'inf') return Number.POSITIVE_INFINITY;
  return Number.isFinite(value) ? value : null;
}

/** 两张以上都有值的指标里，按优先级挑第一个能用的画质列；都没有时返回 null。 */
function pickQualityKey(scored: readonly CandidateImage[]): string | null {
  for (const key of QUALITY_PRIORITY) {
    const present = scored.filter((candidate) => numeric(candidate.metrics?.[key]) !== null);
    if (present.length >= 2) return key;
  }
  return null;
}

/** 本轮该指标的最小 / 最大值（只用有值的行；∞ 哨兵不参与区间，单独在 normalize 里判满分）。 */
function rangeOf(scored: readonly CandidateImage[], read: (candidate: CandidateImage) => number | null): { min: number; max: number } | null {
  const values = scored
    .map(read)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 归一化到 0~1；上下界相同时一律给 1（「同样好」，不因除零变成 NaN）。
 *  PSNR 的 ∞ 哨兵会出现在上下界里：∞ 视为该列的满分（1），其余有限值按区间归一化。 */
function normalize(value: number, range: { min: number; max: number } | null): number {
  if (!range) return 0;
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  if (!(range.max > range.min) || !Number.isFinite(range.max - range.min)) {
    return Number.isFinite(value) ? 1 : 0;
  }
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return (clamped - range.min) / (range.max - range.min);
}

/** 对数归一化：体积差是数量级差，线性归一化会把小格式直接抬成综合最优。 */
function logSize(bytes: number): number {
  return Math.log(Math.max(1, bytes));
}

interface Scored {
  candidate: CandidateImage;
  quality: number | null;
  /** 综合分（0~1）；没有画质列时退化为「体积效率」。 */
  balance: number;
}

function scoreOf(scored: readonly CandidateImage[], qualityKey: string | null): Scored[] {
  const qualityRange = qualityKey ? rangeOf(scored, (c) => numeric(c.metrics?.[qualityKey])) : null;
  const sizeRange = rangeOf(scored, (c) => logSize(c.fileSize));
  return scored.map((candidate) => {
    const quality = qualityKey ? numeric(candidate.metrics?.[qualityKey]) : null;
    const sizeEfficiency = 1 - normalize(logSize(candidate.fileSize), sizeRange);
    const balance =
      quality === null
        ? sizeEfficiency
        : QUALITY_WEIGHT * normalize(quality, qualityRange) + (1 - QUALITY_WEIGHT) * sizeEfficiency;
    return { candidate, quality, balance };
  });
}

/** 并列时的唯一赢家：体积更小 → 画质更高（越大越好）→ 路径字典序。 */
function pickWinner(rows: readonly Scored[]): Scored {
  return [...rows].sort((a, b) => {
    if (a.candidate.fileSize !== b.candidate.fileSize) return a.candidate.fileSize - b.candidate.fileSize;
    const qa = a.quality ?? Number.NEGATIVE_INFINITY;
    const qb = b.quality ?? Number.NEGATIVE_INFINITY;
    if (qa !== qb) return qa === qb ? 0 : qb - qa;
    return a.candidate.path.localeCompare(b.candidate.path, 'zh-CN');
  })[0]!;
}

function topBy(rows: readonly Scored[], value: (row: Scored) => number): Scored[] {
  const best = Math.max(...rows.map(value));
  if (!Number.isFinite(best)) return rows.filter((row) => value(row) === best);
  return rows.filter((row) => Math.abs(value(row) - best) <= Number.EPSILON * Math.max(1, Math.abs(best)));
}

/**
 * 本轮每张跑分图的徽标（路径 → 徽标，最多两枚）。
 * 少于两张可比较的跑分图时返回空 Map（没有比较对象就没有「最好」）。
 */
export function highlightChips(candidates: readonly CandidateImage[]): Map<string, HighlightChip[]> {
  const chips = new Map<string, HighlightChip[]>();
  const scoredCandidates = candidates.filter(
    (candidate) => candidate.error === null && candidate.metrics !== null,
  );
  if (scoredCandidates.length < 2) return chips;

  const qualityKey = pickQualityKey(scoredCandidates);
  const rows = scoreOf(scoredCandidates, qualityKey);

  const winners: Array<{ row: Scored; chip: HighlightChip }> = [];

  if (qualityKey) {
    const qualityRows = topBy(
      rows.filter((row) => row.quality !== null),
      (row) => row.quality ?? Number.NEGATIVE_INFINITY,
    );
    if (qualityRows.length > 0) {
      const row = pickWinner(qualityRows);
      const value = row.quality ?? 0;
      winners.push({
        row,
        chip: {
          kind: 'quality',
          label: HIGHLIGHT_LABELS.quality,
          detail: `画质最好：${qualityKey} ${formatMetric(displayValue(value))}，本轮最高`,
        },
      });
    }
  }

  const sizeWinner = pickWinner(topBy(rows, (row) => -row.candidate.fileSize));
  winners.push({
    row: sizeWinner,
    chip: {
      kind: 'size',
      label: HIGHLIGHT_LABELS.size,
      detail: `体积最小：${formatSize(sizeWinner.candidate.fileSize)}，本轮最小`,
    },
  });

  const balanceWinner = pickWinner(topBy(rows, (row) => row.balance));
  winners.push({
    row: balanceWinner,
    chip: {
      kind: 'balanced',
      label: HIGHLIGHT_LABELS.balanced,
      detail: qualityKey
        ? `综合最优：${qualityKey} ${formatMetric(displayValue(balanceWinner.quality ?? 0))}、${formatSize(balanceWinner.candidate.fileSize)}，画质与体积综合得分本轮最高`
        : `综合最优：${formatSize(balanceWinner.candidate.fileSize)}，本轮体积效率最高`,
    },
  });

  // 每张图最多两枚：综合 > 画质 > 体积（见文件头注释）。
  const rank: Record<HighlightKind, number> = { balanced: 0, quality: 1, size: 2 };
  for (const { row, chip } of winners.sort((a, b) => rank[a.chip.kind] - rank[b.chip.kind])) {
    const list = chips.get(row.candidate.path) ?? [];
    if (list.length >= 2) continue;
    list.push(chip);
    chips.set(row.candidate.path, list);
  }
  return chips;
}
