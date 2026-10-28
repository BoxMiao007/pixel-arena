// 装配冒烟：导入 index.ts 后，注册表里确实有两个页签与导出命令。
// 这里直接 import（不是 ?raw）——模块加载期只碰注册表与 ui-state 的读偏好，
// 读偏好内部对 localStorage 缺失做了容错，所以 node 环境可以安全加载。

import { describe, expect, it } from 'vitest';
import { dockTabsFor, getCommand } from '../../shell/registry';
import './index';

describe('results 域注册', () => {
  it('图片组与视频组都拿到 评分表 / BD-rate 两个页签', () => {
    for (const kind of ['image', 'video'] as const) {
      const tabs = dockTabsFor(kind);
      expect(tabs.map((tab) => tab.id), kind).toEqual(['results', 'bdrate']);
      expect(tabs.map((tab) => tab.label), kind).toEqual(['评分表', 'BD-rate']);
      expect(tabs.map((tab) => tab.order), kind).toEqual([10, 20]);
    }
  });

  it('页签挂载函数可调用（不在这里真的挂 DOM）', () => {
    for (const tab of dockTabsFor('image')) {
      expect(typeof tab.mount).toBe('function');
    }
  });

  it('导出命令已注册（快捷键 Ctrl+E 由外壳派发）', () => {
    expect(getCommand('export-menu')).toBeDefined();
    expect(typeof getCommand('export-menu')?.run).toBe('function');
  });
});
