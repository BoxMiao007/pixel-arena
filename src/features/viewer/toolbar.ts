// 查看器工具栏与模式参数。
//
// 工具栏一行：模式分段控制 + 模式专属参数 + 当前对比对象 + 缩放控件。
// 模式参数（不透明度 / 阈值 / 播放）以前浮在画布右上角，会盖住图像主体（窄窗尤甚）；
// 现在紧邻模式条内联，既是就近原则，也让画布整块留给图像。

import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { iconButton, segmented, sliderField } from '../../ui/primitives';
import {
  MODE_META,
  MODE_ORDER,
  type CompareUiState,
  type ViewerMode,
} from './types';
import { formatZoomPercent } from './zoom';

export interface ToolbarOptions {
  mode: ViewerMode;
  onModeChange: (mode: ViewerMode) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onZoomMenu: (anchor: HTMLElement) => void;
  /** 单槽模式：点上下文文字打开「选择对比图」菜单。 */
  onPickCandidate: (anchor: HTMLElement) => void;
}

export interface PropsOptions {
  mode: ViewerMode;
  compare: CompareUiState;
  onOpacityInput: (value: number) => void;
  onThresholdInput: (value: number) => void;
  onTogglePlay: () => void;
}

export interface ToolbarHandle {
  node: HTMLElement;
  /** 模式参数组（内联在模式条右侧；无参数的模式为空节点，CSS 会隐藏）。 */
  props: HTMLElement;
  setMode: (mode: ViewerMode) => void;
  /** pickable=true 时上下文文字变成换图入口（单槽模式）；分屏/网格只作说明。 */
  setContext: (text: string, pickable?: boolean) => void;
  setZoom: (zoom: number, pixel: boolean) => void;
  setZoomEnabled: (enabled: boolean) => void;
  /** 重建参数浮条（模式变化时调用）。 */
  buildProps: (options: PropsOptions) => void;
  /** 同步参数值（拖动中不重建 DOM）。 */
  syncProps: (compare: CompareUiState) => void;
  destroy: () => void;
}

function modeItems(): Array<{ id: string; icon: (typeof MODE_META)[ViewerMode]['icon']; label: string; title: string }> {
  return MODE_ORDER.map((mode, index) => ({
    id: mode,
    icon: MODE_META[mode].icon,
    label: MODE_META[mode].label,
    title: `${MODE_META[mode].label}（${index + 1}）：${MODE_META[mode].description}`,
  }));
}

