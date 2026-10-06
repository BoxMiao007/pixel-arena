// 多视图网格选图逻辑的单测：只测公共 API 的外部行为（纯逻辑，无 DOM）。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。
// 视口同步几何不在本文件：全部复用 viewport.ts，由 viewport.test.ts 守护。
// T20 起网格合并为单模式（行列由 gridLayout 按数量自动排布），cellPaths 退化为单数组，
// T19 的「档位隔离」用例随双入口消失而删除（合并后无档位可言，见 shared/notes/T19.md）。

import { describe, it, expect } from 'vitest';
import { defaultCellImage, gridLayout, resolveCellImage, type MultiviewState } from './multiview';

const round = {
  referencePath: '/demo/ref.png',
  candidates: [{ path: '/demo/a.jpg' }, { path: '/demo/b.webp' }],
};

/** 构造多视图状态切片（只关心 cellPaths） */
const shared = (cellPaths: MultiviewState['cellPaths']): MultiviewState => ({
  viewport: null,
  cellPaths,
});

describe('gridLayout（行列按图片总数自动排布，票面映射）', () => {
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
});

describe('defaultCellImage（默认布局：第 1 格原图，其余按跑分图顺序填入）', () => {
  it('第 1 格是原图', () => {
    expect(defaultCellImage(0, round)).toBe('/demo/ref.png');
  });

  it('第 2、3 格依次是第 1、2 张跑分图', () => {
    expect(defaultCellImage(1, round)).toBe('/demo/a.jpg');
    expect(defaultCellImage(2, round)).toBe('/demo/b.webp');
  });

  it('图片不够填满格子时（如 3 张图进 2×2），多出的格子留空', () => {
    expect(defaultCellImage(3, round)).toBeNull();
  });
});

describe('resolveCellImage（每格最终显示的图）', () => {
  it('没手动改过（cellPaths 为空数组）时全部走默认布局', () => {
    expect(resolveCellImage(shared([]), 0, round)).toBe('/demo/ref.png');
    expect(resolveCellImage(shared([]), 1, round)).toBe('/demo/a.jpg');
    expect(resolveCellImage(shared([]), 8, round)).toBeNull();
  });

  it('某格显式选了轮内另一张图后，该格用显式选择，其余格不受影响', () => {
    const st = shared([null, '/demo/b.webp']);
    expect(resolveCellImage(st, 1, round)).toBe('/demo/b.webp');
    expect(resolveCellImage(st, 0, round)).toBe('/demo/ref.png');
  });

  it('可以把原图显式选到非第 1 格（跑分图被删光后各格仍可对齐原图）', () => {
    const st = shared([null, '/demo/ref.png']);
    expect(resolveCellImage(st, 1, round)).toBe('/demo/ref.png');
  });

  it('显式选「空」（空字符串）的格子留空，即使默认布局里有图', () => {
    const st = shared([null, '']);
    expect(resolveCellImage(st, 1, round)).toBeNull();
  });

  it('显式选的图已不在本轮（跑分图被删）时回落到该格默认，不显示失效图', () => {
    const st = shared([null, '/demo/removed.jpg']);
    expect(resolveCellImage(st, 1, round)).toBe('/demo/a.jpg');
  });

  it('同一份选择在格子数量变化后仍按格号生效（数组缺省位走默认）', () => {
    // 从 1×2 切到更多格后，先前的显式选择不丢、新格走默认布局
    const st = shared([null, '/demo/b.webp']);
    expect(resolveCellImage(st, 1, round)).toBe('/demo/b.webp');
    expect(resolveCellImage(st, 5, round)).toBeNull();
  });
});
