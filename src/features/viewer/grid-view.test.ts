// 多视图逐格视口换算单测。
//
// 期望值全部用独立演算的字面量：800×600 的格子、1600×1200 的锚图恰好适配一半
// （zoom 0.5），400×300 的格子图恰好适配两倍（zoom 2）——不调实现里的公式。

import { describe, it, expect } from 'vitest';
import { cellViewport, sharedViewportFromCell } from './grid-view';

const PANE = { width: 800, height: 600 };
const ANCHOR = { width: 1600, height: 1200 };
/** 锚图按 800×600 适配出来的默认共享视口：zoom = 800/1600 = 0.5。 */
const SHARED_FIT = { centerX: 800, centerY: 600, zoom: 0.5 };

describe('cellViewport（共享视口 → 该格视口）', () => {
  it('默认（相对 1）时每格按自己的尺寸填满格子', () => {
    // 400×300 在 800×600 里适配两倍；中心仍是图片中心。
    expect(cellViewport(SHARED_FIT, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 2,
    });
  });

  it('共享缩放翻倍时该格倍数同步翻倍，中心不动', () => {
    const shared = { centerX: 800, centerY: 600, zoom: 1 };
    expect(cellViewport(shared, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 4,
    });
  });

  it('非居中位置按图片内相对位置映射（25% 处仍是 25%）', () => {
    // 共享中心在锚图 25% 处：(400, 300)。
    const shared = { centerX: 400, centerY: 300, zoom: 0.5 };
    expect(cellViewport(shared, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 100,
      centerY: 75,
      zoom: 2,
    });
  });

  it('小图与大图在同一格里的显示尺寸一致（等尺寸的核心验收）', () => {
    const big = cellViewport(SHARED_FIT, ANCHOR, { width: 400, height: 300 }, PANE);
    const small = cellViewport(SHARED_FIT, ANCHOR, { width: 200, height: 150 }, PANE);
    // 屏幕尺寸 = 图片像素 × 该格 zoom：两者都是 800×600。
    expect(400 * big.zoom).toBe(800);
    expect(300 * big.zoom).toBe(600);
    expect(200 * small.zoom).toBe(800);
    expect(150 * small.zoom).toBe(600);
  });

  it('长宽比不同时按各自的短边适配，不出现拉伸', () => {
    // 200×400 在 800×600 里受高度限制：600/400 = 1.5。
    expect(cellViewport(SHARED_FIT, ANCHOR, { width: 200, height: 400 }, PANE)).toEqual({
      centerX: 100,
      centerY: 200,
      zoom: 1.5,
    });
  });

  it('倍数超出上限时钳制到与画布同一口径（不会算出无限大）', () => {
    const shared = { centerX: 800, centerY: 600, zoom: 100 };
    expect(cellViewport(shared, ANCHOR, { width: 400, height: 300 }, PANE).zoom).toBe(64);
  });

  it('尺寸不可用时退回共享视口（不产生 NaN）', () => {
    const result = cellViewport(SHARED_FIT, ANCHOR, { width: 0, height: 300 }, PANE);
    expect(result).toEqual(SHARED_FIT);
  });
});

describe('sharedViewportFromCell（该格视口 → 共享视口）', () => {
  it('是 cellViewport 的逆运算（滚轮/拖拽写回不漂移）', () => {
    const cell = { centerX: 125, centerY: 90, zoom: 3 };
    // 独立演算：中心回到锚图 (125/400×1600, 90/300×1200) = (500, 360)，
    // 倍数回到共享口径 (3/2×0.5) = 0.75。
    expect(sharedViewportFromCell(cell, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 500,
      centerY: 360,
      zoom: 0.75,
    });
    const back = cellViewport(
      sharedViewportFromCell(cell, ANCHOR, { width: 400, height: 300 }, PANE),
      ANCHOR,
      { width: 400, height: 300 },
      PANE,
    );
    expect(back.centerX).toBeCloseTo(cell.centerX, 6);
    expect(back.centerY).toBeCloseTo(cell.centerY, 6);
    expect(back.zoom).toBeCloseTo(cell.zoom, 6);
  });

  it('默认适配位置写回后仍是锚图适配口径', () => {
    // 400×300 的图默认填满 800×600 的格子（视口 200,150,2）；写回共享状态应为
    // 锚图在 800×600 里的适配视口 (800, 600, 0.5)。
    const cell = cellViewport(SHARED_FIT, ANCHOR, { width: 400, height: 300 }, PANE);
    const shared = sharedViewportFromCell(cell, ANCHOR, { width: 400, height: 300 }, PANE);
    expect(shared.zoom).toBeCloseTo(0.5, 6);
    expect(shared.centerX).toBeCloseTo(800, 6);
    expect(shared.centerY).toBeCloseTo(600, 6);
  });

  it('尺寸不可用时原样返回（不产生 NaN）', () => {
    const cell = { centerX: 10, centerY: 20, zoom: 1 };
    expect(sharedViewportFromCell(cell, ANCHOR, { width: 400, height: 0 }, PANE)).toEqual(cell);
  });
});
