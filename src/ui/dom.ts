// 极简 DOM 构建与渲染辅助。
//
// 不用模板字符串拼 HTML：所有文本走 textContent（用户文件名、错误原文都不可信），
// 需要结构时用 el() 组合。渲染分两类：
// - paint()：结构键变化才重建（避免每次状态通知把正在编辑的输入框冲掉）；
// - replaceChildren()：整块重画（表格行等无焦点内容的场景）。
//
// 约定：功能域不得 innerHTML 拼用户数据；图标走 ui/icons.ts。

export type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** CSS 自定义属性或普通属性，键用 kebab-case（如 'max-height'）。 */
  style?: Record<string, string>;
  dataset?: Record<string, string>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  };
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
      continue;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      continue;
    }
    // 常见手误：把原语句柄（{ node, ... }）当子节点传。这里直接取 node，
    // 同时在开发期提示改用 .node，避免整块挂载因一个类型错误静默失败。
    const handle = child as { node?: Node };
    if (handle.node instanceof Node) {
      console.warn('el(): 收到原语句柄，已自动取其 .node；建议显式写 .node');
      parent.appendChild(handle.node);
      continue;
    }
    throw new Error('el(): 子节点必须是 Node / 字符串 / 数字');
  }
}

/** 建一个元素：el('button', { class: 'btn', text: '开始跑分', on: { click } }) */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  if (props.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (props.dataset) {
    for (const [name, value] of Object.entries(props.dataset)) node.dataset[name] = value;
  }
  if (props.style) {
    for (const [name, value] of Object.entries(props.style)) node.style.setProperty(name, value);
  }
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) {
      node.addEventListener(name, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

/** 文档片段（一次插入多个节点，避免多次回流）。 */
export function frag(...children: Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  append(fragment, children);
  return fragment;
}

const paintKeys = new WeakMap<Element, string>();

/**
 * 结构键渲染：key 不变且宿主已有内容时跳过重建，返回 false；否则重建并返回 true。
 * 用于「状态高频变化但表单/输入框不该重建」的分区。
 */
export function paint(host: Element, key: string, build: () => Child): boolean {
  if (paintKeys.get(host) === key && host.childNodes.length > 0) return false;
  const next = build();
  host.replaceChildren();
  if (next !== null && next !== undefined && next !== false) {
    if (typeof next === 'string' || typeof next === 'number') {
      host.textContent = String(next);
    } else {
      host.appendChild(next);
    }
  }
  paintKeys.set(host, key);
  return true;
}

/** 强制下一次 paint 重建（结构没变但内容来自外部、需要刷新的场景）。 */
export function invalidate(host: Element): void {
  paintKeys.delete(host);
}

/** 事件目标是否是可输入控件（全局快捷键要放过它们）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 焦点是否在浮层里（Esc 先关浮层、再退沉浸模式）。 */
export function hasOverlay(): boolean {
  return document.querySelector('[data-overlay-root]')?.childElementCount !== 0;
}
