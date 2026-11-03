// 阶梯矩阵与目标大小滑杆的纯逻辑测试（决策 0042）。
//
// 关键不变量：
// - 预览的 plan 就是生成入参，项数与界面一致；
// - 未勾选的格式仍出现在 rows 里（灰显），不会因为取消而消失；
// - 目标大小方式未探测时没有可生成的清单；单格式失败不吞掉其余格式；
// - 对数滑杆两端精确、单调、往返误差小。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  SIZE_SLIDER_MAX_BYTES,
  SIZE_SLIDER_MIN_BYTES,
  SIZE_SLIDER_STEPS,
  buildLadderPreview,
  bytesFromSlider,
  initOnestopCatalog,
  ladderRunSplit,
  sliderFromBytes,
  type LadderItem,
  type OnestopSelection,
  type SizeSearchOutcome,
} from './ladder';

const invokeMock = vi.mocked(invoke);

const catalog = {
  lossyFormats: [
    { format: 'jpeg', label: 'JPEG' },
    { format: 'webp', label: 'WebP' },
    { format: 'avif', label: 'AVIF' },
    { format: 'jxl', label: 'JPEG XL' },
  ],
  losslessFormats: [
    { format: 'png', label: 'PNG' },
    { format: 'webp-lossless', label: '无损 WebP' },
    { format: 'jxl-lossless', label: '无损 JXL' },
  ],
};

/** 与核心库 quality_ladder(75) 输出一致的桩阶梯（15 项）。 */
const fullLadder: LadderItem[] = [
  { format: 'jpeg', quality: 60, label: 'JPEG q60' },
  { format: 'jpeg', quality: 75, label: 'JPEG q75' },
  { format: 'jpeg', quality: 90, label: 'JPEG q90' },
  { format: 'webp', quality: 60, label: 'WebP q60' },
  { format: 'webp', quality: 75, label: 'WebP q75' },
  { format: 'webp', quality: 90, label: 'WebP q90' },
  { format: 'avif', quality: 60, label: 'AVIF q60' },
  { format: 'avif', quality: 75, label: 'AVIF q75' },
  { format: 'avif', quality: 90, label: 'AVIF q90' },
  { format: 'jxl', quality: 60, label: 'JPEG XL q60' },
  { format: 'jxl', quality: 75, label: 'JPEG XL q75' },
  { format: 'jxl', quality: 90, label: 'JPEG XL q90' },
  { format: 'png', quality: null, label: 'PNG' },
  { format: 'webp-lossless', quality: null, label: '无损 WebP' },
  { format: 'jxl-lossless', quality: null, label: '无损 JXL' },
];

/** 单点方式：每有损格式只压基准那一档（JXL 夹到 95）。 */
const singleLadder: LadderItem[] = [
  { format: 'jpeg', quality: 75, label: 'JPEG q75' },
  { format: 'webp', quality: 75, label: 'WebP q75' },
  { format: 'avif', quality: 75, label: 'AVIF q75' },
  { format: 'jxl', quality: 95, label: 'JPEG XL q95' },
  { format: 'png', quality: null, label: 'PNG' },
  { format: 'webp-lossless', quality: null, label: '无损 WebP' },
  { format: 'jxl-lossless', quality: null, label: '无损 JXL' },
];

const lossyAll: OnestopSelection = {
  lossyFormats: ['jpeg', 'webp', 'avif', 'jxl'],
  losslessFormats: [],
};

function sizeOutcome(format: string, hitQuality = 74): SizeSearchOutcome {
  const low = Math.max(1, hitQuality - 10);
  const high = Math.min(100, hitQuality + 10);
  return {
    format,
    targetBytes: 200 * 1024,
    hitQuality,
    hitBytes: 204800,
    note: null,
    points: [
      { quality: low, bytes: 150000 },
      { quality: hitQuality, bytes: 204800 },
      { quality: high, bytes: 260000 },
    ],
  };
}

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(catalog);
  await initOnestopCatalog();
});

