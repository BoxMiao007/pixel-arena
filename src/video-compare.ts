// 视频逐帧同步对比（T15）：两路视频共享同一时间点定格，缩放平移复用 viewport 模块的
// 「视口状态」（与图片查看器同一套换算，分屏/滑动/2×2 三种模式共享一份状态）。
// 视频元素常驻隐藏池、静音、永远暂停态，画面只随 seek 变化，用 canvas drawImage 画进窗格；
// 任一路 seek 后等全部 seeked 事件齐了再统一重绘，保证两路同帧。
// 时间与帧的换算（帧时长、钳制、时间戳）是纯函数，由 src/video-compare.test.ts 守护。
// 帧率/时长经 ffprobe 读取（IPC video_probe_meta，见 src-tauri/src/video_probe.rs）。

import { Channel, invoke } from '@tauri-apps/api/core';
import {
  fitViewport,
  panBy,
  visibleRegion,
  zoomAt,
  type Size,
  type ViewportState,
} from './viewport';
import { resolveCellImage } from './multiview';
import { fileName, truncateFileName } from './util';

/** video.ts 传进来的上下文：本轮的视频源与状态栏输出 */
export interface VideoCompareCtx {
  roundId: string;
  referencePath: string | null;
  candidatePaths: string[];
  setStatus(text: string, isError?: boolean): void;
}

/** ffprobe 读到的视频元信息（video_probe_meta 的返回，camelCase） */
interface VideoMeta {
  width: number;
  height: number;
  fps: number;
  durationSecs: number;
}

type CompareMode = 'split' | 'slider' | 'multiview2';

/** 缩放≥100% 后关闭平滑，按最近邻显示原始像素（与图片查看器的像素级查看一致） */
const NEAREST_ZOOM = 1;

// ---------- 纯函数（video-compare.test.ts 守护） ----------

/** 本轮可选的视频源：原视频排最前，跑分视频按加入顺序跟后 */
export function videoSources(referencePath: string | null, candidatePaths: string[]): string[] {
  return referencePath ? [referencePath, ...candidatePaths] : [...candidatePaths];
}

/** 默认两路：左=原视频（第一项），右=第一段跑分视频（第二项）；不足两段不可对比 */
export function defaultPair(sources: string[]): { left: string; right: string } | null {
  if (sources.length < 2) return null;
  return { left: sources[0], right: sources[1] };
}

/** 时间钳制到 [0, duration]；时长未知（0）时归 0，非法值归 0 */
export function clampTime(t: number, duration: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(0, t), Math.max(0, duration));
}

/** 时间点所在帧序号 = floor(t*fps)；加浮点容差避免 0.4999999 归错帧 */
export function frameIndexAt(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-6);
}

/** +1 帧后的时间点：从当前帧序号跳到下一帧边界，钳制在时长内 */
export function nextFrameTime(t: number, fps: number, duration: number): number {
  return clampTime((frameIndexAt(t, fps) + 1) / fps, duration);
}

/** -1 帧后的时间点：恰在帧界退到上一帧，帧中落回本帧开头，钳制在 [0, duration] */
export function prevFrameTime(t: number, fps: number, duration: number): number {
  const index = frameIndexAt(t, fps);
  const onBoundary = Math.abs(t - index / fps) < 1e-6;
  return clampTime((onBoundary ? index - 1 : index) / fps, duration);
}

