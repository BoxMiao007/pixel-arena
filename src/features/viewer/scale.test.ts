// 比例尺刻度单测：整数阶梯、屏幕宽度封顶、极端缩小的退让。

import { describe, it, expect } from 'vitest';
import { pickScaleTick } from './scale';

describe('pickScaleTick（工具栏比例尺）', () => {
  it('100% 时挑 50 px（72px 目标里最大的整数档）', () => {
    expect(pickScaleTick(1, 72)).toEqual({ pixels: 50, screenPx: 50 });
  });

  it('常用缩放下尺身接近目标宽度', () => {
    // 46.9% × 窄工具条：100 px 刚好压在 48px 目标附近
    expect(pickScaleTick(0.469, 48)).toEqual({ pixels: 100, screenPx: 47 });
    // 25%：200 px 刚好 50 屏幕像素
    expect(pickScaleTick(0.25, 72)).toEqual({ pixels: 200, screenPx: 50 });
  });

  it('极端缩小不再挑出超宽读数（2% 档位封顶）', () => {
    const tick = pickScaleTick(0.0201, 72);
    expect(tick).toEqual({ pixels: 2000, screenPx: 40 });
    expect(tick!.screenPx).toBeLessThanOrEqual(72);
  });

  it('任意缩放下尺身都不超过目标宽度（放大到 1 px 刻度仍超宽时除外）', () => {
    for (const zoom of [0.005, 0.01, 0.037, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 64]) {
      for (const target of [48, 72]) {
        const tick = pickScaleTick(zoom, target);
        expect(tick).not.toBeNull();
        // 放大倍率大于目标宽度时，最小刻度就是 1 个原始像素，物理上收不回来
        if (zoom <= target) expect(tick!.screenPx).toBeLessThanOrEqual(target);
        expect(tick!.pixels).toBeGreaterThan(0);
      }
    }
  });

  it('读数恒为 1 / 2 / 5 × 10ⁿ', () => {
    for (const zoom of [0.0123, 0.037, 0.155, 0.37, 0.63, 1, 1.7, 3.3]) {
      const { pixels } = pickScaleTick(zoom, 72)!;
      const mantissa = Number(pixels.toPrecision(1));
      expect([1, 2, 5, 10]).toContain(mantissa / 10 ** Math.floor(Math.log10(pixels)));
    }
  });

  it('非法输入返回 null（调用方据此隐藏比例尺）', () => {
    expect(pickScaleTick(0, 72)).toBeNull();
    expect(pickScaleTick(-1, 72)).toBeNull();
    expect(pickScaleTick(Number.NaN, 72)).toBeNull();
    expect(pickScaleTick(1, 0)).toBeNull();
  });
});
