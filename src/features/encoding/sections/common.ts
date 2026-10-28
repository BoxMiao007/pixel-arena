// 分区共用的小工具：折叠态持久化、结构键渲染、拖放注册、防抖。
//
// 折叠态存在 core/ui-state 的 UiPrefs.sections（键 = 分区 id），与界面偏好同源；
// 记录状态关闭时 getPref/setPref 自己会跳过读写。

import { getPref, setPref } from '../../../core/ui-state';
import { getState, type BusyEntry } from '../../../core/store';
import { el, paint, type Child } from '../../../ui/dom';
import { section, type SectionHandle } from '../../../ui/primitives';
import { registerDropTarget, type DropAccept } from '../../../shell/file-drop';

/** 分区默认展开态（未记录时用）。 */
export function sectionOpen(id: string, fallback = true): boolean {
  const all = getPref('sections');
  const value = all[id];
  return value === undefined ? fallback : value;
}

export function setSectionOpen(id: string, open: boolean): void {
  const all = getPref('sections');
  if (all[id] === open) return;
  setPref('sections', { ...all, [id]: open });
}

/** 建一个可折叠分区并挂到 host；返回句柄与正文容器。 */
export function mountSection(
  host: HTMLElement,
  options: { id: string; title: string; defaultOpen?: boolean; actions?: HTMLElement | null },
): { handle: SectionHandle; body: HTMLElement } {
  const handle = section({
    id: options.id,
    title: options.title,
    collapsible: true,
    open: sectionOpen(options.id, options.defaultOpen ?? true),
    onToggle: (open) => setSectionOpen(options.id, open),
    actions: options.actions ?? null,
    className: `enc-section enc-section--${options.id}`,
  });
  host.append(handle.node);
  return { handle, body: handle.body };
}

/** 按结构键重画分区正文：键不变就只跑 also（用于刷新数值/进度，保住焦点）。 */
export function paintBody(body: HTMLElement, key: string, build: () => Child): void {
  paint(body, key, build);
}

/**
 * 禁用按钮套一层带 title 的宿主。
 *
 * 原因：原生 `disabled` 元素不派发鼠标事件，Chromium/WebView2 上悬浮提示根本不出现，
 * 于是「为什么不能点」就看不见了。包一层 span 由它承载 title，悬浮即可读出原因；
 * 键盘用户读不到禁用按钮，因此同一原因也会写进分区里的那一行正文（不靠悬浮兜底）。
 */
export function hintWrap(control: HTMLElement, hint: string, grow = false): HTMLElement {
  return el('span', { class: `hint-host${grow ? ' hint-host--grow' : ''}`, title: hint }, control);
}

/** 注册拖放落区：mount 时调用，destroy 时执行返回的注销函数。 */
export function dropTarget(
  host: HTMLElement,
  options: {
    id: string;
    accept: DropAccept;
    hint: string;
    onDrop: (paths: string[]) => void;
    disabled?: () => boolean;
  },
): () => void {
  return registerDropTarget(host, options);
}

/** 尾部防抖（滑杆连续拖动时只在停手后取点）。 */
export function debounce(fn: () => void, delay = 220): { run: () => void; cancel: () => void } {
  let timer: number | null = null;
  return {
    run: () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        fn();
      }, delay);
    },
    cancel: () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    },
  };
}

/** 取某个长任务的忙状态条目（无则 undefined）。 */
export function busyOf(id: string): BusyEntry | undefined {
  return getState().busy.get(id);
}
