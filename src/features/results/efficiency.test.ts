// 效率对比逻辑：指标选择、按体积排序、帕累托「划算」判定、支配说明、BD-rate 门槛。
//
// 这些用例锚定的是「少图也有结论」这件事：两张图就能判划算、一张图不硬判，
// 无损与低更优指标（Butteraugli）不能把方向搞反。

import { describe, expect, it } from 'vitest';
import type { CandidateImage, MetricValue, Round } from '../../core/model';
import {
  bdrateEligibility,
  buildEfficiencyTable,
  dominatorText,
  qualityMetricFor,
  qualityScore,
} from './efficiency';

interface CandidateOptions {
  params?: string | null;
  error?: string | null;
  metrics?: Record<string, MetricValue> | null;
  ratio?: number | null;
}

function candidate(
  path: string,
  fileSize: number,
  metrics: Record<string, MetricValue> | null,
  options: CandidateOptions = {},
): CandidateImage {
  return {
    path,
    fileSize,
    sizeRatio: options.ratio ?? null,
    metrics,
    encodingParams: options.params ?? null,
    error: options.error ?? null,
  };
}

function round(candidates: CandidateImage[]): Round {
  return {
    id: 'round-1',
    name: '轮 1',
    referencePath: '/r/ref.png',
    referenceSize: 1_000_000,
    candidates,
  };
}

describe('qualityScore', () => {
  it('越大越好的指标照原值，∞ 当 +Infinity', () => {
    expect(qualityScore(32.5, 'higher')).toBe(32.5);
    expect(qualityScore('inf', 'higher')).toBe(Number.POSITIVE_INFINITY);
  });

  it('越小越好的指标取负：Butteraugli 1.0 比 2.0 好', () => {
    expect(qualityScore(1.0, 'lower')).toBeGreaterThan(qualityScore(2.0, 'lower'));
  });
});

describe('qualityMetricFor', () => {
  it('优先 PSNR，即使同时有别的指标', () => {
    const metric = qualityMetricFor(
      round([candidate('/r/a.jpg', 1000, { PSNR: 30, SSIM: 0.9 })]),
    );
    expect(metric).toMatchObject({ key: 'PSNR', label: 'PSNR (dB)', unit: 'dB', better: 'higher' });
  });

  it('没有 PSNR 时按固定指标序回落到 SSIM', () => {
    const metric = qualityMetricFor(round([candidate('/r/a.webp', 1000, { SSIM: 0.92 })]));
    expect(metric).toMatchObject({ key: 'SSIM', unit: null, decimals: 4 });
  });

  it('失败与未跑分的候选不参与选指标', () => {
    expect(
      qualityMetricFor(
        round([
          candidate('/r/a.jpg', 1000, { PSNR: 30 }, { error: '解码失败' }),
          candidate('/r/b.jpg', 900, null),
        ]),
      ),
    ).toBeNull();
  });

  it('没有任何可比指标时返回 null', () => {
    expect(qualityMetricFor(round([candidate('/r/a.jpg', 1000, {})]))).toBeNull();
  });
});

