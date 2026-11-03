// 设置域入口。
//
// 外壳只需要 `import '../features/settings'`：本模块把自己注册成 `open-settings` 命令
// （顶栏「设置」按钮、FFmpeg 未就绪提醒、Ctrl+, 快捷键都经命令派发到同一条路径）。
// 命令重复注册是安全的（注册表按 id 覆盖），模块被多处 import 也不会开出两个设置窗口。

import { registerCommand } from '../../shell/registry';
import { openSettings } from './dialog';

export { openSettings };

registerCommand({
  id: 'open-settings',
  run: () => openSettings(),
});
