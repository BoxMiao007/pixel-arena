// 查看器接线单测：只验证「注册契约」本身（无 DOM）。
// 外壳按 id 找舞台视图、按 keys 派发快捷键；这里守住两件事：
// 1) 图片组能拿到查看器舞台，id/label/kind 与外壳约定一致；
// 2) 舞台键位（1–6 / 空格 / +/- / 0 / Shift+0）都注册了，且带 kinds 过滤与 when 守卫。

import { describe, it, expect } from 'vitest';
import './index';
import { keyBindingsSnapshot, stageViewFor } from '../../shell/registry';

describe('舞台注册', () => {
  it('图片组的舞台视图是查看器（id: image-viewer）', () => {
    const view = stageViewFor('image');
    expect(view).not.toBeNull();
    expect(view!.id).toBe('image-viewer');
    expect(view!.label).toBe('对比查看器');
    expect(typeof view!.mount).toBe('function');
  });

  it('视频组不会拿到图片查看器（按 kinds 过滤）', () => {
    expect(stageViewFor('video')?.id).not.toBe('image-viewer');
  });
});

describe('舞台键位注册', () => {
  const bindings = keyBindingsSnapshot();
  const ids = bindings.map((binding) => binding.id);

  it('模式/闪烁/缩放/复位键位都已注册', () => {
    for (const id of [
      'viewer-mode',
      'viewer-blink-toggle',
      'viewer-zoom-in',
      'viewer-zoom-out',
      'viewer-zoom-reset',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('键位只在图片组生效（不抢视频舞台与外壳快捷键）', () => {
    for (const binding of bindings) {
      if (!binding.id.startsWith('viewer-')) continue;
      expect(binding.kinds).toEqual(['image']);
      expect(binding.keys.length).toBeGreaterThan(0);
      expect(typeof binding.run).toBe('function');
    }
  });

  it('模式键位覆盖 1–6，复位键位同时覆盖 0 与 Shift+0 的国际键位变体', () => {
    const mode = bindings.find((binding) => binding.id === 'viewer-mode');
    expect(mode?.keys).toEqual(['1', '2', '3', '4', '5', '6']);
    const reset = bindings.find((binding) => binding.id === 'viewer-zoom-reset');
    expect(reset?.keys).toContain('0');
    expect(reset?.keys).toContain(')');
  });

  it('没有挂载查看器时键位的 when 守卫为假（不误触发）', () => {
    const mode = bindings.find((binding) => binding.id === 'viewer-mode');
    expect(mode?.when?.()).toBe(false);
  });
});