describe('buildEfficiencyTable：排序与帕累托', () => {
  it('按体积升序，只有「更小且画质不低」的图才会被支配', () => {
    const table = buildEfficiencyTable(
      round([
        candidate('/r/jpeg_q75.jpg', 200_000, { PSNR: 34 }, { params: 'JPEG q75' }),
        candidate('/r/webp_q80.webp', 150_000, { PSNR: 33.5 }, { params: 'WebP q80' }),
        candidate('/r/avif_q70.avif', 120_000, { PSNR: 33 }, { params: 'AVIF q70' }),
        candidate('/r/webp_q95.webp', 400_000, { PSNR: 33.8 }, { params: 'WebP q95' }),
      ]),
    );
    expect(table).not.toBeNull();
    const view = table!;
    expect(view.metric.key).toBe('PSNR');
    expect(view.comparable).toBe(true);
    expect(view.rows.map((row) => row.path)).toEqual([
      '/r/avif_q70.avif',
      '/r/webp_q80.webp',
      '/r/jpeg_q75.jpg',
      '/r/webp_q95.webp',
    ]);
    // AVIF 最小、WebP q80 居中、JPEG 画质最高：三者都不可被支配。
    expect(view.rows.map((row) => row.frontier)).toEqual([true, true, true, false]);
    expect(view.frontierCount).toBe(3);
    // 被支配的那张取体积最接近的 JPEG 当对照（差 100% 体积、0.2 dB 画质）。
    const dominator = view.rows[3].dominator!;
    expect(dominator.path).toBe('/r/jpeg_q75.jpg');
    expect(dominator.label).toBe('JPEG q75');
    expect(dominator.sizeDeltaPercent).toBeCloseTo(100, 6);
    expect(dominator.qualityDelta).toBeCloseTo(0.2, 6);
  });

  it('只有一张图时不硬判划算，提示再加一张', () => {
    const view = buildEfficiencyTable(
      round([candidate('/r/a.jpg', 100_000, { PSNR: 30 }, { params: 'JPEG q75' })]),
    )!;
    expect(view.comparable).toBe(false);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].frontier).toBe(false);
    expect(view.rows[0].dominator).toBeNull();
    expect(dominatorText(view.rows[0], view.metric)).toBe('');
  });

  it('体积相同、画质更高同样算支配，说明写「体积相同」', () => {
    const view = buildEfficiencyTable(
      round([
        candidate('/r/a.jpg', 1000, { PSNR: 30.5 }, { params: 'JPEG q70' }),
        candidate('/r/b.webp', 1000, { PSNR: 31 }, { params: 'WebP q80' }),
      ]),
    )!;
    const dominated = view.rows.find((row) => row.path === '/r/a.jpg')!;
    expect(dominated.frontier).toBe(false);
    expect(dominatorText(dominated, view.metric)).toBe(
      '不如 WebP q80：体积相同、画质低 0.50 dB',
    );
  });

  it('两张无损图按体积判：小的划算，大的标注「都无损」', () => {
    const view = buildEfficiencyTable(
      round([
        candidate('/r/a.png', 120_000, { PSNR: 'inf' }, { params: 'PNG 无损' }),
        candidate('/r/b.jxl', 80_000, { PSNR: 'inf' }, { params: 'JXL 无损' }),
      ]),
    )!;
    expect(view.rows[0].path).toBe('/r/b.jxl');
    expect(view.rows.map((row) => row.frontier)).toEqual([true, false]);
    const png = view.rows[1];
    expect(png.dominator).toMatchObject({ qualitySame: true, bothLossless: true, qualityDelta: null });
    expect(dominatorText(png, view.metric)).toBe(
      '不如 JXL 无损：体积多 50.0%、画质相同（都无损）',
    );
  });

  it('越小越好的指标（Butteraugli）方向不能反', () => {
    const view = buildEfficiencyTable(
      round([
        candidate('/r/a.jpg', 100_000, { Butteraugli: 1.0 }, { params: 'JPEG q80' }),
        candidate('/r/b.webp', 120_000, { Butteraugli: 2.0 }, { params: 'WebP q90' }),
      ]),
    )!;
    expect(view.metric.key).toBe('Butteraugli');
    expect(view.metric.better).toBe('lower');
    expect(view.rows[0].frontier).toBe(true);
    const worse = view.rows[1];
    expect(worse.frontier).toBe(false);
    expect(dominatorText(worse, view.metric)).toBe(
      '不如 JPEG q80：体积多 20.0%、画质差 1.000',
    );
  });

  it('缺当前指标的图计入 skipped，不参与判定', () => {
    const view = buildEfficiencyTable(
      round([
        candidate('/r/a.jpg', 100_000, { PSNR: 30 }, { params: 'JPEG q75' }),
        candidate('/r/b.webp', 90_000, { SSIM: 0.9 }, { params: 'WebP q75' }),
        candidate('/r/c.avif', 80_000, null),
        candidate('/r/d.jxl', 70_000, { PSNR: 31 }, { error: '跑分失败' }),
      ]),
    )!;
    expect(view.rows.map((row) => row.path)).toEqual(['/r/a.jpg']);
    expect(view.skipped).toBe(3);
    expect(view.comparable).toBe(false);
  });
});

describe('bdrateEligibility', () => {
  function ladder(format: string, points: number[]): CandidateImage[] {
    return points.map((psnr, index) =>
      candidate(`/r/${format}_${index}.${format === 'JPEG' ? 'jpg' : format.toLowerCase()}`, 1000 + index, {
        PSNR: psnr,
      }),
    );
  }

  it('两个格式各 3 个有损点才开启', () => {
    const eligibility = bdrateEligibility(
      round([...ladder('JPEG', [30, 32, 34]), ...ladder('WebP', [31, 33, 35])]),
    );
    expect(eligibility.enabled).toBe(true);
    expect(eligibility.counts).toEqual([
      { format: 'JPEG', points: 3 },
      { format: 'WebP', points: 3 },
    ]);
    expect(eligibility.maxPoints).toBe(3);
  });

  it('只有一个格式够点时不开启，并给出本轮最多点数', () => {
    const eligibility = bdrateEligibility(
      round([...ladder('JPEG', [30, 32, 34]), ...ladder('WebP', [31, 33])]),
    );
    expect(eligibility.enabled).toBe(false);
    expect(eligibility.maxPoints).toBe(3);
  });

  it('无损点（PSNR = ∞）不算进拟合', () => {
    const eligibility = bdrateEligibility(
      round([
        ...ladder('JPEG', [30, 32, 34]),
        ...ladder('WebP', [31, 33, 35]),
        candidate('/r/a.png', 5000, { PSNR: 'inf' }),
      ]),
    );
    expect(eligibility.enabled).toBe(true);
    expect(eligibility.counts.find((entry) => entry.format === 'PNG')).toBeUndefined();
  });

  it('失败与未跑分的图不计点', () => {
    const eligibility = bdrateEligibility(
      round([
        ...ladder('JPEG', [30, 32, 34]),
        candidate('/r/webp_0.webp', 1000, { PSNR: 31 }, { error: '编码失败' }),
        candidate('/r/webp_1.webp', 1000, null),
      ]),
    );
    expect(eligibility.enabled).toBe(false);
    expect(eligibility.maxPoints).toBe(3);
  });
});