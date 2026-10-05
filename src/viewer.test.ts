// 查看器单槽（分屏/滑动/叠加/差异/闪烁共用一个「跑分图」槽）选图逻辑的单测：
// 只测公共 API 的外部行为（纯逻辑，无 DOM）。挂载/绘制接线不做 DOM 级自动化，
// 以截图/录屏作为验收证据（viewer.ts 头注与规格 Testing Decisions）。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。

import { describe, it, expect } from 'vitest';
import { resolveCandidatePath } from './viewer';

const round = {
  referencePath: '/demo/ref.png',
  candidates: [{ path: '/demo/a.jpg' }, { path: '/demo/b.webp' }, { path: '/demo/c.avif' }],
};

describe('resolveCandidatePath（跑分图槽位解析）', () => {
  it('换跑分图后槽位立即解析为刚选的图（T19 回归：画布曾持续画挂载时的旧图）', () => {
    // 模拟用户在「跑分图」下拉里把选中项从 a.jpg 换到 c.avif：解析结果必须跟着换
    expect(resolveCandidatePath('/demo/c.avif', round)).toBe('/demo/c.avif');
    // 再换回第一张同样立即生效
    expect(resolveCandidatePath('/demo/a.jpg', round)).toBe('/demo/a.jpg');
  });

  it('显式选择仍在本轮时原样保留（跑分刷新后不丢选择）', () => {
    expect(resolveCandidatePath('/demo/b.webp', round)).toBe('/demo/b.webp');
  });

  it('显式选择的图已不在本轮（被删除）时回落第一张', () => {
    expect(resolveCandidatePath('/demo/removed.jpg', round)).toBe('/demo/a.jpg');
  });

  it('跑分图删光时槽位为 null', () => {
    expect(resolveCandidatePath('/demo/a.jpg', { candidates: [] })).toBeNull();
  });
});
