// 右缘渐隐的判定规则（无 DOM）。
//
// 表格的渐隐层只在「右边还有内容」时出现：贴着最左和最右都要消失，不溢出时
// 更不能出现——否则一张本来就放得下的表会一直画着一条渐变，看着像加载中。

import { describe, expect, it } from 'vitest';
import { edgeState, hasMoreRight } from './scroll-edge';

describe('横向滚动位置判定', () => {
  it('内容放得下时没有任何提示', () => {
    expect(edgeState(0, 600, 600)).toBe('none');
    expect(edgeState(0, 600, 800)).toBe('none');
    expect(hasMoreRight('none')).toBe(false);
  });

  it('亚像素误差不当作可滚动（1px 以内算贴边）', () => {
    expect(edgeState(0, 601, 600)).toBe('none');
  });

  it('贴左但右边还有内容：给出渐隐', () => {
    expect(edgeState(0, 1200, 600)).toBe('start');
    expect(hasMoreRight('start')).toBe(true);
  });

  it('滚到中间继续提示', () => {
    expect(edgeState(300, 1200, 600)).toBe('middle');
    expect(hasMoreRight('middle')).toBe(true);
  });

  it('滚到最右时渐隐消失', () => {
    expect(edgeState(600, 1200, 600)).toBe('end');
    expect(edgeState(599, 1200, 600)).toBe('end');
    expect(hasMoreRight('end')).toBe(false);
  });

  it('容器还没量出宽度（隐藏页签）时不提示', () => {
    expect(edgeState(0, 1200, 0)).toBe('none');
  });
});
