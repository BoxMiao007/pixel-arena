// 视频对比舞台：三种模式（分屏 / 滑动 / 网格）+ 同步时间轴 + 帧级键盘 + 播放。
//
// 结构（自上而下）：舞台工具条 / 画面区（+ DOM 覆盖层）/ 时间轴底座。
// - mount 一次、update 增量：切模式只重建画面区，时间轴与工具条不重建（不丢焦点）；
// - 每轮状态（模式、左右路、每格选路、放大态、时间点、视口、分隔线）存 core/ui-state
//   的 roundScoped，切轮保留、重启归零；
// - 画面用 canvas 绘制、<video> 常驻离屏池（见 media.ts）；画布底色由 CSS 承担，
//   JS 只 clearRect + drawImage；
// - 加载/解码失败/空态一律 DOM 覆盖层（role=status / role=alert），不画在 canvas 上：
//   读屏可达、可复制、可带「重试」「换源」动作。
//
// 键盘命令面（index.ts 注册键位后调用 activeVideoCommands）：
// ←/→ ±1 帧（Shift ±10）、Home/End、空格播放/暂停、1/2/3 模式、+/-/0 缩放。

import { getState, isBusy, subscribe } from '../../core/store';
import type { Round, CandidateVideo } from '../../core/model';
import { getActiveCandidate, roundScoped } from '../../core/ui-state';
import { fileName, truncateFileName } from '../../core/util';
import type { MountedView, ViewCtx } from '../../shell/registry';
import { registerDropTarget } from '../../shell/file-drop';
import { el, paint } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { button, emptyState, iconButton, segmented, spinner } from '../../ui/primitives';
import { toast } from '../../ui/toast';
import {
  attachPanZoom,
  drawSource,
  fitViewport,
  prepareCanvas,
  watchSize,
  withZoom,
  type ViewportState,
} from '../../ui/canvas';
import {
  chooseVideoCandidates,
  chooseVideoReference,
  pickVideoCandidates,
  pickVideoReference,
} from './actions';
import { probeUnavailableHint, videoLoadErrorMessage } from './errors';
import {
  MAX_DECODED_VIDEOS,
  MediaService,
  peekVideo,
  subscribeMedia,
  videoElement,
  type VideoSnapshot,
} from './media';
import {
  defaultPair,
  GRID_ZOOM_ROW_MIN_PX,
  gridCellCount,
  gridLayout,
  gridZoomLabel,
  resolveCellVideo,
  splitPanes,
  videoSources,
} from './sources';
import {
  clampTime,
  estimateFrameTotal,
  formatFps,
  formatTimestamp,
  frameIndexAt,
  frameLengthMs,
  minDuration,
  stepFrames,
  usableFps,
} from './timeline';

export type VideoStageMode = 'split' | 'slider' | 'grid';

interface StageState {
  mode: VideoStageMode;
  /** 左路 = 基准路：滑动模式左栏、网格第 0 格默认、帧步进口径取自显示中的第一路。 */
  leftPath: string | null;
  rightPath: string | null;
  /** 网格每格显式选路（''=显式留空，null=默认布局）。 */
  cellPaths: (string | null)[] | null;
  divider: number;
  viewport: ViewportState | null;
  gridZoomed: boolean;
  /** 共享时间点（秒）。 */
  time: number;
  playing: boolean;
}

