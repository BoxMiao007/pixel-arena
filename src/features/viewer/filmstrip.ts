// 胶片条：舞台底部的图片池，是查看器里「换对比图」的唯一入口。
//
// 第一项是原图（单槽四模式里只作基准，不可选；分屏/网格里可选进当前栏/格），
// 其余是跑分图。点击写到哪里由 selection.ts 的 pickSlot 决定，本模块只发事件。
//
// 缩略图用独立 <img> + asset URL：不进大图解码缓存，避免缩略图条目污染原图尺寸信息，
// 浏览器自己的资源缓存足够（同一 URL 二次显示不重复解码）。

import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { imageUrl } from '../../ui/canvas';

export interface FilmstripItem {
  /** 真实路径（状态里存这个）。 */
  path: string;
  /** 显示名（原图加前缀）。 */
  label: string;
  /** 实际加载缩略图用的路径（AVIF/JXL 为代片）。 */
  thumbPath: string;
  /** 是否是原图（单槽模式下不可选）。 */
  isReference: boolean;
}

export interface FilmstripOptions {
  onPick: (path: string) => void;
  onAdd: () => void;
}

export interface FilmstripHandle {
  node: HTMLElement;
  /**
   * 刷新内容：items 变化会重建；selected/inUse/allowAdd 变化只改类名与属性。
   */
  setItems: (
    items: readonly FilmstripItem[],
    state: { selectedPath: string | null; inUse: ReadonlySet<string>; selectableReferences: boolean; allowAdd: boolean },
  ) => void;
  destroy: () => void;
}

interface ItemNode {
  button: HTMLButtonElement;
  path: string;
  label: string;
  isReference: boolean;
}

function itemKey(items: readonly FilmstripItem[]): string {
  return items.map((item) => `${item.path}\u0000${item.label}\u0000${item.thumbPath}`).join('\u0001');
}

function buildThumb(path: string): HTMLElement {
  const image = el('img', {
    class: 'viewer__thumb-img',
    attrs: { alt: '', loading: 'lazy', decoding: 'async' },
  });
  image.src = imageUrl(path);
  const box = el('span', { class: 'viewer__thumb' }, image);
  // 代片缺失/格式不支持时缩略图会 404：收起破图标，留中性底块，不要显示浏览器默认的裂图。
  image.addEventListener('error', () => {
    box.classList.add('is-broken');
    image.remove();
  });
  return box;
}

export function buildFilmstrip(options: FilmstripOptions): FilmstripHandle {
  const node = el('div', { class: 'viewer__film', attrs: { 'aria-label': '图片池' } });
  let items: ItemNode[] = [];
  let signature = '';
  let selectedPath: string | null = null;
  let selectableReferences = false;
  let allowAdd = false;
  let inUse: ReadonlySet<string> = new Set();
  let lastScrolledTo: string | null = null;

  const applyState = (): void => {
    for (const item of items) {
      const selected = item.path === selectedPath;
      item.button.classList.toggle('is-selected', selected);
      item.button.classList.toggle('is-in-use', inUse.has(item.path));
      item.button.setAttribute('aria-pressed', String(selected));
      const selectable = selectableReferences || !item.isReference;
      item.button.disabled = !selectable;
      item.button.classList.toggle('is-static', !selectable);
      item.button.title = item.isReference
        ? selectable
          ? `原图：${item.label}（点击显示到当前栏/格）`
          : `原图：${item.label}（基准，不参与单张对比）`
        : `跑分图：${item.label}（点击显示到当前栏/格）`;
    }
  };

  const rebuild = (next: readonly FilmstripItem[]): void => {
    node.replaceChildren();
    items = next.map((item) => {
      const button = el(
        'button',
        {
          class: 'viewer__film-item',
          attrs: {
            type: 'button',
            'aria-pressed': 'false',
            'aria-label': item.isReference ? `原图：${item.label}` : `跑分图：${item.label}`,
          },
          on: {
            click: () => {
              if (button.disabled) return;
              options.onPick(item.path);
            },
          },
        },
        buildThumb(item.thumbPath),
        el('span', { class: 'viewer__film-name', text: item.label }),
      );
      node.appendChild(button);
      return { button, path: item.path, label: item.label, isReference: item.isReference };
    });
    if (allowAdd) {
      node.appendChild(
        el(
          'button',
          {
            class: 'viewer__film-add',
            attrs: { type: 'button', title: '添加跑分图（Ctrl+O）' },
            on: { click: () => options.onAdd() },
          },
          icon('plus', 'icon'),
          el('span', { class: 'viewer__film-name', text: '添加跑分图' }),
        ),
      );
    }
    applyState();
  };

  return {
    node,
    setItems: (next, state) => {
      selectedPath = state.selectedPath;
      selectableReferences = state.selectableReferences;
      inUse = state.inUse;
      const nextSignature = itemKey(next);
      const rebuilt = signature !== nextSignature || allowAdd !== state.allowAdd;
      if (rebuilt) {
        signature = nextSignature;
        allowAdd = state.allowAdd;
        rebuild(next);
      }
      if (signature !== nextSignature) signature = nextSignature;
      applyState();
      // 只在选中项变了才滚（update() 会在跑分进度里高频调用，避免每次强制布局）
      if (selectedPath !== lastScrolledTo) {
        lastScrolledTo = selectedPath;
        const selected = items.find((item) => item.path === selectedPath);
        selected?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    },
    destroy: () => {
      node.replaceChildren();
      items = [];
    },
  };
}
