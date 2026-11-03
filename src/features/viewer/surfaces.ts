// 查看器的画布表面：单画布（滑动/叠加/差异/闪烁）、分屏多栏、网格多格。
//
// 只负责「结构 + 每栏/每格的选图按钮与占位状态」；画什么、视口多少由 stage 决定。
// 重绘不走 DOM 重建：结构只在模式变化或栏/格数量变化时重建一次。

import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { highlightChipList } from '../../ui/highlight-chips';
import { spinner } from '../../ui/primitives';
import type { HighlightChip } from '../../core/highlight';
import { GRID_MIN_CELL_PX, GRID_MIN_ROW_PX, SPLIT_MIN_PANE_PX } from './layout';

/** 单栏/单格的占位状态（加载中 / 加载失败 / 显式留空）。 */
export type PaneStatus =
  | { kind: 'none' }
  | { kind: 'loading'; role: string }
  | { kind: 'error'; role: string; path: string }
  | { kind: 'empty' };

export interface SurfaceOptions {
  mode: 'single' | 'split' | 'grid';
  /** 栏数 / 格子数（single 恒为 1）。 */
  count: number;
  /** 网格列数（split/single 忽略）。 */
  cols?: number;
  /** 点击某栏/某格的选图按钮。 */
  onPick: (index: number) => void;
  /** 某栏/某格获得焦点（切栏或换图后高亮那一格）。 */
  onFocus: (index: number) => void;
  /** 错误状态的「重试」「复制路径」。 */
  onRetry: (index: number, path: string) => void;
  onCopy: (index: number, path: string) => void;
}

export interface ViewerSurface {
  root: HTMLElement;
  /** 按栏/格顺序的画布（single 只有 1 个）。 */
  canvases: readonly HTMLCanvasElement[];
  /** 更新选图按钮文案、空态样式与悬浮提示（title 带栏号与完整路径）。 */
  setPicker: (index: number, label: string, empty: boolean, title?: string) => void;
  /** 聚焦高亮（分屏/网格）。 */
  setFocus: (index: number | null) => void;
  /** 占位状态；同状态重复调用不会重建 DOM。 */
  setStatus: (index: number, status: PaneStatus) => void;
  /**
   * 网格每格右上角的判断徽标（分屏/单画布没有徽标宿主，调用无副作用）。
   * 视觉复用 ui/highlight-chips 的共享胶囊，与结果表/侧栏保持同一套；
   * 内容不变时不重建 DOM，避免悬停/重绘抖动。
   */
  setChips: (index: number, chips: readonly HighlightChip[]) => void;
  destroy: () => void;
}

interface PaneParts {
  wrapper: HTMLElement;
  canvas: HTMLCanvasElement;
  picker: HTMLButtonElement | null;
  statusHost: HTMLElement;
  pickerEmpty: boolean;
  /** 只有网格格子有徽标宿主；分屏/单画布为 null。 */
  chipHost: HTMLElement | null;
}

function buildStatusHost(): HTMLElement {
  return el('div', { class: 'viewer__pane-status', attrs: { hidden: true } });
}

/**
 * 画布的可访问外壳：可聚焦 + 有名字，键盘方向键（stage 接线）才有落点。
 *
 * 这里不是静态图片：滚轮缩放、拖拽平移、方向键移动都由 stage 接在 canvas 上，
 * 所以用 role="group" 而不是 role="img"（img 会把「可操作」语义读没）。
 */
function decorateCanvas(canvas: HTMLCanvasElement, tabbable = true): HTMLCanvasElement {
  canvas.setAttribute('role', 'group');
  canvas.tabIndex = tabbable ? 0 : -1;
  canvas.setAttribute('aria-label', '对比画布（滚轮缩放，拖拽平移，方向键移动，双击复位）');
  return canvas;
}

function pickerChildren(label: string): Node[] {
  return [
    el('span', { class: 'viewer__picker-label', text: label }),
    icon('chevronDown', 'icon icon--12 viewer__picker-chevron'),
  ];
}

