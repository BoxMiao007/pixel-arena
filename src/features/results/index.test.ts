// 装配冒烟 + 注册契约：导入 index.ts 后，注册表里有评分表 / 效率对比两个页签与导出命令。
// 这里直接 import（不是 ?raw 切片）——模块加载期只碰注册表与 ui-state 的读偏好，
// 读偏好内部对 localStorage 缺失做了容错，所以 node 环境可以安全加载。
// 页签 id / order / kinds 是外壳契约；命令用 runCommand 的真实结果验证（空工作区时
// 只写状态栏说明，不碰 DOM）。

import { describe, expect, it } from 'vitest';
import { getState } from '../../core/store';
import { dockTabsFor, getCommand, runCommand } from '../../shell/registry';
import './index';

describe('results 域注册', () => {
  it('图片组拿到 评分表 / 效率对比 两个页签，视频组只挂 评分表', () => {
    const imageTabs = dockTabsFor('image');
    expect(imageTabs.map((tab) => tab.id)).toEqual(['results', 'efficiency']);
    expect(imageTabs.map((tab) => tab.label)).toEqual(['评分表', '效率对比']);
    expect(imageTabs.map((tab) => tab.order)).toEqual([10, 20]);

    // 效率对比只对图片有意义（BD-rate 的拟合不覆盖视频），视频组不再挂一个永远空的页签。
    expect(dockTabsFor('video').map((tab) => tab.id)).toEqual(['results']);
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