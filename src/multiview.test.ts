// 多视图网格选图逻辑的单测：只测公共 API 的外部行为（纯逻辑，无 DOM）。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。
// 视口同步几何不在本文件：全部复用 viewport.ts，由 viewport.test.ts 守护。

import { describe, it, expect } from 'vitest';
import { cellCount, defaultCellImage, resolveCellImage } from './multiview';

const round = {
  referencePath: '/demo/ref.png',
  candidates: [{ path: '/demo/a.jpg' }, { path: '/demo/b.webp' }],
};

describe('cellCount（网格格子数随模式）', () => {
  it('2×2 有 4 格，3×3 有 9 格', () => {
    expect(cellCount(2)).toBe(4);
    expect(cellCount(3)).toBe(9);
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
  it('没手动改过（cellPaths 为 null）时全部走默认布局', () => {
    expect(resolveCellImage({ viewport: null, cellPaths: null }, 0, round)).toBe('/demo/ref.png');
    expect(resolveCellImage({ viewport: null, cellPaths: null }, 1, round)).toBe('/demo/a.jpg');
    expect(resolveCellImage({ viewport: null, cellPaths: null }, 3, round)).toBeNull();
  });

  it('某格显式选了轮内另一张图后，该格用显式选择，其余格不受影响', () => {
    const shared = { viewport: null, cellPaths: [null, '/demo/b.webp', null, null] };
    expect(resolveCellImage(shared, 1, round)).toBe('/demo/b.webp');
    expect(resolveCellImage(shared, 0, round)).toBe('/demo/ref.png');
  });

  it('可以把原图显式选到非第 1 格（跑分图被删光后各格仍可对齐原图）', () => {
    const shared = { viewport: null, cellPaths: [null, '/demo/ref.png'] };
    expect(resolveCellImage(shared, 1, round)).toBe('/demo/ref.png');
  });

  it('显式选「空」（空字符串）的格子留空，即使默认布局里有图', () => {
    const shared = { viewport: null, cellPaths: [null, ''] };
    expect(resolveCellImage(shared, 1, round)).toBeNull();
  });

  it('显式选的图已不在本轮（跑分图被删）时回落到该格默认，不显示失效图', () => {
    const shared = { viewport: null, cellPaths: [null, '/demo/removed.jpg'] };
    expect(resolveCellImage(shared, 1, round)).toBe('/demo/a.jpg');
  });

  it('2×2 里改过的选择切到 3×3 后保留；超出原数组的格子走默认', () => {
    const shared = { viewport: null, cellPaths: [null, '/demo/b.webp', null, null] };
    expect(resolveCellImage(shared, 1, round)).toBe('/demo/b.webp'); // 保留
    expect(resolveCellImage(shared, 4, round)).toBeNull(); // 第 5 格超出，默认留空
    expect(resolveCellImage(shared, 5, round)).toBeNull();
  });
});
