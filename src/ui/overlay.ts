// 浮层原语：模态、锚定菜单、确认与输入对话框。
//
// 统一负责：遮罩、焦点捕获与还原、Esc 关闭、点遮罩关闭、键盘导航（菜单方向键）、
// 层级栈（Esc 只关最上层）。调用方只关心内容与回调。
//
// 阴影与圆角纪律（见设计契约）：浮层是唯一允许中/大阴影的层级；模态内容区
// 保持 overflow:auto 但内壁留出 ≥ 阴影外扩的 padding，避免祖先裁切。

import { el, hasOverlay } from './dom';
import { icon } from './icons';

function overlayRoot(): HTMLElement {
  let root = document.querySelector<HTMLElement>('#overlay-root');
  if (!root) {
    root = el('div', { class: 'overlay-root', attrs: { 'data-overlay-root': '' } });
    document.body.appendChild(root);
  }
  // 静态 HTML 里的挂载点可能没带类名：补齐样式钩子（层叠上下文靠它压住 sticky 表头）
  root.classList.add('overlay-root');
  return root;
}

interface StackEntry {
  close: () => void;
}

const stack: StackEntry[] = [];

/** 关闭最上层浮层（Esc 的统一入口）；没有浮层返回 false。 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

function pushStack(entry: StackEntry): void {
  stack.push(entry);
  overlayRoot().classList.add('overlay-root--active');
}

function popStack(entry: StackEntry): void {
  const index = stack.indexOf(entry);
  if (index >= 0) stack.splice(index, 1);
  if (stack.length === 0) overlayRoot().classList.remove('overlay-root--active');
}

/** 焦点捕获：Tab / Shift+Tab 在容器内循环。 */
function trapFocus(container: HTMLElement): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  footer?: HTMLElement | null;
  /** 期望宽度（px）：样式表再与可用宽度取小，窄窗不溢出；默认 560px。 */
  width?: number;
  /** 关闭时回调（含 Esc / 遮罩 / 按钮）。 */
  onClose?: () => void;
  /** 关闭前询问：返回 false 则拦下（如有未保存改动）。 */
  beforeClose?: () => boolean | Promise<boolean>;
}

export interface ModalHandle {
  close: () => void;
  setBody: (body: HTMLElement) => void;
  setFooter: (footer: HTMLElement | null) => void;
}

/** 打开模态；返回可更新内容与关闭的句柄。 */
export function openModal(options: ModalOptions): ModalHandle {
  const previousFocus = document.activeElement as HTMLElement | null;
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;

  const body = el('div', { class: 'modal__body' }, options.body);
  const footer = el('div', { class: 'modal__footer' });
  if (options.footer) footer.appendChild(options.footer);
  if (!options.footer) footer.hidden = true;

  const closeButton = el(
    'button',
    {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': '关闭' },
      on: { click: () => void close() },
    },
    icon('close'),
  );

  const dialog = el(
    'div',
    {
      class: 'modal',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabindex: '-1',
      },
    },
    el(
      'header',
      { class: 'modal__head' },
      el('h2', { class: 'modal__title', text: options.title, attrs: { id: titleId } }),
      closeButton,
    ),
    body,
    footer,
  );
  // 宽度只写 CSS 变量，不写死内联 width：样式表要在变量外面套 min() 做窄窗收敛
  // （.modal = min(--modal-w, 100%)），内联 width 会盖掉这层收敛。
  if (options.width) dialog.style.setProperty('--modal-w', `${options.width}px`);

  const overlay = el(
    'div',
    { class: 'overlay' },
    dialog,
  );
  let closed = false;

  const entry: StackEntry = { close: () => void close() };

  async function close(): Promise<void> {
    if (closed) return;
    if (options.beforeClose) {
      const allowed = await options.beforeClose();
      if (!allowed) return;
    }
    closed = true;
    popStack(entry);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    options.onClose?.();
    previousFocus?.focus?.();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void close();
      return;
    }
    trapFocus(dialog)(event);
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) void close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  overlayRoot().appendChild(overlay);
  pushStack(entry);
  dialog.focus();

  return {
    close: () => void close(),
    setBody: (next) => body.replaceChildren(next),
    setFooter: (next) => {
      footer.hidden = next === null;
      footer.replaceChildren(...(next ? [next] : []));
    },
  };
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 右侧快捷键提示（如 Ctrl+N）。 */
  hint?: string;
  /** 选中项标记（勾）。 */
  checked?: boolean;
  separator?: false;
}

export interface MenuHandle {
  close: () => void;
}

/**
 * 锚定菜单：在 anchor 下方（空间不足则上方）弹出，方向键导航。
 * 传入 at 时改按这组视口坐标（鼠标位置）弹出，供画布右键菜单使用。
 */
