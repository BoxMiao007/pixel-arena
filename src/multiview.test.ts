// 多视图网格选图逻辑的单测：只测公共 API 的外部行为（纯逻辑，无 DOM）。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。
// 视口同步几何不在本文件：全部复用 viewport.ts，由 viewport.test.ts 守护。

import { describe, it, expect } from 'vitest';
import { cellCount, defaultCellImage, resolveCellImage, type MultiviewState } from './multiview';

const round = {
  referencePath: '/demo/ref.png',
  candidates: [{ path: '/demo/a.jpg' }, { path: '/demo/b.webp' }],
};

/** 构造多视图状态切片（只关心 cellPaths） */
const shared = (cellPaths: MultiviewState['cellPaths']): MultiviewState => ({
  viewport: null,
  cellPaths,
});

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
  it('没手动改过（cellPaths 为空对象）时全部走默认布局', () => {
    expect(resolveCellImage(shared({}), 2, 0, round)).toBe('/demo/ref.png');
    expect(resolveCellImage(shared({}), 2, 1, round)).toBe('/demo/a.jpg');
    expect(resolveCellImage(shared({}), 3, 8, round)).toBeNull();
  });

  it('某格显式选了轮内另一张图后，该格用显式选择，其余格不受影响', () => {
    const st = shared({ 2: [null, '/demo/b.webp', null, null] });
    expect(resolveCellImage(st, 2, 1, round)).toBe('/demo/b.webp');
    expect(resolveCellImage(st, 2, 0, round)).toBe('/demo/ref.png');
  });

  it('可以把原图显式选到非第 1 格（跑分图被删光后各格仍可对齐原图）', () => {
    const st = shared({ 2: [null, '/demo/ref.png'] });
    expect(resolveCellImage(st, 2, 1, round)).toBe('/demo/ref.png');
  });

  it('显式选「空」（空字符串）的格子留空，即使默认布局里有图', () => {
    const st = shared({ 2: [null, ''] });
    expect(resolveCellImage(st, 2, 1, round)).toBeNull();
  });

  it('显式选的图已不在本轮（跑分图被删）时回落到该格默认，不显示失效图', () => {
    const st = shared({ 2: [null, '/demo/removed.jpg'] });
    expect(resolveCellImage(st, 2, 1, round)).toBe('/demo/a.jpg');
  });

  it('2×2 手动改选不影响 3×3（T19 回归：选择曾跨档串用）', () => {
    const st = shared({ 2: [null, '/demo/b.webp'] });
    expect(resolveCellImage(st, 2, 1, round)).toBe('/demo/b.webp'); // 2×2 自己保留
    expect(resolveCellImage(st, 3, 1, round)).toBe('/demo/a.jpg'); // 3×3 第 2 格走默认，不吃 2×2 的选择
    expect(resolveCellImage(st, 3, 0, round)).toBe('/demo/ref.png'); // 3×3 第 1 格仍是原图
    expect(resolveCellImage(st, 3, 4, round)).toBeNull(); // 3×3 第 5 格默认留空
  });

  it('3×3 手动改选同样不影响 2×2', () => {
    const st = shared({ 3: [null, null, '/demo/a.jpg'] });
    expect(resolveCellImage(st, 3, 2, round)).toBe('/demo/a.jpg'); // 3×3 自己生效
    expect(resolveCellImage(st, 2, 2, round)).toBe('/demo/b.webp'); // 2×2 第 3 格走默认布局
  });

  it('两档各自的选择在同一状态里并存', () => {
    const st = shared({ 2: [null, '/demo/b.webp'], 3: [null, '/demo/a.jpg'] });
    expect(resolveCellImage(st, 2, 1, round)).toBe('/demo/b.webp');
    expect(resolveCellImage(st, 3, 1, round)).toBe('/demo/a.jpg');
  });
});
