// 图片对比查看器：注册舞台视图与舞台键位。
//
// 外壳（app.ts）import 本模块即完成注册；不直接挂 document 监听，
// 键位交给 shell/registry 统一派发（输入框与浮层打开时不派发）。
//
// 键位分工：
// - 1–6 模式、空格 播放/暂停、+/- 缩放、0 适应、Shift+0 1:1 —— 本模块；
// - F 沉浸、Esc、Ctrl+* —— 外壳统一处理，这里不注册。

import { registerKeyBinding, registerStageView } from '../../shell/registry';
import { isTypingTarget } from '../../ui/dom';
import { activeViewerCommands, mountViewerStage } from './stage';
import { modeForKey } from './types';

function commands(): ReturnType<typeof activeViewerCommands> {
  const active = activeViewerCommands();
  // 外壳漏调 destroy 时（或舞台已被移出文档）键位立刻失效，避免打断其它界面
  return active?.isMounted() ? active : null;
}

/** 焦点不在可输入控件里（输入框/下拉不该被舞台快捷键抢走）。 */
function focusNotTyping(): boolean {
  return !isTypingTarget(document.activeElement);
}

/** 空格会激活已聚焦的按钮：焦点在按钮/链接上时把空格让给它们。 */
function focusNotButton(): boolean {
  const active = document.activeElement;
  return !(active instanceof HTMLButtonElement) && !(active instanceof HTMLAnchorElement);
}

registerStageView({
  id: 'image-viewer',
  label: '对比查看器',
  kinds: ['image'],
  mount: (host, ctx) => mountViewerStage(host, ctx),
});

registerKeyBinding({
  id: 'viewer-mode',
  keys: ['1', '2', '3', '4', '5', '6'],
  kinds: ['image'],
  when: () => commands() !== null && focusNotTyping(),
  run: (event) => {
    const mode = modeForKey(event.key);
    if (!mode) return;
    event.preventDefault();
    commands()?.setMode(mode);
  },
});

registerKeyBinding({
  id: 'viewer-blink-toggle',
  keys: [' '],
  kinds: ['image'],
  when: () => commands()?.isBlinkMode() === true && focusNotTyping() && focusNotButton(),
  run: (event) => {
    event.preventDefault();
    commands()?.toggleBlink();
  },
});

registerKeyBinding({
  id: 'viewer-zoom-in',
  keys: ['+', '=', 'Add'],
  kinds: ['image'],
  when: () => commands() !== null && focusNotTyping(),
  run: (event) => {
    event.preventDefault();
    commands()?.zoomIn();
  },
});

registerKeyBinding({
  id: 'viewer-zoom-out',
  keys: ['-', '_', 'Subtract'],
  kinds: ['image'],
  when: () => commands() !== null && focusNotTyping(),
  run: (event) => {
    event.preventDefault();
    commands()?.zoomOut();
  },
});

registerKeyBinding({
  id: 'viewer-zoom-reset',
  // US 键盘上 Shift+0 的 key 是 ')'；再补一个全角右括号，避免中文布局漏掉。
  keys: ['0', ')', '）', 'Shift+0'],
  kinds: ['image'],
  when: () => commands() !== null && focusNotTyping(),
  run: (event) => {
    event.preventDefault();
    const command = commands();
    if (!command) return;
    // 0 = 适应窗口；Shift+0 = 复位到 1:1（像素级）
    if (event.shiftKey || event.key === ')' || event.key === '）') command.oneToOne();
    else command.fit();
  },
});
