// 像素探针纯逻辑单测：坐标换算、亮度、差值、读数文案、采样缓存键。
// 采样本身（getImageData）依赖 canvas，不做 DOM 单测；这里只守住会算错的部分。

import { describe, it, expect } from 'vitest';
import {
  deltaOf,
  formatProbe,
  formatProbeDetail,
  luminance,
  pixelAt,
  probeKey,
  type ProbeReading,
} from './probe';

describe('pixelAt（屏幕坐标 → 图片整像素）', () => {
  const pane = { width: 400, height: 300 };

  it('视口中心对应的屏幕点落在图片中心像素', () => {
    const vp = { centerX: 1000, centerY: 750, zoom: 1 };
    expect(pixelAt(vp, pane, 200, 150, { width: 2000, height: 1500 })).toEqual({ x: 1000, y: 750 });
  });

  it('屏幕左上角按视口反算，取整到像素（向下取整，落进哪个像素就报哪个）', () => {
    // zoom=2、中心 (100,100)、窗格 400x300：屏幕 (3,3) → 图片 (100 + (3-200)/2, 100 + (3-150)/2) = (1.5, 26.5)
    const vp = { centerX: 100, centerY: 100, zoom: 2 };
    expect(pixelAt(vp, pane, 3, 3, { width: 2000, height: 1500 })).toEqual({ x: 1, y: 26 });
  });

  it('视口平移到图片外时返回 null（不显示越界读数）', () => {
    const vp = { centerX: 0, centerY: 0, zoom: 1 };
    expect(pixelAt(vp, pane, 0, 0, { width: 2000, height: 1500 })).toBeNull();
  });

  it('边界：图片右下角最后一个像素有效，宽/高本身越界', () => {
    const vp = { centerX: 1999, centerY: 1499, zoom: 1 };
    expect(pixelAt(vp, pane, 200, 150, { width: 2000, height: 1500 })).toEqual({ x: 1999, y: 1499 });
    // 再往右下 200/150 屏幕像素 → 图片坐标 (2199, 1649)：正好是 2200×1650 的最后一格
    expect(pixelAt(vp, pane, 400, 300, { width: 2200, height: 1650 })).toEqual({ x: 2199, y: 1649 });
    expect(pixelAt(vp, pane, 400, 300, { width: 2199, height: 1649 })).toBeNull();
  });

  it('非法输入（0 缩放/0 尺寸图片）返回 null，不产生 NaN 坐标', () => {
    expect(pixelAt({ centerX: 10, centerY: 10, zoom: 0 }, pane, 10, 10, { width: 100, height: 100 })).toBeNull();
    expect(pixelAt({ centerX: 10, centerY: 10, zoom: 1 }, pane, 10, 10, { width: 0, height: 0 })).toBeNull();
  });
});

describe('luminance / deltaOf（与差异图同一套亮度口径）', () => {
  it('亮度公式 L = 0.299R + 0.587G + 0.114B', () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(255);
    expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(luminance({ r: 100, g: 100, b: 100 })).toBeCloseTo(100);
  });

  it('差值 = 跑分图 - 原图，含亮度差（一位小数）', () => {
    const delta = deltaOf({ r: 10, g: 20, b: 30 }, { r: 15, g: 18, b: 40 });
    expect(delta.dr).toBe(5);
    expect(delta.dg).toBe(-2);
    expect(delta.db).toBe(10);
    // 亮度差 = L(15,18,40) - L(10,20,30) = (4.485+10.566+4.56) - (2.99+11.74+3.42) = 19.611 - 18.15 = 1.461 → 1.5
    expect(delta.dl).toBe(1.5);
  });

  it('完全相同的像素差值为 0', () => {
    const delta = deltaOf({ r: 7, g: 8, b: 9 }, { r: 7, g: 8, b: 9 });
    expect(delta).toEqual({ dr: 0, dg: 0, db: 0, dl: 0 });
  });
});

describe('读数文案', () => {
  const withDelta: ProbeReading = {
    x: 12,
    y: 34,
    ref: { r: 10, g: 20, b: 30 },
    cand: { r: 15, g: 18, b: 40 },
    delta: { dr: 5, dg: -2, db: 10, dl: 1.5 },
  };

  it('一行读数：坐标 + 带符号的 ΔR/ΔG/ΔB（用空白分段，不用中点）', () => {
    const text = formatProbe(withDelta);
    expect(text).toBe('x 12  y 34  ΔR +5  ΔG -2  ΔB +10');
    expect(text.includes('·')).toBe(false);
  });

  it('没有可比对的跑分图时只显示坐标', () => {
    expect(formatProbe({ ...withDelta, cand: null, delta: null })).toBe('x 12  y 34');
  });

  it('详情包含两图 RGB 与亮度差，可直接复制', () => {
    const detail = formatProbeDetail(withDelta);
    expect(detail).toContain('坐标 (12, 34)');
    expect(detail).toContain('原图 RGB(10, 20, 30)');
    expect(detail).toContain('跑分图 RGB(15, 18, 40)');
    expect(detail).toContain('ΔL +1.5');
  });

  it('差值全为 0 时仍明确给出 0（不省略）', () => {
    const detail = formatProbeDetail({
      x: 0,
      y: 0,
      ref: { r: 1, g: 1, b: 1 },
      cand: { r: 1, g: 1, b: 1 },
      delta: { dr: 0, dg: 0, db: 0, dl: 0 },
    });
    expect(detail).toContain('ΔR 0 ΔG 0 ΔB 0');
  });
});

describe('probeKey（采样缓存键）', () => {
  it('不同像素/不同图得到不同键，相同输入稳定', () => {
    expect(probeKey('/a.png', 1, 2)).toBe(probeKey('/a.png', 1, 2));
    expect(probeKey('/a.png', 1, 2)).not.toBe(probeKey('/a.png', 2, 1));
    expect(probeKey('/a.png', 1, 2)).not.toBe(probeKey('/b.png', 1, 2));
  });
});