describe('buildLadderPreview：单点与阶梯', () => {
  it('单点：四个有损格式各一格，无损行常驻但未勾选', () => {
    const preview = buildLadderPreview({
      mode: 'single',
      selection: lossyAll,
      ladder: singleLadder,
      sizeOutcomes: {},
      sizeErrors: {},
    });
    expect(preview.rows).toHaveLength(7);
    expect(preview.count).toBe(4);
    expect(preview.plan.map((item) => item.label)).toEqual([
      'JPEG q75',
      'WebP q75',
      'AVIF q75',
      'JPEG XL q95',
    ]);
    expect(preview.rows[0].cells.map((cell) => cell.text)).toEqual(['q75']);
    expect(preview.rows[3].cells.map((cell) => cell.text)).toEqual(['q95']);
    expect(preview.rows[4].selected).toBe(false);
    expect(preview.rows[4].cells.map((cell) => cell.text)).toEqual(['无损']);
  });

  it('阶梯：每格式三格；勾选无损后清单追加三项', () => {
    const preview = buildLadderPreview({
      mode: 'ladder',
      selection: lossyAll,
      ladder: fullLadder,
      sizeOutcomes: {},
      sizeErrors: {},
    });
    expect(preview.count).toBe(12);
    expect(preview.rows[0].cells.map((cell) => cell.text)).toEqual(['q60', 'q75', 'q90']);

    const withLossless = buildLadderPreview({
      mode: 'ladder',
      selection: { ...lossyAll, losslessFormats: ['png', 'webp-lossless', 'jxl-lossless'] },
      ladder: fullLadder,
      sizeOutcomes: {},
      sizeErrors: {},
    });
    expect(withLossless.count).toBe(15);
    expect(withLossless.plan.slice(-3).map((item) => item.label)).toEqual([
      'PNG',
      '无损 WebP',
      '无损 JXL',
    ]);
  });

  it('取点还没回来时：勾选行标待取点，清单为空；未勾选行不参与', () => {
    const preview = buildLadderPreview({
      mode: 'ladder',
      selection: { lossyFormats: ['jpeg'], losslessFormats: [] },
      ladder: null,
      sizeOutcomes: {},
      sizeErrors: {},
    });
    expect(preview.count).toBe(0);
    expect(preview.rows[0].pending).toBe(true);
    expect(preview.rows[1].pending).toBe(false);
    expect(preview.rows[1].selected).toBe(false);
  });

  it('已有同档位：已跑分标跳过、缺指标标补跑分；重新生成时全部按新项', () => {
    const base = {
      mode: 'ladder' as const,
      selection: lossyAll,
      ladder: fullLadder,
      sizeOutcomes: {},
      sizeErrors: {},
    };
    const scored = buildLadderPreview({
      ...base,
      existingCandidates: [
        { path: '/out/j75.jpg', encodingParams: 'JPEG q75', scored: true },
        { path: '/out/w60.webp', encodingParams: 'WebP q60', scored: true },
      ],
    });
    expect(scored.count).toBe(12);
    expect(scored.existingCount).toBe(2);
    expect(scored.skipCount).toBe(2);
    expect(scored.rescoreCount).toBe(0);
    expect(scored.newCount).toBe(10);
    expect(scored.entries.find((entry) => entry.item.label === 'JPEG q75')?.status).toBe('scored');
    expect(scored.rows[0].cells.find((cell) => cell.text === 'q75')?.existing).toBe('scored');

    const unscored = buildLadderPreview({
      ...base,
      existingCandidates: [{ path: '/out/j75.jpg', encodingParams: 'JPEG q75', scored: false }],
    });
    expect(unscored.rescoreCount).toBe(1);
    expect(unscored.skipCount).toBe(0);
    expect(unscored.entries.find((entry) => entry.item.label === 'JPEG q75')?.existingPath).toBe(
      '/out/j75.jpg',
    );

    const forced = buildLadderPreview({
      ...base,
      existingCandidates: [
        { path: '/out/j75.jpg', encodingParams: 'JPEG q75', scored: true },
        { path: '/out/w60.webp', encodingParams: 'WebP q60', scored: true },
      ],
      regenerateExisting: true,
    });
    expect(forced.newCount).toBe(12);
    expect(forced.skipCount).toBe(0);
    expect(forced.rescoreCount).toBe(0);
    expect(forced.existingCount).toBe(2);
    expect(forced.rows[0].cells.find((cell) => cell.text === 'q75')?.existing).toBeNull();
  });

  it('ladderRunSplit：拆出要生成的新档位与只补跑分的已有路径', () => {
    const preview = buildLadderPreview({
      mode: 'ladder',
      selection: lossyAll,
      ladder: fullLadder,
      sizeOutcomes: {},
      sizeErrors: {},
      existingCandidates: [
        { path: '/out/j75.jpg', encodingParams: 'JPEG q75', scored: true },
        { path: '/out/w60.webp', encodingParams: 'WebP q60', scored: false },
      ],
    });
    const split = ladderRunSplit(preview);
    expect(split.items).toHaveLength(10);
    expect(split.items.some((item) => item.label === 'JPEG q75')).toBe(false);
    expect(split.items.some((item) => item.label === 'WebP q60')).toBe(false);
    expect(split.rescorePaths).toEqual(['/out/w60.webp']);
  });
});

