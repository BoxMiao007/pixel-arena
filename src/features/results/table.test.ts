// 表格骨架的纯逻辑：三态排序、取值比较、稳定排序。DOM 部分不在这里测（仓库无 jsdom）。

import { describe, expect, it } from 'vitest';
import {
  ariaSortValue,
  compareSortValues,
  nextSortState,
  sortRowsBy,
  type SortState,
} from './table';

describe('三态排序 nextSortState', () => {
  it('无排序 → 首次点击用首选方向', () => {
    expect(nextSortState(null, 'PSNR', -1)).toEqual({ key: 'PSNR', dir: -1 });
    expect(nextSortState(null, 'Butteraugli', 1)).toEqual({ key: 'Butteraugli', dir: 1 });
  });

  it('同一列第二次点击反向', () => {
    const state: SortState = { key: 'PSNR', dir: -1 };
    expect(nextSortState(state, 'PSNR', -1)).toEqual({ key: 'PSNR', dir: 1 });
  });

  it('同一列第三次点击回到选入顺序（null）', () => {
    const reversed: SortState = { key: 'PSNR', dir: 1 };
    expect(nextSortState(reversed, 'PSNR', -1)).toBeNull();
  });

  it('换列时用新列的首选方向', () => {
    expect(nextSortState({ key: 'PSNR', dir: 1 }, 'Butteraugli', 1)).toEqual({
      key: 'Butteraugli',
      dir: 1,
    });
  });
});

describe('表头 aria-sort 取值', () => {
  it('排序方向映射到 aria-sort 的三个真实值（读屏靠属性，不只画箭头）', () => {
    expect(ariaSortValue(1)).toBe('ascending');
    expect(ariaSortValue(-1)).toBe('descending');
    expect(ariaSortValue(0)).toBe('none');
  });
});

describe('取值比较 compareSortValues', () => {
  it('缺值恒沉底，与升降序无关', () => {
    expect(compareSortValues(null, 1, 1)).toBe(1);
    expect(compareSortValues(null, 1, -1)).toBe(1);
    expect(compareSortValues(1, null, 1)).toBe(-1);
    expect(compareSortValues(1, null, -1)).toBe(-1);
    expect(compareSortValues(null, null, -1)).toBe(0);
  });

  it('数值按大小 × 方向', () => {
    expect(compareSortValues(1, 2, 1)).toBeLessThan(0);
    expect(compareSortValues(1, 2, -1)).toBeGreaterThan(0);
  });

  it('+∞ 参与比较不产生 NaN', () => {
    expect(compareSortValues(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, -1)).toBe(0);
    expect(compareSortValues(Number.POSITIVE_INFINITY, 40, -1)).toBeLessThan(0);
    expect(compareSortValues(Number.POSITIVE_INFINITY, 40, 1)).toBeGreaterThan(0);
  });

  it('字符串按 zh-CN 本地序 × 方向', () => {
    expect(compareSortValues('a.jpg', 'b.jpg', 1)).toBeLessThan(0);
    expect(compareSortValues('a.jpg', 'b.jpg', -1)).toBeGreaterThan(0);
  });
});

describe('稳定排序 sortRowsBy', () => {
  interface Row {
    path: string;
    value: number | null;
  }
  const rows: Row[] = [
    { path: 'b.webp', value: 30 },
    { path: 'a.jpg', value: 40 },
    { path: 'c.png', value: null },
    { path: 'd.avif', value: 30 },
  ];
  const valueOf = (row: Row): number | null => row.value;
  const keyOf = (row: Row): string => row.path;

  it('无排序时保持选入顺序', () => {
    expect(sortRowsBy(rows, null, valueOf, keyOf).map((row) => row.path)).toEqual([
      'b.webp',
      'a.jpg',
      'c.png',
      'd.avif',
    ]);
  });

  it('缺值沉底，等值用路径兜底保证稳定', () => {
    const sorted = sortRowsBy(rows, { key: 'value', dir: -1 }, valueOf, keyOf);
    expect(sorted.map((row) => row.path)).toEqual(['a.jpg', 'b.webp', 'd.avif', 'c.png']);
  });

  it('升序同样把缺值放最后', () => {
    const sorted = sortRowsBy(rows, { key: 'value', dir: 1 }, valueOf, keyOf);
    expect(sorted.map((row) => row.path)).toEqual(['b.webp', 'd.avif', 'a.jpg', 'c.png']);
  });

  it('不修改入参数组', () => {
    const before = rows.map((row) => row.path);
    sortRowsBy(rows, { key: 'value', dir: -1 }, valueOf, keyOf);
    expect(rows.map((row) => row.path)).toEqual(before);
  });
});
