// 结果域装配：注册结果坞的两个页签与导出命令。
//
// 外壳只认注册表（shell/registry.ts），本文件是唯一的接线点：
// - 页签 id 必须与外壳一致：'results'（评分表）、'bdrate'；
// - 命令 id 'export-menu'，快捷键 Ctrl+E 由外壳派发；
// - 视频指标页签归 video 域（id 'video-metrics'），这里不占。
//
// 两种接法都可以：main.ts 里 `import './features/results'`（导入即注册），
// 或显式调用 registerResultsFeature()。注册表对重复 id 幂等，重复调用无副作用。

import { registerCommand, registerDockTab } from '../../shell/registry';
import { bdrateTab } from './bdrate-tab';
import { openExportMenu } from './export-menu';
import { resultsTab } from './results-tab';

export function registerResultsFeature(): void {
  registerDockTab(resultsTab);
  registerDockTab(bdrateTab);
  registerCommand({
    id: 'export-menu',
    run: () => {
      openExportMenu();
    },
  });
}

registerResultsFeature();

export { resultsTab, bdrateTab };