function buildPicker(onClick: () => void): HTMLButtonElement {
  return el(
    'button',
    {
      class: 'viewer__picker',
      attrs: { type: 'button' },
      on: { click: onClick },
    },
    ...pickerChildren(''),
  ) as HTMLButtonElement;
}

/** 网格格子右上角的判断徽标容器（初始隐藏；没有徽标时不占位、不吃指针）。 */
function buildChipHost(): HTMLElement {
  const host = el('div', { class: 'viewer__chips' });
  host.hidden = true;
  return host;
}

/** 徽标渲染键：内容没变就不重建 DOM（重绘/悬停切换格时不抖动）。 */
function chipsKey(chips: readonly HighlightChip[]): string {
  // detail 带具体指标值，指标变了 title 也要跟着变，所以一并进键
  return chips.map((chip) => `${chip.kind}|${chip.label}|${chip.detail}`).join('\n');
}

/**
 * 格角徽标：直接复用 ui/highlight-chips 的共享胶囊（结果表 / 侧栏 / 多视图同一套视觉），
 * 这里只套一个绝对定位的容器，尺寸与颜色都不在局部重定义。
 */
function renderChips(host: HTMLElement, chips: readonly HighlightChip[]): void {
  const list = highlightChipList(chips, 'sm');
  if (list) host.replaceChildren(list);
  else host.replaceChildren();
  host.hidden = list === null;
}