/** 舞台对外的命令面（键位注册用；未挂载时为 null）。 */
export interface VideoStageCommands {
  step: (delta: number) => void;
  first: () => void;
  last: () => void;
  togglePlay: () => void;
  setMode: (mode: string) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

let activeCommands: VideoStageCommands | null = null;

/** 当前挂载中的视频舞台命令面；没挂载时为 null（键位注册用它作为 when 条件）。 */
export function activeVideoCommands(): VideoStageCommands | null {
  return activeCommands;
}

function candidatePaths(round: Round): string[] {
  return (round.videoCandidates ?? []).map((candidate: CandidateVideo) => candidate.path);
}

function initialStageState(round: Round): StageState {
  const sources = videoSources(round.videoReferencePath ?? null, candidatePaths(round));
  const pair = defaultPair(sources);
  return {
    mode: 'split',
    leftPath: pair?.left ?? sources[0] ?? null,
    rightPath: pair?.right ?? sources[1] ?? null,
    cellPaths: null,
    divider: 0.5,
    viewport: null,
    gridZoomed: false,
    time: 0,
    playing: false,
  };
}

interface Pane {
  canvas: HTMLCanvasElement;
  /** 分屏模式的固定源；滑动/网格逐帧解析（null）。 */
  path: string | null;
  cellIndex?: number;
  badge: HTMLElement;
  /** 网格格子的选源下拉（其他模式没有）。 */
  select?: HTMLSelectElement;
  detach: () => void;
}

interface StageTimeline {
  node: HTMLElement;
  stepBack: HTMLButtonElement;
  play: HTMLButtonElement;
  stepForward: HTMLButtonElement;
  slider: HTMLInputElement;
  frame: HTMLElement;
  time: HTMLElement;
  fps: HTMLElement;
  frameLength: HTMLElement;
  syncHint: HTMLElement;
}

function buildTimeline(): StageTimeline {
  const stepBack = iconButton({
    label: '后退一帧（←）',
    icon: 'stepBack',
    size: 'sm',
    variant: 'bordered',
  });
  const play = iconButton({
    label: '播放（空格）',
    icon: 'play',
    size: 'sm',
    variant: 'bordered',
  });
  const stepForward = iconButton({
    label: '前进一帧（→）',
    icon: 'stepForward',
    size: 'sm',
    variant: 'bordered',
  });

  const slider = el('input', {
    class: 'video-track__input',
    attrs: {
      type: 'range',
      min: '0',
      max: '0',
      step: '0.001',
      value: '0',
      'aria-label': '时间轴：拖动两路同时定位，方向键逐帧',
      'aria-valuetext': '0:00.000',
    },
  });
  slider.value = '0';

  const frame = el('span', { class: 'video-readout video-readout--frame', text: '帧 —' });
  const time = el('span', { class: 'video-readout video-readout--time', text: '— / —' });
  const fps = el('span', { class: 'video-readout', text: 'fps 未知' });
  const frameLength = el('span', { class: 'video-readout video-readout--muted', text: '' });
  const syncHint = el('span', {
    class: 'video-readout video-readout--danger',
    text: '未同步',
    attrs: { hidden: true },
  });

  const node = el(
    'div',
    { class: 'video-stage__timeline' },
    el('div', { class: 'video-stage__steps' }, stepBack, play, stepForward),
    el('div', { class: 'video-track' }, slider),
    el(
      'div',
      { class: 'video-readouts' },
      frame,
      time,
      fps,
      frameLength,
      syncHint,
    ),
  );

  return { node, stepBack, play, stepForward, slider, frame, time, fps, frameLength, syncHint };
}

/** 一套舞台的挂载入口（注册为 StageView.mount）。 */
export function mountVideoStage(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;
  let round: Round = ctx.round;
  let referencePath: string | null = round.videoReferencePath ?? null;
  let sources = videoSources(referencePath, candidatePaths(round));

  const state = roundScoped<StageState>('video-stage', roundId, () => initialStageState(round));
  // 播放不跨挂载：上一实例已 pause，这里再兜一次，避免状态残留成「暂停不了」。
  state.playing = false;
  const media = new MediaService();

  /** 最近一次 seek 是否超时（显示「未同步」而不是假装同帧）。 */
  let stale = false;
  let drawRaf = 0;
  let playRaf = 0;
  let panes: Pane[] = [];
  let sliderSourceSelects: {
    left: HTMLSelectElement;
    right: HTMLSelectElement;
    leftLabel: HTMLElement;
    rightTag: HTMLElement;
  } | null = null;
  let gridZoomButton: HTMLButtonElement | null = null;
  let gridEl: HTMLElement | null = null;
  let gridRows = 1;
  let dividerEl: HTMLElement | null = null;
  let areaSignature = '';
  let extrasKey = '';
  let lastActiveCandidate: string | null = getActiveCandidate(roundId);

  // ---------- 骨架（mount 一次） ----------
  const modes = segmented({
    items: [
      { id: 'split', label: '分屏' },
      { id: 'slider', label: '滑动' },
      { id: 'grid', label: '网格' },
    ],
    value: state.mode,
    onChange: (id) => setMode(id),
    ariaLabel: '视频对比模式',
    size: 'sm',
  });

  const barExtras = el('div', { class: 'video-stage__bar-extras' });
  const fitButton = iconButton({
    label: '适应窗口（0）',
    icon: 'fit',
    size: 'sm',
    variant: 'bordered',
    onClick: () => fitView(),
  });
  const bar = el(
    'div',
    { class: 'video-stage__bar' },
    modes.node,
    barExtras,
    el('div', { class: 'video-stage__bar-spacer' }),
    fitButton,
  );

  const area = el('div', { class: 'video-stage__area is-split' });
  const overlay = el('div', { class: 'video-stage__overlay' });
  overlay.hidden = true;
  const body = el('div', { class: 'video-stage__body' }, area, overlay);
  const timeline = buildTimeline();
  const root = el('div', { class: 'video-stage' }, bar, body, timeline.node);
  host.replaceChildren(root);

  const unregisterDrop = registerDropTarget(body, {
    id: 'drop-stage-video',
    accept: 'video',
    hint: '松开：追加为跑分视频',
    onDrop: (paths) => {
      // 与文件拖放的默认路由同一口径：还没有原视频时，第一段设为原视频、其余追加。
      // 两步必须串行：后端每次返回整份工作区，并发调用会让先落库的结果被后到的覆盖。
      const current = currentRound();
      if (!current?.videoReferencePath && paths.length > 0) {
        void (async () => {
          await chooseVideoReference(groupId, roundId, paths[0]);
          if (paths.length > 1) await chooseVideoCandidates(groupId, roundId, paths.slice(1));
        })();
        return;
      }
      void chooseVideoCandidates(groupId, roundId, paths);
    },
    disabled: () => isBusy(),
  });

  // 尺寸变化重绘（窗口拉伸 / 折叠面板 / 结果坞拖动）
  const detachSize = watchSize(area, () => scheduleDraw());

  // ---------- 选择与结构 ----------

  function normalizeSelection(): void {
    const pair = defaultPair(sources);
    if (!state.leftPath || !sources.includes(state.leftPath)) {
      state.leftPath = pair?.left ?? sources[0] ?? null;
      state.viewport = null;
    }
    if (!state.rightPath || !sources.includes(state.rightPath)) {
      state.rightPath = pair?.right ?? sources[1] ?? null;
      state.viewport = null;
    }
    if (state.mode === 'slider' && state.leftPath && state.rightPath === state.leftPath) {
      state.rightPath = sources.find((path) => path !== state.leftPath) ?? null;
    }
  }

  function displayedPaths(): string[] {
    let paths: (string | null)[];
    if (state.mode === 'split') {
      paths = panes.map((pane) => pane.path);
    } else if (state.mode === 'slider') {
      paths = [state.leftPath, state.rightPath];
    } else {
      const left = state.leftPath ?? '';
      paths = panes.map((pane) =>
        pane.cellIndex === undefined
          ? null
          : resolveCellVideo(pane.cellIndex, state.cellPaths, left, sources),
      );
    }
    const unique: string[] = [];
    for (const path of paths) {
      if (path && !unique.includes(path)) unique.push(path);
    }
    return unique;
  }

  function timelineDuration(): number {
    return minDuration(displayedPaths().map((path) => peekVideo(path)?.duration ?? 0));
  }

  function stepFps(): number | null {
    for (const path of displayedPaths()) {
      const fps = usableFps(peekVideo(path)?.fps ?? null);
      if (fps) return fps;
    }
    return null;
  }

  function areaKey(): string {
    const cells = state.mode === 'grid' ? gridCellCount(sources.length) : 0;
    return `${state.mode}|${cells}|${JSON.stringify(sources)}`;
  }

  function paneLabel(path: string, index: number): string {
    if (index === 0 && referencePath && path === referencePath) return '原视频';
    return truncateFileName(fileName(path));
  }

  function createInteractiveCanvas(path: string | null, label: string): {
    canvas: HTMLCanvasElement;
    detach: () => void;
  } {
    const canvas = el('canvas', {
      class: 'video-pane__canvas',
      attrs: {
        tabindex: '0',
        // 可聚焦、可缩放平移的画布不是静态图片：用 group + 操作说明，
        // 让读屏知道这里能交互，而不是把它当纯装饰图跳过。
        role: 'group',
        'aria-label': path
          ? `视频画面：${truncateFileName(fileName(path))}（滚轮缩放，拖拽平移，双击复位）`
          : `视频画面：${label}`,
      },
    });
    const detach = attachPanZoom(canvas, {
      getViewport: () => state.viewport,
      setViewport: (viewport) => {
        state.viewport = viewport;
      },
      onChange: scheduleDraw,
      onReset: () => {
        state.viewport = null;
        scheduleDraw();
      },
    });
    return { canvas, detach };
  }

  function renderSplit(): void {
    const paths = splitPanes(referencePath, sources);
    const group = el('div', { class: 'video-stage__split' });
    area.appendChild(group);
    const built: Pane[] = [];
    paths.forEach((path, index) => {
      const created = createInteractiveCanvas(path, '视频');
      const tag = el('span', {
        class: 'video-pane__tag',
        text: paneLabel(path, index),
        title: path,
      });
      const badge = el('span', { class: 'video-pane__badge', attrs: { hidden: true } });
      group.appendChild(el('div', { class: 'video-pane' }, created.canvas, tag, badge));
      built.push({ canvas: created.canvas, path, badge, detach: created.detach });
    });
    panes = built;
  }

  function buildSlider(): void {
    const created = createInteractiveCanvas(
      state.leftPath && state.rightPath ? `${state.leftPath}|${state.rightPath}` : null,
      '滑动对比',
    );
    const badge = el('span', { class: 'video-pane__badge', attrs: { hidden: true } });
    const divider = el('div', {
      class: 'video-slider__divider',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': '拖动分割线对比两侧画面（方向键微调）',
        'aria-valuemin': '2',
        'aria-valuemax': '98',
        'aria-valuenow': String(Math.round(state.divider * 100)),
        tabindex: '0',
      },
    });
    divider.style.left = `${state.divider * 100}%`;
    const leftTag = el('span', {
      class: 'video-pane__tag',
      text: state.leftPath ? `左：${truncateFileName(fileName(state.leftPath))}` : '左路未选',
      title: state.leftPath ?? '',
    });
    const rightTag = el('span', {
      class: 'video-pane__tag video-pane__tag--right',
      text: state.rightPath ? `右：${truncateFileName(fileName(state.rightPath))}` : '右路未选',
      title: state.rightPath ?? '',
    });
    const sliderEl = el(
      'div',
      { class: 'video-slider' },
      created.canvas,
      badge,
      divider,
      leftTag,
      rightTag,
    );
    area.appendChild(sliderEl);
    panes = [{ canvas: created.canvas, path: null, badge, detach: created.detach }];
    dividerEl = divider;
    attachDivider(divider, created.canvas);
    sliderSourceSelects = {
      left: createSourceSelect('左路', (value) => {
        state.leftPath = value || null;
        refreshVideos();
        syncSliderTags();
        scheduleDraw();
      }),
      right: createSourceSelect('右路', (value) => {
        state.rightPath = value || null;
        refreshVideos();
        syncSliderTags();
        scheduleDraw();
      }),
      leftLabel: leftTag,
      rightTag,
    };
    syncSliderTags();
  }

