// 网格排布单测：行列按图片总数自动排布（票面映射：1→单格、2→1×2、3-4→2×2、
// 5-6→2×3、7-9→3×3、更多按 3 列折行）。

import { describe, it, expect } from 'vitest';
import {
  GRID_MIN_CELL_PX,
  GRID_MIN_ROW_PX,
  SPLIT_MIN_PANE_PX,
  cellCount,
  gridLayout,
  paneCount,
} from './layout';

describe('gridLayout（行列自动排布）', () => {
  it('1 张 → 单格', () => {
    expect(gridLayout(1)).toEqual({ rows: 1, cols: 1 });
  });

  it('2 张 → 1×2（一行两列）', () => {
    expect(gridLayout(2)).toEqual({ rows: 1, cols: 2 });
  });

  it('3-4 张 → 2×2', () => {
    expect(gridLayout(3)).toEqual({ rows: 2, cols: 2 });
    expect(gridLayout(4)).toEqual({ rows: 2, cols: 2 });
  });

  it('5-6 张 → 2×3（两行三列）', () => {
    expect(gridLayout(5)).toEqual({ rows: 2, cols: 3 });
    expect(gridLayout(6)).toEqual({ rows: 2, cols: 3 });
  });

  it('7-9 张 → 3×3', () => {
    expect(gridLayout(7)).toEqual({ rows: 3, cols: 3 });
    expect(gridLayout(9)).toEqual({ rows: 3, cols: 3 });
  });

  it('超过 9 张按 3 列折行（10 张 = 4 行）', () => {
    expect(gridLayout(10)).toEqual({ rows: 4, cols: 3 });
    expect(gridLayout(12)).toEqual({ rows: 4, cols: 3 });
    expect(gridLayout(13)).toEqual({ rows: 5, cols: 3 });
  });

  it('非法数量按 1 计（不留 0 行 0 列）', () => {
    expect(gridLayout(0)).toEqual({ rows: 1, cols: 1 });
    expect(gridLayout(-5)).toEqual({ rows: 1, cols: 1 });
    expect(gridLayout(3.9)).toEqual({ rows: 2, cols: 2 }); // floor(3.9) = 3
  });
});

describe('cellCount / paneCount（布局尺寸）', () => {
  it('格子总数 = rows × cols，可能多于图片数（多出的格子留空）', () => {
    expect(cellCount(1)).toBe(1);
    expect(cellCount(3)).toBe(4); // 3 张进 2×2，多一格
    expect(cellCount(5)).toBe(6);
    expect(cellCount(10)).toBe(12);
  });

  it('分屏栏数 = 1 + 跑分图数（第 0 栏固定原图）', () => {
    expect(paneCount(0)).toBe(1);
    expect(paneCount(3)).toBe(4);
    expect(paneCount(-2)).toBe(1);
  });

  it('网格格子与分屏每栏都有可用下限（不足就滚动，不压缩到看不清）', () => {
    expect(GRID_MIN_ROW_PX).toBeGreaterThanOrEqual(160);
    expect(GRID_MIN_CELL_PX).toBeGreaterThanOrEqual(240);
    expect(SPLIT_MIN_PANE_PX).toBeGreaterThanOrEqual(200);
  });
});