/** 多路时长的交集（最小值）：时间轴以最短的一路为准；未就绪的 0 忽略，全未知为 0 */
export function minDuration(durations: number[]): number {
  const positive = durations.filter((d) => d > 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

/** 时间戳格式化：分:秒.毫秒（毫秒三位，四舍五入进位） */
export function formatTimestamp(t: number): string {
  const totalMs = Math.max(0, Math.round(t * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = (totalMs - minutes * 60000) / 1000;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(3)}`;
}

/** 多视图第 index 格的选路：显式选择仍有效则用之（''=显式留空），否则回落默认布局。
 *  复用 multiview 的 resolveCellImage：把左路当「参考」，其余源当「候选」。
 *  视频侧只有 2×2 一种网格，本侧 cellPaths 保持扁平数组，经 tier 2 桶适配新签名（T19）。 */
export function resolveCellVideo(
  index: number,
  cellPaths: (string | null)[] | null,
  leftPath: string,
  sources: string[],
): string | null {
  return resolveCellImage(
    { viewport: null, cellPaths: cellPaths ? { 2: cellPaths } : {} },
    2,
    index,
    {
      referencePath: leftPath,
      candidates: sources.filter((p) => p !== leftPath).map((path) => ({ path })),
    },
  );
}

// ---------- 查看器界面状态（跟随评测轮，不持久化，重启归零） ----------

let state: {
  roundId: string;
  mode: CompareMode;
  /** 左路 = 基准路：分屏/滑动的左栏，多视图第 0 格默认，帧步进的步长取自它 */
  leftPath: string | null;
  rightPath: string | null;
  /** 多视图每格显式选路（''=显式留空，null=默认布局），语义与 multiview 的 cellPaths 一致 */
  cellPaths: (string | null)[] | null;
  divider: number;
  viewport: ViewportState | null;
  /** 两路共享的当前时间点（秒） */
  time: number;
} | null = null;

// 本轮的源列表与状态栏输出（挂载时更新；元素级事件回调经模块级变量拿到当前上下文）
let sources: string[] = [];
let probeStatus: ((text: string, isError?: boolean) => void) | null = null;

// ---------- 视频解码缓存（会话级，与 viewer.ts 的 imageCache 同思路，不淘汰） ----------

interface VideoEntry {
  status: 'loading' | 'ready' | 'error';
  el?: HTMLVideoElement;
  width: number;
  height: number;
  duration: number;
  /** ffprobe 帧率；null = 未知（探测失败或仍在探测），逐帧步进禁用 */
  fps: number | null;
  /** 加载失败的原因分类（MediaError.code），用于给用户准确的中文提示 */
  errorCode: number;
  listeners: Array<() => void>;
}

/**
 * MediaError.code → 中文提示。code 2（网络/读取失败）与 code 3/4（解码失败/格式不支持）
 * 的处置建议不同：前者查文件是否被移动，后者查系统解码器（Linux 端 WebKitGTK 依赖
 * GStreamer 插件，如 H.264 需要 gst-libav）。
 */
export function videoLoadErrorMessage(code: number, path: string): string {
  const name = fileName(path);
  switch (code) {
    case 2:
      return `视频加载失败：${name} 无法读取，可能已被移动、重命名或删除`;
    case 3:
      return `视频解码失败：${name} 的编码格式系统缺少解码器（如 H.264 需安装 gst-libav）`;
    case 4:
      return `视频格式不支持：${name} 不是有效的视频文件`;
    default:
      return `视频加载失败：${name} 格式可能不受支持或已被移动、删除`;
  }
}

const videoCache = new Map<string, VideoEntry>();

// 隐藏池：部分内核（WebKitGTK 系）对不在文档里的媒体元素解码不可靠，统一挂 body 下的离屏容器
let pool: HTMLDivElement | null = null;

// ---------- seek 同步：等全部 seeked 齐了再统一重绘（两路同帧的关键） ----------

// 当前挂载的重绘调度；视频元素的 seeked/error 事件经它转发给正在显示的实例（重挂即换新）
let notifyDraw: (() => void) | null = null;
const pendingSeeks = new Set<HTMLVideoElement>();
let seekSafety = 0; // seeked 迟迟不来（坏文件）的兜底定时器

function seekVideo(el: HTMLVideoElement, t: number): void {
  if (Math.abs(el.currentTime - t) < 5e-4) return; // 已在该时间点（含刚 seek 完）
  el.currentTime = t;
  pendingSeeks.add(el);
  window.clearTimeout(seekSafety);
  seekSafety = window.setTimeout(() => {
    pendingSeeks.clear();
    notifyDraw?.();
  }, 2000);
}

// ---------- ffprobe 元信息探测（串行化，避免 ffprobe 缺失时并发触发多次下载） ----------

let probeChain: Promise<unknown> = Promise.resolve();

function probeMeta(path: string): Promise<VideoMeta | null> {
  const run = probeChain.then(async () => {
    try {
      const channel = new Channel<string>();
      channel.onmessage = (message) => probeStatus?.(message);
      return await invoke<VideoMeta>('video_probe_meta', { path, onProgress: channel });
    } catch {
      return null; // ffprobe 不可用或文件损坏：帧率未知，界面降级（步进禁用），不弹错误
    }
  });
  probeChain = run.catch(() => undefined);
  return run;
}

function ensureVideo(path: string, onReady: () => void): VideoEntry {
  let entry = videoCache.get(path);
  if (!entry) {
    entry = {
      status: 'loading',
      width: 0,
      height: 0,
      duration: 0,
      fps: null,
      errorCode: 0,
      listeners: [],
    };
    videoCache.set(path, entry);

    if (!pool) {
      pool = document.createElement('div');
      pool.className = 'video-compare-pool';
      pool.ariaHidden = 'true';
      document.body.append(pool);
    }
    const el = document.createElement('video');
    // 逐帧对比永远暂停态：静音、不自动播放，画面只随 seek 变化
    el.muted = true;
    el.preload = 'auto';
    // 源地址走应用内置回环流服务（IPC video_stream_url）：Linux 端 WebKitGTK 的媒体引擎
    // 不走 asset 自定义协议（SRC_NOT_SUPPORTED，实测 2.52.6），HTTP 回流三端一致。
    // 不设 crossOrigin：只 drawImage 不读像素，画布污染无害。
    pool.append(el);

    const settle = (ok: boolean) => {
      const e = videoCache.get(path);
      if (!e) return;
      e.status = ok ? 'ready' : 'error';
      if (ok) {
        e.el = el;
        e.width = el.videoWidth;
        e.height = el.videoHeight;
        e.duration = Number.isFinite(el.duration) ? el.duration : 0;
        // 新载入的视频停在 0：就绪后把画面带到共享时间点
        if (state && Math.abs(el.currentTime - state.time) > 5e-4) seekVideo(el, state.time);
      }
      for (const fn of e.listeners) fn();
      e.listeners = [];
    };
    el.addEventListener('loadeddata', () => settle(true)); // 首帧可解码，可画
    el.addEventListener('error', () => {
      const e = videoCache.get(path);
      if (e) e.errorCode = el.error?.code ?? 0;
      settle(false);
    });
    el.addEventListener('seeked', () => {
      pendingSeeks.delete(el);
      if (pendingSeeks.size === 0) notifyDraw?.(); // 全部齐了才统一重绘
    });

    // 流地址就绪后才开始加载（注册是同步 IPC，几十微秒级）
    void invoke<string>('video_stream_url', { path }).then((url) => {
      const e = videoCache.get(path);
      if (!e || e.el) return; // 条目已被丢弃或已就绪
      el.src = url;
    });

    // 帧率探测与加载并行；探测失败只禁用逐帧步进，不影响查看与时间轴
    void probeMeta(path).then((meta) => {
      const e = videoCache.get(path);
      if (e && meta && meta.fps > 0) e.fps = meta.fps;
      notifyDraw?.();
    });
  }
  if (entry.status === 'loading') entry.listeners.push(onReady);
  return entry;
}

// ---------- 挂载 ----------

/** 把逐帧对比挂到 host 上（host 原有内容被替换）。源不足两段时只显示一行说明。 */
export function mountVideoCompare(host: HTMLElement, ctx: VideoCompareCtx): void {
  sources = videoSources(ctx.referencePath, ctx.candidatePaths);
  probeStatus = ctx.setStatus;

  if (sources.length < 2) {
    state = null;
    const hint = document.createElement('p');
    hint.className = 'content-placeholder';
    hint.textContent = '逐帧对比：先选原视频并添加跑分视频（至少两段）后可用。';
    host.replaceChildren(hint);
    return;
  }

  if (!state || state.roundId !== ctx.roundId) {
    const pair = defaultPair(sources);
    state = {
      roundId: ctx.roundId,
      mode: 'split',
      leftPath: pair?.left ?? sources[0] ?? null,
      rightPath: pair?.right ?? sources[1] ?? null,
      cellPaths: null,
      divider: 0.5,
      viewport: null,
      time: 0,
    };
  }
  // 源可能被移除：失效回落到默认两路
  if (!state.leftPath || !sources.includes(state.leftPath)) {
    state.leftPath = sources[0] ?? null;
    state.viewport = null;
  }
  if (!state.rightPath || !sources.includes(state.rightPath)) {
    state.rightPath = sources[1] ?? null;
    state.viewport = null;
  }

  const box = document.createElement('div');
  box.className = 'video-compare';

  const title = document.createElement('div');
  title.className = 'video-compare-title';
  title.textContent = '逐帧对比';
  title.title =
    '两路画面共享同一时间点定格；时间轴与 ±1 帧两路同时 seek，等 seeked 齐了才重绘，保证同帧';

  // ----- 工具条：模式切换 + 左右路选择 -----
  const bar = document.createElement('div');
  bar.className = 'viewer-bar';

  const modes = document.createElement('div');
  modes.className = 'viewer-modes';
  modes.role = 'group';
  modes.ariaLabel = '逐帧对比模式';
  const MODES: Array<{ id: CompareMode; label: string }> = [
    { id: 'split', label: '分屏' },
    { id: 'slider', label: '滑动' },
    { id: 'multiview2', label: '2×2 网格' },
  ];
  const modeButtons = new Map<CompareMode, HTMLButtonElement>();
  for (const { id, label } of MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (!state || state.mode === id) return;
      state.mode = id;
      state.viewport = null; // 切模式窗格几何变了，重新 fit（沿用图片查看器行为）
      mountVideoCompare(host, ctx);
    });
    modeButtons.set(id, btn);
    modes.append(btn);
  }
  const syncModeButtons = (): void => {
    for (const [id, btn] of modeButtons) btn.classList.toggle('active', state!.mode === id);
  };

  bar.append(modes);

  let leftSelect: HTMLSelectElement | null = null;
  let rightSelect: HTMLSelectElement | null = null;
  if (state.mode !== 'multiview2') {
    // 分屏/滑动：左右两路下拉（多视图用每格自己的下拉，见下）
    const buildSourceSelect = (value: string | null): HTMLSelectElement => {
      const select = document.createElement('select');
      for (const path of sources) {
        const option = document.createElement('option');
        option.value = path;
        // T18：下拉选项统一中间截断，悬浮 title 看全路径
        option.textContent = truncateFileName(fileName(path));
        option.title = path;
        select.append(option);
      }
      select.value = value ?? '';
      return select;
    };
    const leftLabel = document.createElement('label');
    leftLabel.className = 'viewer-cand';
    leftLabel.textContent = '左路';
    leftSelect = buildSourceSelect(state.leftPath);
    leftLabel.append(leftSelect);
    const rightLabel = document.createElement('label');
    rightLabel.className = 'viewer-cand';
    rightLabel.textContent = '右路';
    rightSelect = buildSourceSelect(state.rightPath);
    rightLabel.append(rightSelect);
    bar.append(leftLabel, rightLabel);
  }

  const hint = document.createElement('span');
  hint.className = 'viewer-hint';
  hint.textContent = '滚轮缩放 · 拖拽平移 · 双击复位';
  bar.append(hint);
  syncModeButtons();

  // ----- 画布区 -----
  const area = document.createElement('div');
  area.className = 'viewer-area';

  interface Pane {
    canvas: HTMLCanvasElement;
  }
  const panes: Pane[] = [];
  let dividerEl: HTMLDivElement | null = null;

  if (state.mode === 'multiview2') {
    area.className = 'viewer-area grid';
    const grid = document.createElement('div');
    grid.className = 'viewer-grid';
    grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    grid.style.gridTemplateRows = 'repeat(2, 1fr)';
    for (let i = 0; i < 4; i++) {
      const pane = document.createElement('div');
      pane.className = 'viewer-pane';
      const canvas = document.createElement('canvas');
      const select = document.createElement('select');
      select.className = 'viewer-cell-select';
      select.title = `格 ${i + 1}：选本格显示的视频`;
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '（空）';
      select.append(emptyOption);
      for (const path of sources) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = truncateFileName(fileName(path));
        option.title = path;
        select.append(option);
      }
      select.value = state.leftPath
        ? resolveCellVideo(i, state.cellPaths, state.leftPath, sources) ?? ''
        : '';
      select.addEventListener('change', () => {
        if (!state) return;
        // 首次手动改选才落状态
        if (!state.cellPaths || state.cellPaths.length < 4) {
          state.cellPaths = Array.from({ length: 4 }, (_, k) => state!.cellPaths?.[k] ?? null);
        }
        state.cellPaths[i] = select.value; // '' = 显式留空
        refreshVideos();
        scheduleDraw();
      });
      pane.append(canvas, select);
      grid.append(pane);
      panes.push({ canvas });
    }
    area.append(grid);
  } else if (state.mode === 'split') {
    area.className = 'viewer-area split';
    const left = document.createElement('div');
    left.className = 'viewer-pane';
    const right = document.createElement('div');
    right.className = 'viewer-pane';
    const leftCanvas = document.createElement('canvas');
    const rightCanvas = document.createElement('canvas');
    const leftTag = document.createElement('span');
    leftTag.className = 'viewer-tag';
    leftTag.textContent = '左路';
    const rightTag = document.createElement('span');
    rightTag.className = 'viewer-tag';
    rightTag.textContent = '右路';
    left.append(leftCanvas, leftTag);
    right.append(rightCanvas, rightTag);
    area.append(left, right);
    panes.push({ canvas: leftCanvas }, { canvas: rightCanvas });
  } else {
    area.className = 'viewer-area';
    const slider = document.createElement('div');
    slider.className = 'viewer-slider';
    const canvas = document.createElement('canvas');
    dividerEl = document.createElement('div');
    dividerEl.className = 'viewer-divider';
    dividerEl.title = '拖动分割线对比两侧画面';
    const handle = document.createElement('div');
    handle.className = 'viewer-handle';
    handle.textContent = '⟷';
    dividerEl.append(handle);
    const leftTag = document.createElement('span');
    leftTag.className = 'viewer-tag';
    leftTag.textContent = '左路';
    const rightTag = document.createElement('span');
    rightTag.className = 'viewer-tag right';
    rightTag.textContent = '右路';
    slider.append(canvas, dividerEl, leftTag, rightTag);
    area.append(slider);
    panes.push({ canvas });
  }

  // ----- 时间轴：±1 帧按钮 + 同步拖动滑杆 + 时间显示 -----
  const timeline = document.createElement('div');
  timeline.className = 'video-timeline';

  const stepBack = document.createElement('button');
  stepBack.type = 'button';
  stepBack.textContent = '−1 帧';
  stepBack.addEventListener('click', () => {
    if (!state) return;
    const fps = stepFps();
    if (!fps) return;
    seekAll(prevFrameTime(state.time, fps, timelineDuration()));
  });

  const stepFwd = document.createElement('button');
  stepFwd.type = 'button';
  stepFwd.textContent = '+1 帧';
  stepFwd.addEventListener('click', () => {
    if (!state) return;
    const fps = stepFps();
    if (!fps) return;
    seekAll(nextFrameTime(state.time, fps, timelineDuration()));
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.001';
  slider.ariaLabel = '视频时间轴（拖动两路同时定位）';
  slider.addEventListener('input', () => {
    seekAll(Number.parseFloat(slider.value));
  });

  const timeLabel = document.createElement('span');
  timeLabel.className = 'video-time';

  timeline.append(stepBack, stepFwd, slider, timeLabel);

  box.append(title, bar, area, timeline);
  host.replaceChildren(box);

  // ----- 重绘调度（rAF 节流）-----
  let rafId = 0;
  function scheduleDraw(): void {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }
  notifyDraw = scheduleDraw;

  // ----- 视频就绪与时间点对齐 -----
  function refreshVideos(): void {
    if (!state) return;
    for (const path of displayedPaths()) {
      const entry = ensureVideo(path, scheduleDraw);
      if (entry.status === 'ready' && entry.el && Math.abs(entry.el.currentTime - state.time) > 5e-4) {
        seekVideo(entry.el, state.time);
      }
    }
  }

  function displayedPaths(): string[] {
    const st = state;
    if (!st) return [];
    if (st.mode === 'multiview2') {
      const out: string[] = [];
      if (!st.leftPath) return out;
      for (let i = 0; i < 4; i++) {
        const path = resolveCellVideo(i, st.cellPaths, st.leftPath, sources);
        if (path && !out.includes(path)) out.push(path);
      }
      return out;
    }
    return [st.leftPath, st.rightPath].filter((p): p is string => p !== null);
  }

  function displayedEntries(): VideoEntry[] {
    return displayedPaths()
      .map((path) => videoCache.get(path))
      .filter((e): e is VideoEntry => e !== undefined);
  }

  /** 时间轴总时长 = 当前显示的各路时长最小值（未就绪的忽略） */
  function timelineDuration(): number {
    return minDuration(displayedEntries().map((e) => e.duration));
  }

  /** 步进帧率口径：取当前显示的第一路已知帧率（分屏/滑动即左基准优先），没有则 null */
  function stepFps(): number | null {
    for (const entry of displayedEntries()) {
      if (entry.fps && entry.fps > 0) return entry.fps;
    }
    return null;
  }

  function seekAll(t: number): void {
    if (!state) return;
    state.time = clampTime(t, timelineDuration());
    for (const entry of displayedEntries()) {
      if (entry.status === 'ready' && entry.el) seekVideo(entry.el, state.time);
    }
    if (pendingSeeks.size === 0) scheduleDraw(); // 无需 seek 也要刷新时间轴显示
  }

  // ----- 交互：滚轮缩放（光标锚点）+ 拖拽平移 + 双击复位（与图片查看器同一套视口换算） -----
  function attachPanZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = state;
      if (!st?.viewport) return;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      st.viewport = zoomAt(
        st.viewport,
        factor,
        e.clientX - rect.left,
        e.clientY - rect.top,
        { width: rect.width, height: rect.height },
      );
      scheduleDraw();
    }, { passive: false });

    let panning = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('panning');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panning) return;
      const st = state;
      if (st?.viewport) {
        st.viewport = panBy(st.viewport, e.clientX - lastX, e.clientY - lastY);
        scheduleDraw();
      }
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const stopPan = (): void => {
      panning = false;
      canvas.classList.remove('panning');
    };
    canvas.addEventListener('pointerup', stopPan);
    canvas.addEventListener('pointercancel', stopPan);
    canvas.addEventListener('dblclick', () => {
      if (state) state.viewport = null; // 复位 = 重新按窗格 fit
      scheduleDraw();
    });
  }
  for (const pane of panes) attachPanZoom(pane.canvas);

  // ----- 分割线拖动（滑动模式） -----
  if (dividerEl && panes[0]) {
    const canvas = panes[0].canvas;
    let dragging = false;
    dividerEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      dividerEl!.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    dividerEl.addEventListener('pointermove', (e) => {
      if (!dragging || !state) return;
      const rect = canvas.getBoundingClientRect();
      state.divider = Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width));
      dividerEl!.style.left = `${state.divider * rect.width}px`;
      scheduleDraw();
    });
    const stopDrag = (): void => { dragging = false; };
    dividerEl.addEventListener('pointerup', stopDrag);
    dividerEl.addEventListener('pointercancel', stopDrag);
  }

  // 窗格尺寸变化：重设画布背板并重绘，视口保持不动
  const observer = new ResizeObserver(() => scheduleDraw());
  observer.observe(area);

  // ----- 绘制 -----
  function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; size: Size } | null {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return null;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);
    return { ctx: ctx2d, size: { width: w, height: h } };
  }

  function drawMessage(ctx: CanvasRenderingContext2D, size: Size, msg: string): void {
    ctx.fillStyle = '#9a9a9a';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, size.width / 2, size.height / 2);
  }

  /** 把一路视频的当前帧按共享视口画进窗格；只画可见部分（与图片查看器同一范式） */
  function drawVideo(ctx: CanvasRenderingContext2D, size: Size, path: string | null): void {
    const st = state!;
    if (!path) {
      drawMessage(ctx, size, '（空）');
      return;
    }
    const entry = videoCache.get(path);
    if (!entry || entry.status === 'loading') {
      drawMessage(ctx, size, '正在加载视频…');
      return;
    }
    if (entry.status === 'error' || !entry.el) {
      drawMessage(ctx, size, videoLoadErrorMessage(entry.errorCode, path ?? ''));
      return;
    }
    if (!st.viewport || entry.el.readyState < 2) {
      drawMessage(ctx, size, '正在解码视频帧…');
      return;
    }
    const region = visibleRegion(st.viewport, size, { width: entry.width, height: entry.height });
    if (!region) return;
    ctx.imageSmoothingEnabled = st.viewport.zoom < NEAREST_ZOOM;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      entry.el,
      region.src.x, region.src.y, region.src.width, region.src.height,
      region.dst.x, region.dst.y, region.dst.width, region.dst.height,
    );
  }

  /** 视口待适配时用第一份就绪的帧按窗格尺寸 fit（帧尺寸当图片尺寸） */
  function ensureFitted(): void {
    const st = state!;
    if (st.viewport) return;
    const rect = panes[0]?.canvas.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return;
    const pane = { width: Math.round(rect.width), height: Math.round(rect.height) };
    for (const entry of displayedEntries()) {
      if (entry.status === 'ready' && entry.el && entry.width > 0) {
        st.viewport = fitViewport({ width: entry.width, height: entry.height }, pane);
        return;
      }
    }
  }

  /** 时间轴控件随状态刷新（fps/时长异步就位后自动解锁） */
  function syncTimeline(): void {
    const st = state!;
    const duration = timelineDuration();
    slider.disabled = duration <= 0;
    if (duration > 0) {
      slider.max = String(duration);
      slider.value = String(Math.min(st.time, duration));
    }
    timeLabel.textContent =
      duration > 0 ? `${formatTimestamp(st.time)} / ${formatTimestamp(duration)}` : '— / —';
    const fps = stepFps();
    stepBack.disabled = !fps;
    stepFwd.disabled = !fps;
    const fpsNote = fps
      ? `帧长 ${(1000 / fps).toFixed(1)} ms（fps=${fps}，取自当前显示的第一路）`
      : '帧率未知（ffprobe 不可用或仍在探测），逐帧步进不可用';
    stepBack.title = `后退一帧：${fpsNote}`;
    stepFwd.title = `前进一帧：${fpsNote}`;
  }

  function draw(): void {
    const st = state;
    if (!st || !area.isConnected) return;
    ensureFitted();
    if (st.mode === 'split') {
      const [leftPane, rightPane] = panes;
      const a = prepare(leftPane.canvas);
      const b = prepare(rightPane.canvas);
      if (!a || !b) return;
      for (const p of [a, b]) {
        p.ctx.fillStyle = '#2b2b2b';
        p.ctx.fillRect(0, 0, p.size.width, p.size.height);
      }
      drawVideo(a.ctx, a.size, st.leftPath);
      drawVideo(b.ctx, b.size, st.rightPath);
    } else if (st.mode === 'slider') {
      const prepared = prepare(panes[0].canvas);
      if (!prepared) return;
      const { ctx, size } = prepared;
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(0, 0, size.width, size.height);
      // 右侧整幅画右路，再裁出左半幅画左路——两侧共享同一视口与同一时间点
      drawVideo(ctx, size, st.rightPath);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, st.divider * size.width, size.height);
      ctx.clip();
      drawVideo(ctx, size, st.leftPath);
      ctx.restore();
      if (dividerEl) dividerEl.style.left = `${st.divider * size.width}px`;
    } else {
      for (let i = 0; i < panes.length; i++) {
        const prepared = prepare(panes[i].canvas);
        if (!prepared) continue;
        prepared.ctx.fillStyle = '#2b2b2b';
        prepared.ctx.fillRect(0, 0, prepared.size.width, prepared.size.height);
        const path = st.leftPath
          ? resolveCellVideo(i, st.cellPaths, st.leftPath, sources)
          : null;
        drawVideo(prepared.ctx, prepared.size, path);
      }
    }
    syncTimeline();
  }

  // 左右路下拉（分屏/滑动）：换路后重新对齐到共享时间点
  leftSelect?.addEventListener('change', () => {
    if (!state) return;
    state.leftPath = leftSelect!.value || null;
    refreshVideos();
    scheduleDraw();
  });
  rightSelect?.addEventListener('change', () => {
    if (!state) return;
    state.rightPath = rightSelect!.value || null;
    refreshVideos();
    scheduleDraw();
  });

  refreshVideos();
  scheduleDraw();
}