/** 把占位状态渲染进容器（只在状态 key 变化时重建）。 */
function renderStatus(
  host: HTMLElement,
  status: PaneStatus,
  handlers: { retry: () => void; copy: () => void },
): void {
  host.dataset.kind = status.kind;
  if (status.kind === 'none') {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  if (status.kind === 'loading') {
    host.replaceChildren(
      spinner('加载中…'),
      el('span', { class: 'viewer__pane-status-text', text: `正在加载${status.role}…` }),
    );
    return;
  }
  if (status.kind === 'empty') {
    host.replaceChildren(
      el('span', { class: 'viewer__pane-status-text', text: '（空）' }),
    );
    return;
  }
  host.replaceChildren(
    el('span', { class: 'viewer__pane-status-text', text: `${status.role}加载失败` }),
    el(
      'span',
      { class: 'viewer__pane-status-actions' },
      el(
        'button',
        {
          class: 'viewer__mini-btn',
          attrs: { type: 'button', title: '重新加载这张图' },
          on: { click: handlers.retry },
        },
        icon('refresh', 'icon icon--12'),
        el('span', { text: '重试' }),
      ),
      el(
        'button',
        {
          class: 'viewer__mini-btn',
          attrs: { type: 'button', title: '复制完整路径' },
          on: { click: handlers.copy },
        },
        icon('copy', 'icon icon--12'),
        el('span', { text: '复制路径' }),
      ),
    ),
  );
}

function statusKey(status: PaneStatus): string {
  if (status.kind === 'error') return `error|${status.role}|${status.path}`;
  if (status.kind === 'loading') return `loading|${status.role}`;
  return status.kind;
}

/**
 * 建一组画布表面。返回的 destroy 只解绑本模块自己的监听；
 * 画布上的滚轮/拖拽解绑由 stage 负责（它在 attachPanZoom 时拿到 detach）。
 */
export function mountSurface(options: SurfaceOptions): ViewerSurface {
  const panes: PaneParts[] = [];
  const statusKeys: string[] = [];
  const chipKeys: string[] = [];
  const cleanups: Array<() => void> = [];
  let root: HTMLElement;

  if (options.mode === 'single') {
    const canvas = decorateCanvas(el('canvas', { class: 'viewer__canvas' }));
    const statusHost = buildStatusHost();
    root = el('div', { class: 'viewer__surface viewer__surface--single' }, canvas, statusHost);
    panes.push({ wrapper: root, canvas, picker: null, statusHost, pickerEmpty: false, chipHost: null });
  } else if (options.mode === 'split') {
    root = el('div', { class: 'viewer__split' });
    root.style.setProperty('--pane-min', `${SPLIT_MIN_PANE_PX}px`);
    for (let index = 0; index < options.count; index++) {
      // 只让第一栏进 Tab 序列：全栏共享同一视口，方向键在任一栏都作用于整体。
      const canvas = decorateCanvas(el('canvas', { class: 'viewer__canvas' }), index === 0);
      const statusHost = buildStatusHost();
      const picker = buildPicker(() => options.onPick(index));
      const wrapper = el(
        'div',
        { class: 'viewer__pane', dataset: { index: String(index) } },
        canvas,
        picker,
        statusHost,
      );
      const focus = (): void => options.onFocus(index);
      wrapper.addEventListener('pointerdown', focus);
      cleanups.push(() => wrapper.removeEventListener('pointerdown', focus));
      root.appendChild(wrapper);
      panes.push({ wrapper, canvas, picker, statusHost, pickerEmpty: false, chipHost: null });
    }
  } else {
    root = el('div', { class: 'viewer__grid' });
    root.style.setProperty('--grid-row-min', `${GRID_MIN_ROW_PX}px`);
    if (options.cols) {
      // 列有最小宽度：多图时整片网格横向滚动，而不是把每格压成看不清的窄条
      root.style.setProperty(
        'grid-template-columns',
        `repeat(${options.cols}, minmax(${GRID_MIN_CELL_PX}px, 1fr))`,
      );
    }
    for (let index = 0; index < options.count; index++) {
      const canvas = decorateCanvas(el('canvas', { class: 'viewer__canvas' }), index === 0);
      const statusHost = buildStatusHost();
      const picker = buildPicker(() => options.onPick(index));
      // 判断徽标只给网格：分屏是「原图 + 一张张并排」，格子没有更强的归属，
      // 而多视图每格就是一张跑分图，角标才读得通。
      const chipHost = buildChipHost();
      const wrapper = el(
        'div',
        { class: 'viewer__pane viewer__cell', dataset: { index: String(index) } },
        canvas,
        picker,
        chipHost,
        statusHost,
      );
      const focus = (): void => options.onFocus(index);
      wrapper.addEventListener('pointerdown', focus);
      cleanups.push(() => wrapper.removeEventListener('pointerdown', focus));
      root.appendChild(wrapper);
      panes.push({ wrapper, canvas, picker, statusHost, pickerEmpty: false, chipHost });
    }
  }

  return {
    root,
    canvases: panes.map((pane) => pane.canvas),
    setPicker: (index, label, empty, title) => {
      // 真窗回归：可见标签曾与 aria 名错位一格。这里不再「按数组下标找 picker 再改子节点」，
      // 而是按 data-index 在 DOM 里定位，并整块重建可见内容——标签与名字同源于这一次调用。
      const wrapper = root.querySelector<HTMLElement>(
        `.viewer__pane[data-index="${index}"]`,
      );
      const picker = wrapper?.querySelector<HTMLButtonElement>('.viewer__picker') ?? panes[index]?.picker;
      if (!picker) return;
      const nextTitle = title ?? (empty ? '选择这一格显示的图片' : `换图：${label}`);
      picker.replaceChildren(...pickerChildren(label));
      picker.title = nextTitle;
      picker.setAttribute('aria-label', nextTitle);
      picker.dataset.path = label;
      picker.classList.toggle('is-empty', empty);
      const pane = panes[index];
      if (pane) pane.pickerEmpty = empty;
    },
    setFocus: (index) => {
      panes.forEach((pane, i) => pane.wrapper.classList.toggle('is-focused', i === index));
    },
    setStatus: (index, status) => {
      const pane = panes[index];
      if (!pane) return;
      const key = statusKey(status);
      if (statusKeys[index] === key) return;
      statusKeys[index] = key;
      renderStatus(pane.statusHost, status, {
        retry: () => {
          if (status.kind === 'error') options.onRetry(index, status.path);
        },
        copy: () => {
          if (status.kind === 'error') options.onCopy(index, status.path);
        },
      });
    },
    setChips: (index, chips) => {
      const pane = panes[index];
      if (!pane?.chipHost) return;
      const key = chipsKey(chips);
      if (chipKeys[index] === key) return;
      chipKeys[index] = key;
      renderChips(pane.chipHost, chips);
    },
    destroy: () => {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      for (const pane of panes) pane.wrapper.replaceChildren();
    },
  };
}
