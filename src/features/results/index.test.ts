// 装配冒烟 + 注册契约：导入 index.ts 后，注册表里确实有两个页签与导出命令。
// 这里直接 import（不是 ?raw 切片）——模块加载期只碰注册表与 ui-state 的读偏好，
// 读偏好内部对 localStorage 缺失做了容错，所以 node 环境可以安全加载。
// 页签 id / order / kinds 是外壳契约；命令用 runCommand 的真实结果验证（空工作区时
// 只写状态栏说明，不碰 DOM）。

import { describe, expect, it } from 'vitest';
import { getState } from '../../core/store';
import { dockTabsFor, getCommand, runCommand } from '../../shell/registry';
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
    for (const kind of ['image', 'video'] as const) {
      for (const tab of dockTabsFor(kind)) {
        expect(typeof tab.mount, `${kind}/${tab.id}`).toBe('function');
      }
    }
  });

  it('导出命令已注册，且外壳派发时落到导出入口', async () => {
    expect(getCommand('export-menu')).toBeDefined();
    // 空工作区：openExportMenu 只写状态栏说明，不碰 DOM，所以 node 下可跑。
    await expect(runCommand('export-menu')).resolves.toBe(true);
    expect(getState().status.text).toBe('还没有可导出的评测轮');
  });
});
