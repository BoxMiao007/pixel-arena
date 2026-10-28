// 轻提示：只用于「动作已生效」这类瞬时反馈；错误仍以状态栏 + 就地文案为主，
// 避免把需要阅读的原因塞进几秒就消失的 toast。

import { el } from './dom';
import { icon } from './icons';

export type ToastKind = 'info' | 'ok' | 'danger';

export interface ToastOptions {
  action?: { label: string; onSelect: () => void };
  /** 毫秒；默认 3200，错误 6000。 */
  duration?: number;
}

let root: HTMLElement | null = null;

function toastRoot(): HTMLElement {
  if (!root) {
    root = el('div', {
      class: 'toast-root',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    document.body.appendChild(root);
  }
  return root;
}

/** 弹一条轻提示；返回手动关闭函数。 */
export function toast(message: string, kind: ToastKind = 'info', options: ToastOptions = {}): () => void {
  const duration = options.duration ?? (kind === 'danger' ? 6000 : 3200);
  let timer: number | undefined;
  const node = el(
    'div',
    { class: `toast toast--${kind}` },
    icon(kind === 'danger' ? 'alert' : kind === 'ok' ? 'check' : 'info', 'icon toast__icon'),
    el('span', { class: 'toast__text', text: message }),
    options.action
      ? el('button', {
          class: 'toast__action',
          text: options.action.label,
          attrs: { type: 'button' },
          on: {
            click: () => {
              options.action?.onSelect();
              dismiss();
            },
          },
        })
      : null,
  );

  function dismiss(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    node.classList.add('toast--leaving');
    window.setTimeout(() => node.remove(), 140);
  }

  toastRoot().appendChild(node);
  if (duration > 0) timer = window.setTimeout(dismiss, duration);
  return dismiss;
}
