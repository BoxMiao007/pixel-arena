// 缩放读数与步进单测：百分比文案、键盘步进倍数。

import { describe, it, expect } from 'vitest';
import { ZOOM_PRESETS, ZOOM_STEP, formatZoomPercent, steppedZoom } from './zoom';

describe('formatZoomPercent（工具栏读数）', () => {
  it('≥100% 取整显示', () => {
    expect(formatZoomPercent(1)).toBe('100%');
    expect(formatZoomPercent(2.5)).toBe('250%');
    expect(formatZoomPercent(64)).toBe('6400%');
  });

  it('10%~99% 保留一位小数并去掉多余的 .0', () => {
    expect(formatZoomPercent(0.5)).toBe('50%');
    expect(formatZoomPercent(0.125)).toBe('12.5%');
    expect(formatZoomPercent(0.37)).toBe('37%');
    expect(formatZoomPercent(0.1)).toBe('10%');
  });

  it('<10% 保留两位小数（总览超大图时可读）', () => {
    expect(formatZoomPercent(0.01)).toBe('1%');
    expect(formatZoomPercent(0.025)).toBe('2.5%');
    expect(formatZoomPercent(0.0999)).toBe('9.99%');
  });

  it('非法值不产出 NaN 文案', () => {
    expect(formatZoomPercent(0)).toBe('0%');
    expect(formatZoomPercent(Number.NaN)).toBe('0%');
    expect(formatZoomPercent(-2)).toBe('0%');
  });
});

describe('steppedZoom（+/- 与键盘步进）', () => {
  it('放大 1.25 倍、缩小回到原值（连续一进一出不漂移）', () => {
    const enlarged = steppedZoom(1, 1);
    expect(enlarged).toBeCloseTo(1.25);
    expect(steppedZoom(enlarged, -1)).toBeCloseTo(1);
    expect(ZOOM_STEP).toBeCloseTo(1.25);
  });

  it('窄缩放下每档仍是乘性的（不会变成加性）', () => {
    expect(steppedZoom(0.1, 1)).toBeCloseTo(0.125);
    expect(steppedZoom(0.1, -1)).toBeCloseTo(0.08);
  });
});

describe('ZOOM_PRESETS（缩放菜单档位）', () => {
  it('给出 25% / 50% / 100% / 200% / 400% 五档且升序', () => {
    expect(ZOOM_PRESETS).toEqual([0.25, 0.5, 1, 2, 4]);
  });
});