export function openMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  options: { align?: 'start' | 'end'; label?: string; at?: { x: number; y: number } } = {},
): MenuHandle {
  const previousFocus = document.activeElement as HTMLElement | null;
  const menu = el('div', {
    class: 'menu',
    attrs: { role: 'menu', tabindex: '-1', 'aria-label': options.label ?? '操作' },
  });

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const button = el(
      'button',
      {
        class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
        attrs: {
          type: 'button',
          // aria-checked 只对 menuitemcheckbox / menuitemradio 合法：
          // 带 checked 的条目声明成 menuitemradio，纯动作条目保持 menuitem。
          role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
          'aria-disabled': item.disabled ? 'true' : null,
          disabled: item.disabled ?? false,
          'aria-checked': item.checked === undefined ? null : String(item.checked),
        },
        on: {
          click: () => {
            if (item.disabled) return;
            handle.close();
            item.onSelect();
          },
        },
      },
      el('span', { class: 'menu__label', text: item.label }),
      item.hint ? el('span', { class: 'menu__hint', text: item.hint }) : null,
      item.checked ? icon('check', 'icon menu__check') : null,
    );
    buttons.push(button);
    menu.appendChild(button);
  }

  const overlay = el('div', { class: 'menu-layer' }, menu);
  let closed = false;
  const entry: StackEntry = { close: () => handle.close() };
  const handle: MenuHandle = { close: () => close() };

  function close(): void {
    if (closed) return;
    closed = true;
    popStack(entry);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    overlay.remove();
    previousFocus?.focus?.();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (current + delta + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', close);
  overlayRoot().appendChild(overlay);
  pushStack(entry);

  // 定位：优先下方，空间不足翻到上方；start/end 决定水平对齐。
  // at（鼠标坐标）来自画布右键：菜单左上角落在指针处，再统一钳进视口。
  const menuRect = menu.getBoundingClientRect();
  let top: number;
  let left: number;
  if (options.at) {
    top = options.at.y;
    left = options.at.x;
  } else {
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < menuRect.height + 8 && rect.top > menuRect.height + 8;
    top = above ? rect.top - menuRect.height - 4 : rect.bottom + 4;
    left = options.align === 'end' ? rect.right - menuRect.width : rect.left;
  }
  menu.style.setProperty('top', `${Math.max(4, Math.min(top, window.innerHeight - menuRect.height - 4))}px`);
  menu.style.setProperty('left', `${Math.max(4, Math.min(left, window.innerWidth - menuRect.width - 4))}px`);
  menu.focus();
  buttons[0]?.focus();

  return handle;
}

export interface PopoverHandle {
  close: () => void;
}

/** 锚定气泡（非菜单内容：进度、说明、参数）。 */
export function openPopover(
  anchor: HTMLElement,
  content: HTMLElement,
  options: { align?: 'start' | 'end' | 'center'; label?: string } = {},
): PopoverHandle {
  const previousFocus = document.activeElement as HTMLElement | null;
  const popover = el(
    'div',
    {
      class: 'popover',
      attrs: { role: 'dialog', tabindex: '-1', 'aria-label': options.label ?? '详情' },
    },
    content,
  );
  const overlay = el('div', { class: 'menu-layer' }, popover);
  let closed = false;
  const entry: StackEntry = { close: () => handle.close() };
  const handle: PopoverHandle = { close: () => close() };

  function close(): void {
    if (closed) return;
    closed = true;
    popStack(entry);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    overlay.remove();
    previousFocus?.focus?.();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', close);
  overlayRoot().appendChild(overlay);
  pushStack(entry);

  const rect = anchor.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  const top = rect.bottom + 6 + box.height > window.innerHeight
    ? Math.max(4, rect.top - box.height - 6)
    : rect.bottom + 6;
  const preferred =
    options.align === 'end'
      ? rect.right - box.width
      : options.align === 'center'
        ? rect.left + rect.width / 2 - box.width / 2
        : rect.left;
  popover.style.setProperty('top', `${top}px`);
  popover.style.setProperty(
    'left',
    `${Math.max(4, Math.min(preferred, window.innerWidth - box.width - 4))}px`,
  );
  popover.focus();
  return handle;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** 确认对话（破坏性操作必须走这里）：返回是否确认。 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(value);
    };
    const cancel = el('button', {
      class: 'btn btn--secondary',
      text: options.cancelLabel ?? '取消',
      attrs: { type: 'button' },
      on: { click: () => finish(false) },
    });
    const ok = el('button', {
      class: `btn ${options.danger ? 'btn--danger' : 'btn--primary'}`,
      text: options.confirmLabel,
      attrs: { type: 'button' },
      on: { click: () => finish(true) },
    });
    const body = el(
      'div',
      { class: 'confirm' },
      el('p', { class: 'confirm__message', text: options.message }),
    );
    const footer = el('div', { class: 'confirm__actions' }, cancel, ok);
    const handle = openModal({
      title: options.title,
      body,
      footer,
      width: 420,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    ok.focus();
  });
}

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel: string;
  /** 允许空值提交（默认不允许）。 */
  allowEmpty?: boolean;
}

/** 单行输入对话（新建分组命名等）：返回输入值或 null。 */
export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const input = el('input', {
      class: 'input',
      attrs: {
        type: 'text',
        value: options.value ?? '',
        placeholder: options.placeholder ?? '',
        maxlength: '60',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    }) as HTMLInputElement;
    input.id = `prompt-${Math.random().toString(36).slice(2, 9)}`;

    const error = el('p', { class: 'field__error', attrs: { role: 'alert' } });
    error.hidden = true;

    const submit = (): void => {
      const value = input.value.trim();
      if (value.length === 0 && !options.allowEmpty) {
        error.textContent = '名称不能为空';
        error.hidden = false;
        input.focus();
        return;
      }
      finish(value);
    };

    const cancel = el('button', {
      class: 'btn btn--secondary',
      text: '取消',
      attrs: { type: 'button' },
      on: { click: () => finish(null) },
    });
    const ok = el('button', {
      class: 'btn btn--primary',
      text: options.confirmLabel,
      attrs: { type: 'button' },
      on: { click: submit },
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const body = el(
      'div',
      { class: 'prompt' },
      el(
        'label',
        { class: 'field__label', attrs: { for: input.id } },
        options.label,
      ),
      input,
      error,
    );
    const footer = el('div', { class: 'confirm__actions' }, cancel, ok);

    const handle = openModal({
      title: options.title,
      body,
      footer,
      width: 420,
      onClose: () => finish(null),
    });

    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(value);
    }

    input.focus();
    input.select();
  });
}

/** 是否有浮层打开（快捷键与沉浸模式退出的判断）。 */
export function overlayOpen(): boolean {
  return hasOverlay() && stack.length > 0;
}
