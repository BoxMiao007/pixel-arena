// 「判断徽标」判定的单测：期望值按注释里的口径独立演算，不复用实现里的公式。

import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_LABELS, highlightChips } from './highlight';
import type { CandidateImage } from './model';

function candidate(
  path: string,
  fileSize: number,
  metrics: Record<string, number> | null,
  error: string | null = null,
): CandidateImage {
  return { path, fileSize, sizeRatio: null, metrics, error };
}

function kindsOf(chips: Map<string, { kind: string }[]>, path: string): string[] {
  return (chips.get(path) ?? []).map((chip) => chip.kind);
}

describe('highlightChips', () => {
  it('少于两张可比较的图时不给任何徽标（没有比较对象）', () => {
    expect(highlightChips([]).size).toBe(0);
    expect(highlightChips([candidate('a.jpg', 1000, { SSIM: 0.9 })]).size).toBe(0);
  });

  it('失败行与未跑分行不参与比较', () => {
    const chips = highlightChips([
      candidate('ok-a.jpg', 1000, { SSIM: 0.9, PSNR: 40 }),
      candidate('ok-b.jpg', 4000, { SSIM: 0.8, PSNR: 38 }),
      candidate('ok-c.jpg', 600, { SSIM: 0.7, PSNR: 36 }),
      candidate('failed.jpg', 10, { SSIM: 0.99 }, '编码失败'),
      candidate('unscored.jpg', 20, null),
    ]);
    // 体积最小落在 ok-c（failed 虽然更小，但不参与）
    expect(kindsOf(chips, 'ok-c.jpg')).toContain('size');
    expect(chips.has('failed.jpg')).toBe(false);
    expect(chips.has('unscored.jpg')).toBe(false);
  });

  it('画质最好按 SSIMULACRA2 > SSIM > MS-SSIM > PSNR 的优先级选指标', () => {
    const ssimOnly = highlightChips([
      candidate('a.jpg', 1000, { SSIM: 0.91, PSNR: 30 }),
      candidate('b.jpg', 2000, { SSIM: 0.95, PSNR: 28 }),
    ]);
    expect(kindsOf(ssimOnly, 'b.jpg')).toContain('quality');
    expect(ssimOnly.get('b.jpg')?.find((chip) => chip.kind === 'quality')?.detail).toContain('SSIM');

    const withSsimulacra = highlightChips([
      candidate('a.jpg', 1000, { SSIM: 0.95, SSIMULACRA2: 70 }),
      candidate('b.jpg', 2000, { SSIM: 0.90, SSIMULACRA2: 82 }),
    ]);
    // PSNR 不在场时 SSIMULACRA2 优先于 SSIM：b 画质最好（SSIM 更低也一样）
    expect(kindsOf(withSsimulacra, 'b.jpg')).toContain('quality');
  });

  it('画质并列时用更小的体积定赢家', () => {
    const chips = highlightChips([
      candidate('big.jpg', 9000, { SSIM: 0.95 }),
      candidate('small.jpg', 3000, { SSIM: 0.95 }),
      candidate('weak.jpg', 500, { SSIM: 0.5 }),
    ]);
    expect(kindsOf(chips, 'small.jpg')).toContain('quality');
    expect(kindsOf(chips, 'big.jpg')).not.toContain('quality');
  });

  it('体积最小按字节数判定，不问体积比', () => {
    const chips = highlightChips([
      candidate('tiny.jpg', 120 * 1024, { SSIM: 0.7 }),
      candidate('large.jpg', 4 * 1024 * 1024, { SSIM: 0.9 }),
    ]);
    expect(kindsOf(chips, 'tiny.jpg')).toContain('size');
    expect(chips.get('tiny.jpg')?.find((chip) => chip.kind === 'size')?.detail).toContain('120.0 KB');
  });

  it('综合最优偏向「画质不太差且明显更小」的那张，而不是两个极端', () => {
    // 三张：画质最好但很大 / 体积最小但很糊 / 中间档。
    // 归一化后中间档 0.6*0.5 + 0.4*1 ≈ 0.7，画质最好 0.6*1 + 0.4*~0 ≈ 0.6，
    // 体积最小 0.6*0 + 0.4*(对数归一化后接近 1) ≈ 0.4。
    const chips = highlightChips([
      candidate('best.jpg', 4 * 1024 * 1024, { SSIM: 0.96 }),
      candidate('middle.jpg', 900 * 1024, { SSIM: 0.90 }),
      candidate('small.jpg', 200 * 1024, { SSIM: 0.62 }),
    ]);
    expect(kindsOf(chips, 'middle.jpg')).toContain('balanced');
  });

  it('每张图最多两枚徽标，优先级 综合最优 > 画质最好 > 体积最小', () => {
    // a 同时拿下三项：b 与 a 同体积、画质略低，c 更小但很糊。
    // a 的综合分最高，所以前两枚是 综合最优 + 画质最好，体积徽标被挤掉。
    const chips = highlightChips([
      candidate('a.jpg', 1000, { SSIM: 0.97 }),
      candidate('b.jpg', 1000, { SSIM: 0.96 }),
      candidate('c.jpg', 1500, { SSIM: 0.5 }),
    ]);
    const list = chips.get('a.jpg') ?? [];
    expect(list.length).toBeLessThanOrEqual(2);
    expect(list.map((chip) => chip.kind)).toEqual(['balanced', 'quality']);
  });

  it('PSNR 为 "inf"（两图完全一致）按最高画质处理', () => {
    const chips = highlightChips([
      { path: 'identical.jpg', fileSize: 2048, sizeRatio: 1, metrics: { PSNR: 'inf' }, error: null },
      candidate('lossy.jpg', 1024, { PSNR: 35 }),
    ]);
    expect(kindsOf(chips, 'identical.jpg')).toContain('quality');
    expect(chips.get('identical.jpg')?.find((chip) => chip.kind === 'quality')?.detail).toContain('∞');
  });

  it('徽标文案与种类一一对应，说明里带具体数值', () => {
    const chips = highlightChips([
      candidate('a.jpg', 1000, { SSIM: 0.9 }),
      candidate('b.jpg', 2000, { SSIM: 0.8 }),
    ]);
    for (const list of chips.values()) {
      for (const chip of list) {
        expect(chip.label).toBe(HIGHLIGHT_LABELS[chip.kind]);
        expect(chip.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('只有体积列（没有画质指标）时综合最优退化为体积效率，且不出画质徽标', () => {
    const chips = highlightChips([
      candidate('a.jpg', 1000, { Foo: 1 }),
      candidate('b.jpg', 2000, { Foo: 2 }),
    ]);
    expect([...chips.values()].flat().some((chip) => chip.kind === 'quality')).toBe(false);
    expect(kindsOf(chips, 'a.jpg')).toContain('size');
    expect(kindsOf(chips, 'a.jpg')).toContain('balanced');
  });
});