  function createSourceSelect(label: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', {
      class: 'select video-stage__select',
      attrs: { 'aria-label': label },
      on: { change: () => onChange(select.value) },
    }) as HTMLSelectElement;
    for (const path of sources) {
      const option = el('option', {
        text: truncateFileName(fileName(path)),
        attrs: { value: path, title: path },
      });
      select.appendChild(option);
    }
    return select;
  }

  function syncSliderTags(): void {
    if (!sliderSourceSelects) return;
    const { left, right, leftLabel, rightTag } = sliderSourceSelects;
    left.value = state.leftPath ?? '';
    right.value = state.rightPath ?? '';
    leftLabel.textContent = state.leftPath
      ? `左：${truncateFileName(fileName(state.leftPath))}`
      : '左路未选';
    leftLabel.title = state.leftPath ?? '';
    rightTag.textContent = state.rightPath
      ? `右：${truncateFileName(fileName(state.rightPath))}`
      : '右路未选';
    rightTag.title = state.rightPath ?? '';
  }

  function buildGrid(): void {
    const { rows, cols } = gridLayout(sources.length);
    gridRows = rows;
    const grid = el('div', {
      class: 'video-grid',
      style: { 'grid-template-columns': `repeat(${cols}, minmax(0, 1fr))` },
    });
    const count = rows * cols;
    for (let index = 0; index < count; index += 1) {
      const current = resolveCellVideo(index, state.cellPaths, state.leftPath ?? '', sources);
      const created = createInteractiveCanvas(current, `第 ${index + 1} 格`);
      const badge = el('span', { class: 'video-pane__badge', attrs: { hidden: true } });
      const select = el('select', {
        class: 'select video-cell__select',
        attrs: { 'aria-label': `第 ${index + 1} 格显示哪段视频`, title: `第 ${index + 1} 格` },
        on: {
          change: () => {
            const count = gridCellCount(sources.length);
            if (!state.cellPaths || state.cellPaths.length < count) {
              state.cellPaths = Array.from(
                { length: count },
                (_, slot) => state.cellPaths?.[slot] ?? null,
              );
            }
            state.cellPaths[index] = select.value; // '' = 显式留空
            refreshVideos();
            scheduleDraw();
          },
        },
      }) as HTMLSelectElement;
      select.appendChild(el('option', { text: '（空）', attrs: { value: '' } }));
      for (const path of sources) {
        select.appendChild(
          el('option', {
            text: truncateFileName(fileName(path)),
            attrs: { value: path, title: path },
          }),
        );
      }
      select.value = current ?? '';
      grid.appendChild(
        el('div', { class: 'video-pane video-pane--cell' }, created.canvas, select, badge),
      );
      panes.push({
        canvas: created.canvas,
        path: null,
        cellIndex: index,
        badge,
        select,
        detach: created.detach,
      });
    }
    area.appendChild(grid);
    gridEl = grid;
    applyGridMetrics();
  }

  /** 网格行高：普通态填满画面区；放大态每行保底 180px 并允许滚动。 */
  function applyGridMetrics(): void {
    if (!gridEl) return;
    gridEl.style.setProperty(
      'grid-template-rows',
      state.gridZoomed
        ? `repeat(${gridRows}, minmax(${GRID_ZOOM_ROW_MIN_PX}px, auto))`
        : `repeat(${gridRows}, minmax(0, 1fr))`,
    );
    area.classList.toggle('is-zoomed', state.gridZoomed);
  }

  function renderArea(force: boolean, releaseUnused = true): void {
    const key = areaKey();
    if (!force && key === areaSignature) return;
    areaSignature = key;
    pause();
    stale = false;
    for (const pane of panes) pane.detach();
    panes = [];
    dividerEl = null;
    gridEl = null;
    sliderSourceSelects = null;
    extrasKey = '';
    area.className = `video-stage__area is-${state.mode}`;
    area.replaceChildren();
    if (state.mode === 'split') renderSplit();
    else if (state.mode === 'slider') buildSlider();
    else buildGrid();
    syncBar();
    refreshVideos(releaseUnused);
    scheduleDraw();
  }

  // ---------- 工具条 ----------

  function syncBar(): void {
    const wantsSelects = state.mode === 'slider' && sliderSourceSelects !== null;
    const wantsZoom = state.mode === 'grid';
    const key = `${state.mode}|${sources.join('')}`;

    if (key !== extrasKey) {
      extrasKey = key;
      barExtras.replaceChildren();
      gridZoomButton = null;
      if (wantsSelects && sliderSourceSelects) {
        barExtras.append(
          el('span', { class: 'video-stage__select-label', text: '左路' }),
          sliderSourceSelects.left,
          el('span', { class: 'video-stage__select-label', text: '右路' }),
          sliderSourceSelects.right,
        );
      }
      if (wantsZoom) {
        gridZoomButton = button({
          label: gridZoomLabel(state.gridZoomed),
          size: 'sm',
          variant: 'quiet',
          title: '放大/还原网格：放大后每格保底可用高度，多源时随画面区滚动',
          onClick: () => {
            state.gridZoomed = !state.gridZoomed;
            if (gridZoomButton) gridZoomButton.textContent = gridZoomLabel(state.gridZoomed);
            applyGridMetrics();
            state.viewport = null;
            scheduleDraw();
          },
        });
        barExtras.appendChild(gridZoomButton);
      }
    } else if (gridZoomButton) {
      gridZoomButton.textContent = gridZoomLabel(state.gridZoomed);
    }

    if (wantsSelects) syncSliderTags();
    else sliderSourceSelects = null;
    syncGridSelects();
  }

  /** 网格格子的下拉回写状态（行点击联动 / 外部改选路后保持 UI 一致）。 */
  function syncGridSelects(): void {
    for (const pane of panes) {
      if (!pane.select || pane.cellIndex === undefined) continue;
      pane.select.value =
        resolveCellVideo(pane.cellIndex, state.cellPaths, state.leftPath ?? '', sources) ?? '';
    }
  }

  const commands: VideoStageCommands = {
    step: (delta) => stepBy(delta),
    first: () => jumpTo('first'),
    last: () => jumpTo('last'),
    togglePlay: () => togglePlay(),
    setMode: (mode) => setMode(mode),
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(1 / 1.25),
    fit: () => fitView(),
  };
  activeCommands = commands;

  function setMode(mode: string): void {
    if (mode !== 'split' && mode !== 'slider' && mode !== 'grid') return;
    if (state.mode === mode) return;
    pause();
    state.mode = mode;
    state.viewport = null;
    modes.setValue(mode);
    renderArea(true);
  }

  // ---------- 时间轴与步进 ----------

  function syncTimeline(): void {
    const duration = timelineDuration();
    const fps = stepFps();
    const frameTotal = estimateFrameTotal(duration, fps);
    timeline.slider.disabled = duration <= 0;
    timeline.slider.max = String(duration > 0 ? duration : 0);
    timeline.slider.step = fps ? String(1 / fps) : '0.01';
    timeline.slider.value = String(duration > 0 ? Math.min(state.time, duration) : 0);
    const frameIndex = fps ? frameIndexAt(state.time, fps) : 0;
    // 显示序号钳到总帧数：scrub 到 duration 时 floor(t*fps) 会多出一帧。
    const frameNumber = frameTotal > 0 ? Math.min(frameIndex + 1, frameTotal) : frameIndex + 1;
    timeline.slider.setAttribute(
      'aria-valuetext',
      duration > 0
        ? `${formatTimestamp(state.time)}${fps ? `，第 ${frameNumber} 帧` : ''}`
        : '时长未知',
    );
    timeline.frame.textContent = fps
      ? frameTotal > 0
        ? `帧 ${frameNumber} / ${frameTotal}`
        : `帧 ${frameNumber}`
      : '帧 —';
    timeline.time.textContent =
      duration > 0 ? `${formatTimestamp(state.time)} / ${formatTimestamp(duration)}` : '— / —';
    timeline.fps.textContent = fps ? `${formatFps(fps)} fps` : 'fps 未知';
    timeline.frameLength.textContent = fps
      ? `帧长 ${frameLengthMs(fps).toFixed(1)} ms`
      : '帧长 —';
    timeline.stepBack.disabled = !fps;
    timeline.stepForward.disabled = !fps;
    timeline.play.disabled = duration <= 0;
    timeline.stepBack.title = fps
      ? `后退一帧（←）：帧长 ${frameLengthMs(fps).toFixed(1)} ms`
      : probeUnavailableHint();
    timeline.stepForward.title = fps
      ? `前进一帧（→）：帧长 ${frameLengthMs(fps).toFixed(1)} ms`
      : probeUnavailableHint();
    timeline.syncHint.hidden = !stale;
    syncPlayButton();
  }

  let playIconState: 'play' | 'pause' | null = null;

  function syncPlayButton(): void {
    const next = state.playing ? 'pause' : 'play';
    if (playIconState !== next) {
      playIconState = next;
      timeline.play.replaceChildren(icon(next));
    }
    timeline.play.setAttribute('aria-label', state.playing ? '暂停（空格）' : '播放（空格）');
    timeline.play.title = state.playing ? '暂停（空格）' : '播放（空格）';
  }

  async function seekAndDraw(): Promise<void> {
    state.time = clampTime(state.time, timelineDuration());
    const result = await media.seekAll(displayedPaths(), state.time);
    stale = result === 'stale';
    scheduleDraw();
  }

  function stepBy(delta: number): void {
    const fps = stepFps();
    if (!fps) {
      toast(probeUnavailableHint(), 'danger');
      return;
    }
    pause();
    state.time = stepFrames(state.time, fps, timelineDuration(), delta);
    syncTimeline();
    void seekAndDraw();
  }

  /** Home/End：首帧 / 末帧（末帧按当前帧长回退一格，避免落到 duration 上无可画帧）。 */
  function jumpTo(where: 'first' | 'last'): void {
    const duration = timelineDuration();
    if (duration <= 0) return;
    pause();
    const fps = stepFps();
    state.time =
      where === 'first' ? 0 : Math.max(0, duration - (fps ? 1 / fps : 0.001));
    syncTimeline();
    void seekAndDraw();
  }

  // ---------- 播放 / 暂停（空格） ----------

  function readyElements(): HTMLVideoElement[] {
    return displayedPaths()
      .map((path) => videoElement(path))
      .filter((el): el is HTMLVideoElement => el !== null);
  }

  function togglePlay(): void {
    if (state.playing) pause();
    else play();
  }

  function play(): void {
    const duration = timelineDuration();
    if (duration <= 0) return;
    const elements = readyElements();
    if (elements.length === 0) return;
    if (state.time >= duration - 1e-3) state.time = 0;
    for (const element of elements) {
      try {
        element.currentTime = state.time;
      } catch {
        // 未就绪元素忽略：下一帧 tick 会再对齐。
      }
      void element.play().catch(() => {
        pause();
        toast('播放被系统拒绝，请再点一次播放', 'danger');
      });
    }
    state.playing = true;
    syncPlayButton();
    cancelAnimationFrame(playRaf);
    playRaf = requestAnimationFrame(tick);
  }

  function tick(): void {
    if (!state.playing) return;
    const elements = readyElements();
    const master = elements[0];
    if (!master) {
      pause();
      return;
    }
    const duration = timelineDuration();
    state.time = clampTime(master.currentTime, duration);
    for (const element of elements.slice(1)) {
      if (Math.abs(element.currentTime - state.time) > 0.1) element.currentTime = state.time;
    }
    draw();
    if (state.time >= duration - 2e-3) {
      pause();
      return;
    }
    playRaf = requestAnimationFrame(tick);
  }

  function pause(): void {
    if (!state.playing) return;
    state.playing = false;
    cancelAnimationFrame(playRaf);
    const elements = readyElements();
    const master = elements[0];
    for (const element of elements) element.pause();
    if (master) state.time = clampTime(master.currentTime, timelineDuration());
    syncPlayButton();
    scheduleDraw();
  }

  // ---------- 绘制 ----------

  function scheduleDraw(): void {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      draw();
    });
  }

  function ensureFitted(): void {
    if (state.viewport) return;
    const pane = panes[0];
    if (!pane) return;
    const rect = pane.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    for (const path of displayedPaths()) {
      const snapshot = peekVideo(path);
      if (snapshot && snapshot.status === 'ready' && snapshot.width > 0) {
        state.viewport = fitViewport(
          { width: snapshot.width, height: snapshot.height },
          { width: Math.round(rect.width), height: Math.round(rect.height) },
        );
        return;
      }
    }
  }

  function drawSourceInto(
    target: ReturnType<typeof prepareCanvas>,
    path: string | null,
  ): void {
    if (!target || !path || !state.viewport) return;
    const snapshot = peekVideo(path);
    const element = videoElement(path);
    if (!snapshot || snapshot.status !== 'ready' || !element || element.readyState < 2) return;
    drawSource(target.ctx, target.size, element, snapshot.width, snapshot.height, state.viewport);
  }

  function draw(): void {
    if (!root.isConnected) return;
    ensureFitted();
    if (state.mode === 'slider') {
      const pane = panes[0];
      if (pane) {
        const prepared = prepareCanvas(pane.canvas);
        if (prepared) {
          // 先整幅画右路，再裁左半幅画左路——共享同一视口与时间点。
          drawSourceInto(prepared, state.rightPath);
          prepared.ctx.save();
          prepared.ctx.beginPath();
          prepared.ctx.rect(0, 0, state.divider * prepared.size.width, prepared.size.height);
          prepared.ctx.clip();
          drawSourceInto(prepared, state.leftPath);
          prepared.ctx.restore();
          if (dividerEl) {
            dividerEl.style.left = `${state.divider * prepared.size.width}px`;
            dividerEl.setAttribute(
              'aria-valuenow',
              String(Math.round(state.divider * 100)),
            );
          }
        }
      }
    } else {
      for (const pane of panes) {
        const prepared = prepareCanvas(pane.canvas);
        if (!prepared) continue;
        const path =
          state.mode === 'split'
            ? pane.path
            : pane.cellIndex === undefined
              ? null
              : resolveCellVideo(
                  pane.cellIndex,
                  state.cellPaths,
                  state.leftPath ?? '',
                  sources,
                );
        drawSourceInto(prepared, path);
      }
    }
    syncPaneBadges();
    syncOverlay();
    syncTimeline();
  }

  function paneStatus(path: string | null): { text: string; visible: boolean } {
    if (!path) return { text: '', visible: false };
    const snapshot = peekVideo(path);
    if (!snapshot || snapshot.status === 'loading') return { text: '加载中', visible: true };
    if (snapshot.status === 'error') return { text: '无法解码', visible: true };
    const element = videoElement(path);
    if (!element || element.readyState < 2) return { text: '解码中', visible: true };
    return { text: '', visible: false };
  }

  function syncPaneBadges(): void {
    for (const pane of panes) {
      const path =
        state.mode === 'split'
          ? pane.path
          : pane.cellIndex === undefined
            ? null
            : resolveCellVideo(pane.cellIndex, state.cellPaths, state.leftPath ?? '', sources);
      const status = paneStatus(path);
      pane.badge.textContent = status.text;
      pane.badge.hidden = !status.visible;
    }
  }

  // ---------- 覆盖层（DOM，不画在 canvas 上） ----------

  function syncOverlay(): void {
    const paths = displayedPaths();
    const snapshots = paths.map((path) => peekVideo(path));
    let key = 'none';
    if (sources.length < 2) key = 'empty';
    else if (paths.length === 0) key = 'none';
    else {
      const errorIndex = snapshots.findIndex((snapshot) => snapshot?.status === 'error');
      if (errorIndex >= 0) {
        const snapshot = snapshots[errorIndex] as VideoSnapshot;
        key = `error:${paths[errorIndex]}:${snapshot.errorCode}:${snapshot.errorText ?? ''}`;
      } else if (!snapshots.some((snapshot) => snapshot?.status === 'ready')) {
        key = 'loading';
      }
    }
    overlay.hidden = key === 'none';
    paint(overlay, key, () => {
      if (key === 'empty') {
        return emptyState({
          title: '还差一段视频才能逐帧对比',
          hint: '在右侧检视器选一段原视频，再添加至少一段跑分视频。',
          className: 'video-stage__empty',
          actions: [
            button({
              label: '选择原视频',
              variant: 'primary',
              onClick: () => void pickVideoReference(groupId, roundId),
            }),
            button({
              label: '添加跑分视频',
              onClick: () => void pickVideoCandidates(groupId, roundId),
            }),
          ],
        });
      }
      if (key === 'loading') {
        return el(
          'div',
          { class: 'video-stage__loading', attrs: { role: 'status', 'aria-live': 'polite' } },
          spinner('正在解码视频…'),
          el('span', { text: '正在解码视频…' }),
        );
      }
      if (key.startsWith('error:')) {
        const path = paths[snapshots.findIndex((snapshot) => snapshot?.status === 'error')] ?? '';
        const snapshot = peekVideo(path);
        const isReference = path !== '' && path === referencePath;
        return el(
          'div',
          { class: 'video-stage__error', attrs: { role: 'alert' } },
          el('p', { class: 'video-stage__error-title', text: '这段视频无法显示' }),
          el('p', {
            class: 'video-stage__error-text',
            text: videoLoadErrorMessage(snapshot?.errorCode ?? 0, path),
          }),
          snapshot?.errorText
            ? el('p', { class: 'video-stage__error-detail', text: snapshot.errorText })
            : null,
          el(
            'div',
            { class: 'video-stage__error-actions' },
            button({
              label: '重试',
              icon: 'refresh',
              variant: 'primary',
              onClick: () => {
                media.invalidate(path);
                media.acquire(path);
                void seekAndDraw();
              },
            }),
            button({
              label: isReference ? '换原视频' : '换一段对比',
              onClick: () =>
                void (isReference
                  ? pickVideoReference(groupId, roundId)
                  : pickVideoCandidates(groupId, roundId)),
            }),
          ),
        );
      }
      return el('div');
    });
  }

  // ---------- 媒体就绪 / seek 对齐 ----------

  function refreshVideos(releaseUnused = true): void {
    const wanted = new Set(displayedPaths());
    if (referencePath) wanted.add(referencePath);
    for (const path of wanted) media.acquire(path);
    const keep = [...sources];
    if (releaseUnused) media.releaseUnused(keep);
    media.trim(MAX_DECODED_VIDEOS, keep);
  }

  async function alignToSharedTime(): Promise<void> {
    if (state.playing) {
      scheduleDraw();
      return;
    }
    const result = await media.seekAll(displayedPaths(), state.time);
    stale = result === 'stale';
    scheduleDraw();
  }

  // ---------- 交互接线 ----------

  function attachDivider(divider: HTMLElement, canvas: HTMLCanvasElement): void {
    let dragging = false;
    const applyRatio = (ratio: number): void => {
      state.divider = Math.min(0.98, Math.max(0.02, ratio));
      divider.style.left = `${state.divider * 100}%`;
      divider.setAttribute('aria-valuenow', String(Math.round(state.divider * 100)));
      scheduleDraw();
    };
    divider.addEventListener('pointerdown', (event) => {
      dragging = true;
      pause();
      divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    divider.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      applyRatio((event.clientX - rect.left) / rect.width);
    });
    const stop = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
    divider.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyRatio(state.divider - step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyRatio(state.divider + step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyRatio(0.02);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyRatio(0.98);
      }
    });
  }

  timeline.stepBack.addEventListener('click', () => stepBy(-1));
  timeline.stepForward.addEventListener('click', () => stepBy(1));
  timeline.play.addEventListener('click', () => togglePlay());
  timeline.slider.addEventListener('input', () => {
    pause();
    state.time = clampTime(Number.parseFloat(timeline.slider.value), timelineDuration());
    syncTimeline();
    void seekAndDraw();
  });
  // 拖动时间轴本身不切段；这里只保证键盘/程序改动都会落到共享时间点。
  timeline.slider.addEventListener('change', () => {
    state.time = clampTime(Number.parseFloat(timeline.slider.value), timelineDuration());
    void seekAndDraw();
  });

  function zoomBy(factor: number): void {
    ensureFitted();
    if (!state.viewport) return;
    state.viewport = withZoom(state.viewport, state.viewport.zoom * factor);
    scheduleDraw();
  }

  function fitView(): void {
    state.viewport = null;
    scheduleDraw();
  }

  // ---------- 状态同步 ----------

  function currentRound(): Round | null {
    const workspace = getState().workspace;
    const group = workspace?.groups.find((item) => item.id === groupId);
    if (!group || group.kind !== 'video') return null;
    return group.rounds.find((item) => item.id === roundId) ?? null;
  }

  function applyActiveCandidate(): void {
    const active = getActiveCandidate(roundId);
    if (active === lastActiveCandidate) return;
    lastActiveCandidate = active;
    if (!active || !sources.includes(active)) return;
    if (state.mode === 'slider' && active !== state.leftPath) {
      state.rightPath = active;
      syncSliderTags();
    } else if (state.mode === 'grid') {
      const count = gridCellCount(sources.length);
      if (!state.cellPaths || state.cellPaths.length < count) {
        state.cellPaths = Array.from(
          { length: count },
          (_, slot) => state.cellPaths?.[slot] ?? null,
        );
      }
      state.cellPaths[1] = active;
      syncGridSelects();
    }
    refreshVideos();
    syncBar();
    scheduleDraw();
  }

  function update(): void {
    const next = currentRound();
    if (!next) return;
    round = next;
    const nextReference = round.videoReferencePath ?? null;
    const nextSources = videoSources(nextReference, candidatePaths(round));
    const changed =
      nextReference !== referencePath ||
      JSON.stringify(nextSources) !== JSON.stringify(sources);
    if (changed) {
      if (nextReference !== referencePath) state.viewport = null; // 新原视频可能不同分辨率
      referencePath = nextReference;
      sources = nextSources;
      normalizeSelection();
      areaSignature = ''; // 源变化：栏位/格子必须重建
      renderArea(true);
    }
    applyActiveCandidate();
    syncBar();
    syncOverlay();
    scheduleDraw();
  }

  const unsubscribeStore = subscribe(update);
  const unsubscribeMedia = subscribeMedia(() => {
    void alignToSharedTime();
  });

  // 首帧：结构 + 预取 + 绘制（不释放其它轮已解码的实例，靠 trim 封顶）
  normalizeSelection();
  renderArea(true, false);

  return {
    update,
    destroy(): void {
      activeCommands = null;
      pause();
      cancelAnimationFrame(drawRaf);
      cancelAnimationFrame(playRaf);
      unsubscribeStore();
      unsubscribeMedia();
      detachSize();
      unregisterDrop();
      for (const pane of panes) pane.detach();
      panes = [];
      media.destroy();
      media.trim(MAX_DECODED_VIDEOS, []);
      state.playing = false;
    },
  };
}