export function buildToolbar(options: ToolbarOptions): ToolbarHandle {
  const seg = segmented({
    items: modeItems(),
    value: options.mode,
    ariaLabel: '对比模式',
    onChange: (id) => options.onModeChange(id as ViewerMode),
  });
  seg.node.classList.add('viewer__modes');
  // 纯图标分段：给每个 radio 一个可访问名（分段原语只有 title，没有 aria-label）。
  for (const button of seg.node.querySelectorAll<HTMLButtonElement>('.segmented__item')) {
    const mode = button.dataset.id as ViewerMode | undefined;
    if (!mode) continue;
    const index = MODE_ORDER.indexOf(mode);
    button.setAttribute('aria-label', `${MODE_META[mode].label}（${index + 1}）`);
  }

  const contextText = el('span', { class: 'viewer__context-text truncate', text: '' });
  const context = el(
    'button',
    {
      class: 'viewer__context',
      attrs: { type: 'button' },
      on: { click: () => options.onPickCandidate(context) },
    },
    contextText,
    icon('chevronDown', 'icon viewer__context-caret'),
  );
  context.disabled = true;

  const zoomOut = iconButton({ icon: 'zoomOut', label: '缩小', size: 'sm', onClick: options.onZoomOut });
  const zoomValue = el('button', {
    class: 'viewer__zoom-value numeric',
    attrs: { type: 'button', 'aria-label': '缩放档位', 'aria-haspopup': 'menu' },
    text: '100%',
  });
  zoomValue.addEventListener('click', () => options.onZoomMenu(zoomValue));
  const zoomIn = iconButton({ icon: 'zoomIn', label: '放大', size: 'sm', onClick: options.onZoomIn });
  const fit = iconButton({ icon: 'fit', label: '适应窗口（0）', size: 'sm', onClick: options.onZoomFit });

  // 模式参数（不透明度 / 阈值 / 播放）跟着模式条走：它们是「当前模式」的参数，
  // 放在工具栏里紧邻分段控制，既是就近原则，也不再压住画布上的图像。
  const props = el('div', { class: 'viewer__props', attrs: { 'data-empty': 'true' } });

  const node = el(
    'div',
    { class: 'viewer__toolbar' },
    seg.node,
    props,
    context,
    el('span', { class: 'viewer__spacer' }),
    el('div', { class: 'viewer__zoom' }, zoomOut, zoomValue, zoomIn, fit),
  );

  let opacityHandle: { setValue: (value: number) => void; input: HTMLInputElement } | null = null;
  let thresholdHandle: { setValue: (value: number) => void; input: HTMLInputElement } | null = null;
  let playButton: HTMLButtonElement | null = null;
  let propsMode: ViewerMode | null = null;

  const syncPlayLabel = (compare: CompareUiState): void => {
    if (!playButton) return;
    playButton.replaceChildren(
      icon(compare.blinkPlaying ? 'pause' : 'play', 'icon'),
      el('span', { text: compare.blinkPlaying ? '暂停' : '播放' }),
    );
    playButton.setAttribute(
      'title',
      compare.blinkPlaying ? '暂停自动交替（500ms）' : '自动交替显示原图与跑分图（500ms）',
    );
  };

  return {
    node,
    props,
    setMode: (mode) => {
      seg.setValue(mode);
    },
    setContext: (text, pickable = false) => {
      contextText.textContent = text;
      context.disabled = !pickable;
      context.title = pickable ? `${text}（点击换对比图）` : text;
      context.setAttribute('aria-label', pickable ? `${text}，点击选择对比图` : text);
      if (pickable) context.setAttribute('aria-haspopup', 'menu');
      else context.removeAttribute('aria-haspopup');
    },
    setZoom: (zoom, pixel) => {
      zoomValue.textContent = formatZoomPercent(zoom);
      zoomValue.classList.toggle('is-pixel', pixel);
    },
    setZoomEnabled: (enabled) => {
      for (const button of [zoomOut, zoomValue, zoomIn, fit]) {
        button.disabled = !enabled;
      }
      if (!enabled) zoomValue.textContent = '—';
    },
    buildProps: (next) => {
      propsMode = next.mode;
      opacityHandle = null;
      thresholdHandle = null;
      playButton = null;
      props.replaceChildren();
      props.dataset.empty = 'true';

      if (next.mode === 'overlay' || next.mode === 'diff') {
        const isOpacity = next.mode === 'overlay';
        const handle = sliderField({
          label: isOpacity ? '不透明度' : '阈值',
          min: 0,
          max: 100,
          step: 1,
          value: isOpacity ? Math.round(next.compare.opacity * 100) : next.compare.threshold,
          format: (value) => (isOpacity ? `${Math.round(value)}%` : String(Math.round(value))),
          onInput: (value) => {
            if (isOpacity) next.onOpacityInput(value / 100);
            else next.onThresholdInput(value);
          },
        });
        props.append(handle.node);
        props.dataset.empty = 'false';
        if (isOpacity) opacityHandle = handle;
        else thresholdHandle = handle;
        return;
      }

      if (next.mode === 'blink') {
        playButton = el(
          'button',
          {
            class: 'btn btn--secondary btn--sm viewer__play',
            attrs: { type: 'button' },
            on: { click: () => next.onTogglePlay() },
          },
          icon('play', 'icon'),
          el('span', { text: '播放' }),
        );
        props.append(playButton);
        props.dataset.empty = 'false';
        syncPlayLabel(next.compare);
      }
    },
    syncProps: (compare) => {
      if (propsMode === 'overlay') opacityHandle?.setValue(Math.round(compare.opacity * 100));
      if (propsMode === 'diff') thresholdHandle?.setValue(compare.threshold);
      if (propsMode === 'blink') syncPlayLabel(compare);
    },
    destroy: () => {
      props.replaceChildren();
    },
  };
}