describe('buildLadderPreview：目标大小', () => {
  it('未探测：清单为空、四个格式待探测；探测完成后按格式展开三点并标命中', () => {
    const pending = buildLadderPreview({
      mode: 'size',
      selection: lossyAll,
      ladder: null,
      sizeOutcomes: {},
      sizeErrors: {},
    });
    expect(pending.count).toBe(0);
    expect(pending.pendingFormats).toEqual(['jpeg', 'webp', 'avif', 'jxl']);
    expect(pending.rows[0].pending).toBe(true);

    const outcomes = {
      jpeg: sizeOutcome('jpeg', 74),
      webp: sizeOutcome('webp', 70),
      avif: sizeOutcome('avif', 65),
      jxl: sizeOutcome('jxl', 80),
    };
    const done = buildLadderPreview({
      mode: 'size',
      selection: lossyAll,
      ladder: null,
      sizeOutcomes: outcomes,
      sizeErrors: {},
    });
    expect(done.count).toBe(12);
    expect(done.pendingFormats).toEqual([]);
    expect(done.rows[0].cells).toHaveLength(3);
    expect(done.rows[0].cells.find((cell) => cell.hit)?.text).toBe('q74');
    expect(done.rows[0].cells.find((cell) => cell.hit)?.bytes).toBe(204800);
  });

  it('单格式失败：记进 failedFormats，其余格式仍可生成；未探测的进 pending', () => {
    const preview = buildLadderPreview({
      mode: 'size',
      selection: lossyAll,
      ladder: null,
      sizeOutcomes: { jpeg: sizeOutcome('jpeg') },
      sizeErrors: { webp: '探测失败：编码器不可用' },
    });
    expect(preview.failedFormats).toEqual(['webp']);
    expect(preview.pendingFormats).toEqual(['avif', 'jxl']);
    expect(preview.count).toBe(3);
    expect(preview.rows[1].error).toContain('编码器不可用');
    expect(preview.rows[1].pending).toBe(false);
  });

  it('不可达标注随行展示，清单仍是三个点', () => {
    const outcome = {
      ...sizeOutcome('jpeg', 5),
      note: '目标 1024 字节过小不可达，已取最接近点 q5（实际 204800 字节）',
    };
    const preview = buildLadderPreview({
      mode: 'size',
      selection: { lossyFormats: ['jpeg'], losslessFormats: [] },
      ladder: null,
      sizeOutcomes: { jpeg: outcome },
      sizeErrors: {},
    });
    expect(preview.rows[0].note).toContain('不可达');
    expect(preview.plan.map((item) => item.label)).toEqual([
      'JPEG q1',
      'JPEG q5',
      'JPEG q15',
    ]);
  });
});

describe('目标大小滑杆（对数刻度）', () => {
  it('两端精确、方向单调', () => {
    expect(bytesFromSlider(0)).toBe(SIZE_SLIDER_MIN_BYTES);
    expect(bytesFromSlider(SIZE_SLIDER_STEPS)).toBe(SIZE_SLIDER_MAX_BYTES);
    expect(sliderFromBytes(SIZE_SLIDER_MIN_BYTES)).toBe(0);
    expect(sliderFromBytes(SIZE_SLIDER_MAX_BYTES)).toBe(SIZE_SLIDER_STEPS);

    let previous = 0;
    for (let position = 0; position <= SIZE_SLIDER_STEPS; position += 50) {
      const bytes = bytesFromSlider(position);
      expect(bytes).toBeGreaterThanOrEqual(previous);
      previous = bytes;
    }
  });

  it('往返误差小于 2%，越界值夹到两端', () => {
    for (const bytes of [1024, 8 * 1024, 200 * 1024, 2 * 1024 * 1024, 20 * 1024 * 1024]) {
      const roundTrip = bytesFromSlider(sliderFromBytes(bytes));
      expect(Math.abs(roundTrip - bytes) / bytes).toBeLessThan(0.02);
    }
    expect(sliderFromBytes(1)).toBe(0);
    expect(sliderFromBytes(SIZE_SLIDER_MAX_BYTES * 2)).toBe(SIZE_SLIDER_STEPS);
  });
});
