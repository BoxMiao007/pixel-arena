// 对比查看器舞台：mount 一次、update 增量；切模式不重挂、不清视口。
//
// 结构（自上而下）：工具栏 / 画布区（分屏 / 单画布+分割线 / 网格）。
// 绘制走 canvas，一帧一次 rAF；模式切换只重建画布区结构，视口沿用（决策「切模式保留视口」）。
//
// 图片经 asset protocol（ui/canvas 的 loadImage）交给 WebView 原生解码，不经 IPC 传像素；
// 画布底色/棋盘格由 CSS 负责，JS 只 clearRect + drawImage（不每帧读 CSS 变量）。

import { getState } from '../../core/store';
import { chooseCandidates, chooseReference } from '../../core/actions';
import { highlightChips, type HighlightChip } from '../../core/highlight';
import { isProxyFormat } from '../../core/model';
import { copyText, fileName, truncateFileName } from '../../core/util';
import { getPref, roundScoped, setPref } from '../../core/ui-state';
import type { MountedView, ViewCtx } from '../../shell/registry';
import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openImageMenu } from '../../ui/image-menu';
import { openMenu, type MenuItem } from '../../ui/overlay';
import { button, emptyState, spinner } from '../../ui/primitives';
import { toast } from '../../ui/toast';
import {
  absoluteViewportFromRelative,
  attachPanZoom,
  drawSource,
  fitViewport,
  invalidateImage,
  isPixelZoom,
  loadImage,
  panBy,
  prepareCanvas,
  relativeViewport,
  screenToImage,
  watchSize,
  zoomAt,
  type ImageEntry,
  type Size,
  type ViewportState,
} from '../../ui/canvas';
import { diffCacheKey, diffExceedsLimit, renderDiffCanvas } from './diff';
import { gridLayout, isPaneSizeSane, paneCount, sameBox } from './layout';
import {
  applyPick,
  defaultLayout,
  reconcileExplicitPaths,
  resolveModeCandidatePath,
  resolvePaneImage,
} from './selection';
import { mountSurface, type PaneStatus, type ViewerSurface } from './surfaces';
import { buildToolbar, type ToolbarHandle } from './toolbar';
import {
  BLINK_INTERVAL_MS,
  LONG_PRESS_CANCEL_PX,
  LONG_PRESS_MS,
  MODE_META,
  isSingleSlotMode,
  normalizeMode,
  type RoundLike,
  type ViewerImage,
  type ViewerMode,
  type ViewerRound,
  type ViewerState,
  defaultViewerState,
} from './types';
import { formatZoomPercent, steppedZoom, ZOOM_PRESETS } from './zoom';

/** 查看器对外的命令面（键位注册用）。 */
export interface ViewerCommands {
  setMode: (mode: ViewerMode) => void;
  toggleBlink: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  oneToOne: () => void;
  isBlinkMode: () => boolean;
  /** 真正挂在文档里才响应键位（外壳若漏了 destroy，键位不会打到已卸载的舞台）。 */
  isMounted: () => boolean;
}

let activeCommands: ViewerCommands | null = null;

/** 当前挂载中的查看器命令面；没挂载时为 null（键位注册用它作为 when 条件）。 */
export function activeViewerCommands(): ViewerCommands | null {
  return activeCommands;
}

/** 后端轮数据 → 查看器用的展示数据（AVIF/JXL 指向 `<path>.png` 代片）。 */
function buildRound(round: {
  id: string;
  referencePath: string | null;
  candidates: readonly { path: string }[];
}): ViewerRound {
  const toImage = (path: string): ViewerImage => ({
    path,
    displayPath: isProxyFormat(path) ? `${path}.png` : path,
    name: fileName(path),
  });
  return {
    roundId: round.id,
    reference: round.referencePath ? toImage(round.referencePath) : null,
    candidates: round.candidates.map((candidate) => toImage(candidate.path)),
  };
}

function roundPaths(round: ViewerRound): RoundLike {
  return { referencePath: round.reference?.path ?? null, candidates: round.candidates };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 多窗格模式：分屏与多视图。两者都是「一屏并排多张图」，需要逐栏/逐格归一；
 * 其余四个模式共用一块单画布（滑动/叠加/差异/闪烁），归一发生在跑分图叠层上。
 */
function isMultiPaneMode(mode: ViewerMode): boolean {
  return mode === 'split' || mode === 'grid';
}

/**
 * 把查看器挂到舞台容器上。host 由外壳提供并占满可用区域；本函数替换其内容。
 * mount 一次、update 增量：切模式/换图/加删候选都不重建整个舞台。
 */
export function mountViewerStage(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;
  const state: ViewerState = roundScoped<ViewerState>('viewer', roundId, defaultViewerState);
  let mode = normalizeMode(getPref('viewerMode'));
  let round = buildRound({
    id: ctx.round.id,
    referencePath: ctx.round.referencePath,
    candidates: ctx.round.candidates,
  });

  let destroyed = false;
  let rafId = 0;
  let surface: ViewerSurface | null = null;
  let divider: HTMLDivElement | null = null;
  let observeSize: (() => void) | null = null;
  let toolbar: ToolbarHandle | null = null;
  let openMenuHandle: { close: () => void } | null = null;

  const detachers: Array<() => void> = [];
  const timers = new Set<number>();
  let debounceTimer: number | null = null;
  let blinkTimer: number | null = null;
  let longPressTimer = 0;
  let longPressComparing = false;
  let longPressOrigin = { x: 0, y: 0 };
  let dividerDragging = false;
  let focusIndex: number | null = null;
  let pendingRebuild = false;
  let rebuildRetry: number | null = null;
  let structureKey = '';

  // 首帧 fit 保护：布局稳定前测到的窗格尺寸不可信（真窗启动时曾量到整窗宽/高，
  // 导致分屏 7 栏按 78% 裁切、点「适应」才回到 15%）。
  let lastFitPane: Size | null = null;
  let fitProbePane: Size | null = null;
  let fitProbeTries = 0;
  let insanePaneTries = 0;
  // 当前共享视口是按哪张锚图（路径 + 尺寸）适配的。自动模式下锚图换了（原图刚解码完、
  // 候选曾先就绪）要重新适配，否则多窗格会按旧锚图口径解释同一份中心/倍数。
  let fittedAnchorKey = '';

  // 差异图：单条缓存 + 计算中标记（不在绘制里同步做重活）
  let diffCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  let diffComputing = false;
  let diffStatus: 'idle' | 'computing' | 'ready' | 'skip' = 'idle';

  let statusKey = '';

  // 指针当前所在的栏/格：网格模式用它决定「读哪一格的逐格视口」（缩放读数与比例尺）
  let hoverIndex: number | null = null;

  // 本轮判断徽标（画质最好 / 体积最小 / 综合最优），路径 → 徽标。
  // ctx.round 只是挂载快照，指标变化由 update() 用最新一轮重算（见 update 末尾）。
  let chipsByPath: Map<string, HighlightChip[]> = highlightChips(ctx.round.candidates);

  // 舞台容器由外壳提供：补齐「占满 + 可绝对定位」的宿主约束（只在缺类时加，destroy 时还原）
  const hostClassAdded = !host.classList.contains('viewer-host');
  host.classList.add('viewer-host');
  const root = el('div', { class: 'viewer', dataset: { mode } });
  const stage = el('div', { class: 'viewer__stage' });
  // 画布右下的比例尺：把当前缩放换成「屏幕上这一段等于多少原始像素」。
  // 像素级比对时不必心算 43.4% 到底对应多少图片像素；纯信息提示，读屏交给工具栏的缩放档位。
  const scaleTrack = el('span', { class: 'viewer__scale-bar' });
  const scaleText = el('span', { class: 'viewer__scale-text' });
  const scaleBar = el(
    'div',
    { class: 'viewer__scale', attrs: { 'aria-hidden': 'true' } },
    scaleTrack,
    scaleText,
  );
  scaleBar.hidden = true;
  const overlay = el('div', {
    class: 'viewer__overlay',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  stage.append(scaleBar, overlay);

  // ---------- 图片条目 ----------
  let imagesByPath = new Map<string, ViewerImage>();
  const refreshImageMap = (): void => {
    imagesByPath = new Map();
    if (round.reference) imagesByPath.set(round.reference.path, round.reference);
    for (const image of round.candidates) imagesByPath.set(image.path, image);
  };
  refreshImageMap();

  /** 各栏/各格的默认布局（候选顺序的纯投影）。 */
  function paneDefaultsFor(target: ViewerRound): (string | null)[] {
    return defaultLayout(roundPaths(target), paneCount(target.candidates.length));
  }

  function cellDefaultsFor(target: ViewerRound): (string | null)[] {
    const { rows, cols } = gridLayout(target.candidates.length + 1);
    return defaultLayout(roundPaths(target), rows * cols);
  }

  /**
   * 候选增删后对账：默认布局在哪一位换了图，就把那一位的显式选择清掉回默认。
   * 「第 2、3 栏都显示同一张」就是旧显式选择叠在位移后的默认布局上造成的。
   */
  function syncLayoutDefaults(previous: ViewerRound, next: ViewerRound): void {
    const previousPaneDefaults = paneDefaultsFor(previous);
    const previousCellDefaults = cellDefaultsFor(previous);
    const nextPaneDefaults = paneDefaultsFor(next);
    const nextCellDefaults = cellDefaultsFor(next);
    state.panePaths = reconcileExplicitPaths(state.panePaths, previousPaneDefaults, nextPaneDefaults);
    state.cellPaths = reconcileExplicitPaths(state.cellPaths, previousCellDefaults, nextCellDefaults);
    state.paneDefaults = nextPaneDefaults;
    state.cellDefaults = nextCellDefaults;
  }

  // 首次挂载：初始化默认布局；若该轮此前的显式选择是在旧默认布局下做的，先对账
  if (state.paneDefaults.length > 0) {
    state.panePaths = reconcileExplicitPaths(
      state.panePaths,
      state.paneDefaults,
      paneDefaultsFor(round),
    );
  }
  if (state.cellDefaults.length > 0) {
    state.cellPaths = reconcileExplicitPaths(
      state.cellPaths,
      state.cellDefaults,
      cellDefaultsFor(round),
    );
  }
  state.paneDefaults = paneDefaultsFor(round);
  state.cellDefaults = cellDefaultsFor(round);

  const onImageSettled = (): void => schedule();

  const displayPathOf = (path: string): string =>
    imagesByPath.get(path)?.displayPath ?? (isProxyFormat(path) ? `${path}.png` : path);

  const entryFor = (path: string): ImageEntry => loadImage(displayPathOf(path), onImageSettled);

  const referenceEntry = (): ImageEntry | null =>
    round.reference ? entryFor(round.reference.path) : null;

  const candidatePathOf = (): string | null =>
    isSingleSlotMode(mode)
      ? resolveModeCandidatePath(state.candidateChoices, mode, roundPaths(round))
      : null;

  /** 当前模式第 index 个槽位显示的真实路径（单画布模式 index 固定 0）。 */
  const resolveSlot = (index: number): string | null => {
    if (isSingleSlotMode(mode)) return candidatePathOf();
    const paths = mode === 'split' ? state.panePaths : state.cellPaths;
    return resolvePaneImage(paths, index, roundPaths(round));
  };

  const roleOf = (path: string | null): string =>
    path !== null && path === round.reference?.path ? '原图' : '跑分图';

  // ---------- 指针悬停 ----------
  /**
   * 指针当前所在的栏/格：网格的缩放读数与比例尺跟着指针换口径
   * （指针 → 聚焦 → 第一张就绪的格）。这里只维护 hoverIndex，不读取像素。
   */
  function attachHover(canvas: HTMLCanvasElement, index: number): () => void {
    const onMove = (): void => {
      if (hoverIndex === index) return;
      hoverIndex = index;
      syncToolbar();
    };
    const onLeave = (): void => {
      if (hoverIndex !== index) return;
      hoverIndex = null;
      syncToolbar();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }

  // ---------- 绘制调度 ----------
  function schedule(): void {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      draw();
    });
  }

  function scheduleSoon(delay = 120): void {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      schedule();
    }, delay);
  }

  // ---------- 视口 ----------
  /**
   * 第 index 个画布的 CSS 尺寸（取整口径与 prepareCanvas 一致）。
   * fit、网格逐格换算、指针悬停与右键命中都用同一份尺寸，避免同一位置在两处差半像素。
   */
  function paneSizeOf(index: number): Size | null {
    const canvas = surface?.canvases[index];
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 4 || height < 4) return null;
    return { width, height };
  }

  const primaryPaneSize = (): Size | null => paneSizeOf(0);

  /**
   * 共享视口的锚图：原图优先，没有或尚未就绪时取第一张就绪的图。
   * 首帧 fit、网格逐格换算、右键命中都以它为「绝对口径」的参照。
   */
  function anchorEntry(): { path: string; entry: ImageEntry } | null {
    const paths: (string | null)[] = [round.reference?.path ?? null];
    if (isSingleSlotMode(mode)) paths.push(candidatePathOf());
    else {
      const count = surface?.canvases.length ?? 1;
      for (let i = 0; i < count; i++) paths.push(resolveSlot(i));
    }
    for (const path of paths) {
      if (!path) continue;
      const entry = entryFor(path);
      if (entry.status === 'ok' && entry.width > 0) return { path, entry };
    }
    return null;
  }

  function firstReadyEntry(): ImageEntry | null {
    return anchorEntry()?.entry ?? null;
  }

  /** 锚图身份（路径 + 像素尺寸）：尺寸也参与，换图但尺寸相同就不必重新 fit。 */
  function anchorKeyOf(anchor: { path: string; entry: ImageEntry }): string {
    return `${anchor.path}|${anchor.entry.width}x${anchor.entry.height}`;
  }

  /** 锚图尺寸（逐窗换算只需要宽高）；没有就绪图片时 null。 */
  function anchorSize(): Size | null {
    const anchor = anchorEntry();
    return anchor ? { width: anchor.entry.width, height: anchor.entry.height } : null;
  }

  /**
   * 多窗格模式：第 index 栏/格实际使用的视口（共享缩放换算成「相对适应的倍数」，
   * 见 ui/canvas 的 relativeViewport）；单画布模式直接用共享视口。
   * 返回 null 表示这一栏/格还没有可用的图。
   */
  function slotViewport(index: number, shared: ViewportState): ViewportState | null {
    if (!isMultiPaneMode(mode)) return shared;
    const pane = paneSizeOf(index);
    const anchor = anchorSize();
    const path = resolveSlot(index);
    const entry = path ? entryFor(path) : null;
    if (!pane || !anchor || !entry || entry.status !== 'ok') return null;
    if (entry.width <= 0 || entry.height <= 0) return null;
    return relativeViewport(shared, anchor, { width: entry.width, height: entry.height }, pane);
  }

  /**
   * 把某一栏/格的视口写回共享状态（滚轮、拖拽、方向键、缩放档位都经这里）。
   * 单画布模式的视口本来就是共享的，直接赋值；多窗格模式做逆换算，
   * 其它栏/格按同一相对倍数跟随。
   */
  function writeSlotViewport(index: number, cell: ViewportState): void {
    if (!isMultiPaneMode(mode)) {
      state.viewport = cell;
      return;
    }
    const pane = paneSizeOf(index);
    const anchor = anchorSize();
    const path = resolveSlot(index);
    const entry = path ? entryFor(path) : null;
    if (!pane || !anchor || !entry || entry.status !== 'ok') return;
    if (entry.width <= 0 || entry.height <= 0) return;
    state.viewport = absoluteViewportFromRelative(
      cell,
      anchor,
      { width: entry.width, height: entry.height },
      pane,
    );
  }

  /**
   * 窗格尺寸是否已经受舞台约束：刚挂载的那一帧，浏览器可能还没把祖先的网格/弹性
   * 约束算进来，canvas 会量到接近整窗的宽或高。这种值一律不用于 fit。
   */
  function paneSizeSane(pane: Size): boolean {
    return isPaneSizeSane(pane, stage.getBoundingClientRect());
  }

  /**
   * 待适配时用「原图优先、否则第一张候选」按窗格尺寸 fit。
   * 两道保险，任何一道不过就等下一帧：
   * 1) 尺寸必须已被舞台约束（挡住「整窗大小」的过渡值）；
   * 2) 连续两帧量到同一尺寸（挡住布局尚未收敛的首帧）。
   */
  function ensureViewport(): boolean {
    if (state.viewport) {
      // 自动模式下锚图换了（原图刚解码完、候选曾先就绪）要按新锚图重新适配：
      // 否则多窗格会把旧锚图的中心/倍数套到新尺寸上，首屏比例就不对。
      // 手动视图（用户亲手缩放过）保持不动。
      if (!state.viewportTouched) {
        const anchor = anchorEntry();
        const key = anchor ? anchorKeyOf(anchor) : '';
        if (key) {
          // 视口是从上一挂载恢复的：先认下当前锚图，之后这一轮才检测「锚图换了」
          if (!fittedAnchorKey) fittedAnchorKey = key;
          else if (key !== fittedAnchorKey) state.viewport = null;
        }
      }
      if (state.viewport) return true;
    }
    const pane = primaryPaneSize();
    if (!pane) {
      // 窗格还没量出尺寸（隐藏/未布局）：等画布 ResizeObserver 唤醒，不要空转 rAF
      fitProbePane = null;
      fitProbeTries = 0;
      return false;
    }
    if (!paneSizeSane(pane)) {
      // 过渡尺寸（比舞台还大）：最多再追几帧；仍不正常时按当前值兜底，
      // 避免极窄舞台（分屏每栏 240px 比舞台还宽、本来就该横向滚动）一直不显示。
      fitProbePane = null;
      fitProbeTries = 0;
      if (insanePaneTries < 5) {
        insanePaneTries += 1;
        schedule();
        return false;
      }
    }
    insanePaneTries = 0;
    const slotPath = candidatePathOf();
    const preferred = referenceEntry() ?? (slotPath ? entryFor(slotPath) : null);
    const entry = preferred && preferred.status === 'ok' ? preferred : firstReadyEntry();
    if (!entry || entry.status !== 'ok') return false;
    if (!sameBox(fitProbePane, pane)) {
      fitProbePane = pane;
      fitProbeTries += 1;
      // 最多等 3 帧布局收敛；仍不稳定就用当前值兜底，避免永远不显示
      if (fitProbeTries < 3) {
        schedule();
        return false;
      }
    }
    fitProbePane = null;
    fitProbeTries = 0;
    state.viewport = fitViewport({ width: entry.width, height: entry.height }, pane);
    const fitted = anchorEntry();
    fittedAnchorKey = fitted ? anchorKeyOf(fitted) : '';
    lastFitPane = pane;
    return true;
  }

  /** 显式「适应窗口」（0 / 双击 / 适应按钮 / 菜单）：回到自动适配语义。 */
  function resetViewport(): void {
    state.viewport = null;
    state.viewportTouched = false;
    schedule();
  }

  function zoomBy(factor: number): void {
    const shared = state.viewport;
    if (!shared) return;
    if (isMultiPaneMode(mode)) {
      // 多窗格：在当前栏/格的中心缩放这一栏，再按同一相对倍数写回共享状态
      const index = activeSlotIndex();
      const pane = index === null ? null : paneSizeOf(index);
      const cell = index === null ? null : slotViewport(index, shared);
      if (index === null || !pane || !cell) return;
      writeSlotViewport(index, zoomAt(cell, factor, pane.width / 2, pane.height / 2, pane));
    } else {
      const pane = primaryPaneSize();
      if (!pane) return;
      state.viewport = zoomAt(shared, factor, pane.width / 2, pane.height / 2, pane);
    }
    state.viewportTouched = true;
    schedule();
    syncToolbar();
  }

  /**
   * 缩放到指定倍数（菜单档位 / Shift+0）。
   * 多窗格模式落在「当前栏/格」的绝对倍数上，其余窗格按同一相对倍数跟随：各图按自己
   * 的尺寸适配，所以 100% 只对当前窗格精确成立，这是逐窗视口口径的必然结果。
   * 单画布模式仍按原图的共享绝对视口切换（读数与比例尺也以原图为准）。
   */
  function zoomTo(zoom: number): void {
    const shared = state.viewport;
    if (isMultiPaneMode(mode)) {
      if (!shared) return;
      const index = activeSlotIndex();
      const cell = index === null ? null : slotViewport(index, shared);
      if (index === null || !cell) return;
      writeSlotViewport(index, { ...cell, zoom });
      state.viewportTouched = true;
      schedule();
      syncToolbar();
      return;
    }
    const entry = referenceEntry() ?? firstReadyEntry();
    if (!entry || entry.status !== 'ok') return;
    const center = shared
      ? { centerX: shared.centerX, centerY: shared.centerY }
      : { centerX: entry.width / 2, centerY: entry.height / 2 };
    state.viewport = { ...center, zoom };
    state.viewportTouched = true;
    schedule();
    syncToolbar();
  }

  // ---------- 画布区结构 ----------
  function disposeSurface(): void {
    for (const detach of detachers) detach();
    detachers.length = 0;
    surface?.destroy();
    surface = null;
    divider = null;
    // 旧结构的节点整体移除（overlay、比例尺与模式参数组是常驻节点，不参与重建）
    for (const child of [...stage.children]) {
      if (child === overlay || child === scaleBar) continue;
      child.remove();
    }
  }

  function surfaceKind(): 'single' | 'split' | 'grid' {
    return mode === 'split' ? 'split' : mode === 'grid' ? 'grid' : 'single';
  }

  function layoutInfo(): { panes: number; cells: number; rows: number; cols: number } {
    const total = round.candidates.length + 1;
    const { rows, cols } = gridLayout(total);
    return { panes: paneCount(round.candidates.length), cells: rows * cols, rows, cols };
  }

  function buildSurface(): void {
    // 栏数/格数变化会改变窗格尺寸：自动模式对新几何重新 fit
    if (!state.viewportTouched) state.viewport = null;
    lastFitPane = null;
    fitProbePane = null;
    fitProbeTries = 0;
    insanePaneTries = 0;
    disposeSurface();
    const kind = surfaceKind();
    const info = layoutInfo();
    const count = kind === 'split' ? info.panes : kind === 'grid' ? info.cells : 1;
    surface = mountSurface({
      mode: kind,
      count,
      cols: kind === 'grid' ? info.cols : undefined,
      onPick: (index) => openPicker(index),
      onFocus: (index) => setFocus(index),
      onRetry: (_index, path) => {
        invalidateImage(displayPathOf(path));
        schedule();
      },
      onCopy: (_index, path) => {
        copyText(path, () => toast('已复制路径', 'ok'));
      },
    });
    stage.insertBefore(surface.root, overlay);

    surface.canvases.forEach((canvas, index) => {
      detachers.push(
        attachPanZoom(canvas, {
          // 网格模式下把「该格视口」暴露成画布视口：滚轮锚点/拖拽都在本格坐标系里算，
          // 再经 setViewport 逆换算写回共享状态，其它格按同一相对倍数跟随。
          getViewport: () => {
            const shared = state.viewport;
            if (!shared) return null;
            return slotViewport(index, shared);
          },
          setViewport: (vp) => {
            writeSlotViewport(index, vp);
          },
          onChange: () => {
            state.viewportTouched = true;
            schedule();
          },
          onReset: resetViewport,
        }),
      );
      detachers.push(attachCanvasKeys(canvas, index));
      detachers.push(attachHover(canvas, index));
      detachers.push(attachContextMenu(canvas, index));
      // 逐画布监听：栏/格尺寸真正定下来（或窗口/面板变化）时，自动模式重算 fit。
      // 只监听舞台外层曾在真窗里漏掉「外层不变、内部分栏宽度变化」的情况。
      detachers.push(
        watchSize(canvas, (size) => {
          if (destroyed) return;
          const pane = { width: Math.round(size.width), height: Math.round(size.height) };
          if (pane.width < 4 || pane.height < 4) return;
          if (state.viewportTouched || !state.viewport) return;
          if (sameBox(lastFitPane, pane)) return;
          state.viewport = null;
          fitProbePane = null;
          fitProbeTries = 0;
          insanePaneTries = 0;
          schedule();
        }),
      );
    });

    if (kind === 'single') {
      const canvas = surface.canvases[0];
      if (canvas) {
        canvas.setAttribute(
          'aria-label',
          `对比画布：${MODE_META[mode].label}。滚轮缩放，拖拽平移，方向键移动，双击复位`,
        );
        if (mode === 'blink') attachLongPress(canvas);
      }
      if (mode === 'slider') {
        divider = buildDivider();
        stage.insertBefore(divider, overlay);
        applyDivider();
        addTag('原图', 'left');
        addTag('跑分图', 'right');
      }
      if (mode === 'blink') addFaceTag();
    }
    structureKey = structureSignature();
    syncChrome();
    // 不重挂后定时器要自己续：从别的模式切回闪烁且仍在播放时恢复自动交替
    if (mode === 'blink' && state.compare.blinkPlaying) startBlink();
    else stopBlink();
  }

  function structureSignature(): string {
    const info = layoutInfo();
    return `${mode}|${info.panes}|${info.cells}|${info.rows}x${info.cols}`;
  }

  // ---------- 分割线 ----------
  function buildDivider(): HTMLDivElement {
    const node = el('div', {
      class: 'viewer__divider',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': '对比分割线（方向键微调）',
        'aria-valuemin': '2',
        'aria-valuemax': '98',
        tabindex: '0',
      },
    });
    node.append(el('span', { class: 'viewer__divider-handle' }, el('span', { text: '⟷' })));

    const onPointerDown = (event: PointerEvent): void => {
      dividerDragging = true;
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dividerDragging) return;
      const canvas = surface?.canvases[0];
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      state.divider = Math.min(0.98, Math.max(0.02, (event.clientX - rect.left) / rect.width));
      applyDivider();
      schedule();
    };
    const stop = (): void => {
      dividerDragging = false;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.01;
      state.divider = clamp01(state.divider + (event.key === 'ArrowRight' ? step : -step));
      state.divider = Math.min(0.98, Math.max(0.02, state.divider));
      applyDivider();
      schedule();
    };
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    node.addEventListener('keydown', onKeyDown);
    detachers.push(() => {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', stop);
      node.removeEventListener('pointercancel', stop);
      node.removeEventListener('keydown', onKeyDown);
    });
    return node;
  }

  function applyDivider(): void {
    stage.style.setProperty('--divider', String(state.divider));
    divider?.setAttribute('aria-valuenow', String(Math.round(state.divider * 100)));
  }

  function addTag(text: string, side: 'left' | 'right'): void {
    stage.insertBefore(
      el('span', { class: `viewer__tag viewer__tag--${side}`, text }),
      overlay,
    );
  }

  let faceTag: HTMLElement | null = null;
  function addFaceTag(): void {
    faceTag = el('span', { class: 'viewer__tag viewer__tag--left', text: '原图' });
    stage.insertBefore(faceTag, overlay);
  }

  // ---------- 长按看对比图（闪烁模式） ----------
  function attachLongPress(canvas: HTMLCanvasElement): void {
    const cancelTimer = (): void => {
      if (!longPressTimer) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    };
    const release = (): void => {
      cancelTimer();
      if (!longPressComparing) return;
      longPressComparing = false;
      state.compare.blinkShowingRef = true;
      schedule();
    };
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      cancelTimer();
      longPressOrigin = { x: event.clientX, y: event.clientY };
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        longPressComparing = true;
        schedule();
      }, LONG_PRESS_MS);
    };
    const onMove = (event: PointerEvent): void => {
      if (!longPressTimer) return;
      if (Math.hypot(event.clientX - longPressOrigin.x, event.clientY - longPressOrigin.y) > LONG_PRESS_CANCEL_PX) {
        cancelTimer();
      }
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    detachers.push(() => {
      cancelTimer();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
    });
  }

  // ---------- 键盘：画布聚焦时方向键平移 ----------
  function attachCanvasKeys(canvas: HTMLCanvasElement, index: number): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      const step = event.shiftKey ? 80 : 16;
      const delta =
        event.key === 'ArrowLeft'
          ? { x: step, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: -step, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: step }
              : event.key === 'ArrowDown'
                ? { x: 0, y: -step }
                : null;
      if (!delta) return;
      const shared = state.viewport;
      if (!shared) return;
      event.preventDefault();
      if (isMultiPaneMode(mode)) {
        // 多窗格：平移「当前栏/格的视口」再写回共享状态，其它窗格按相对位置跟随
        const cell = slotViewport(index, shared);
        if (!cell) return;
        writeSlotViewport(index, panBy(cell, delta.x, delta.y));
      } else {
        state.viewport = panBy(shared, delta.x, delta.y);
      }
      state.viewportTouched = true;
      schedule();
    };
    canvas.addEventListener('keydown', onKeyDown);
    return () => canvas.removeEventListener('keydown', onKeyDown);
  }

  // ---------- 聚焦栏/格 ----------
  function setFocus(index: number): void {
    if (mode !== 'split' && mode !== 'grid') return;
    if (focusIndex === index) return;
    focusIndex = index;
    surface?.setFocus(index);
    syncChrome();
  }

  // ---------- 选图 ----------
  function openPicker(index: number): void {
    const picker = stage.querySelector<HTMLElement>(`.viewer__pane[data-index="${index}"] .viewer__picker`);
    if (!picker) return;
    const current = resolveSlot(index);
    const reference = round.reference;
    const items = [];
    if (mode === 'grid') {
      items.push({ label: '（空）', checked: current === null, onSelect: () => writeSlot(index, '') });
    }
    if (reference) {
      items.push({
        label: `原图：${truncateFileName(reference.name)}`,
        checked: current === reference.path,
        onSelect: () => writeSlot(index, reference.path),
      });
    }
    for (const candidate of round.candidates) {
      items.push({
        label: truncateFileName(candidate.name),
        checked: current === candidate.path,
        onSelect: () => writeSlot(index, candidate.path),
      });
    }
    openMenuHandle?.close();
    openMenuHandle = openMenu(picker, items, {
      align: 'start',
      label: mode === 'grid' ? `第 ${index + 1} 格选图` : `第 ${index + 1} 栏选图`,
    });
  }

  function writeSlot(index: number, path: string): void {
    const info = layoutInfo();
    const slot =
      mode === 'split' ? { kind: 'pane' as const, index } : { kind: 'cell' as const, index };
    const patch = applyPick(
      {
        candidateChoices: state.candidateChoices,
        panePaths: state.panePaths,
        cellPaths: state.cellPaths,
        paneCount: info.panes,
        cellCount: info.cells,
      },
      slot,
      null,
      path,
    );
    if (patch.panePaths) state.panePaths = patch.panePaths;
    if (patch.cellPaths) state.cellPaths = patch.cellPaths;
    diffStatus = 'idle';
    schedule();
    syncChrome();
  }

  /** 单槽模式换对比图：写该模式的隔离槽（原图始终是基准，不参与选择）。 */
  function pickCandidate(path: string): void {
    if (!isSingleSlotMode(mode)) return;
    const info = layoutInfo();
    const patch = applyPick(
      {
        candidateChoices: state.candidateChoices,
        panePaths: state.panePaths,
        cellPaths: state.cellPaths,
        paneCount: info.panes,
        cellCount: info.cells,
      },
      { kind: 'mode' },
      mode,
      path,
    );
    if (patch.candidateChoices) state.candidateChoices = patch.candidateChoices;
    diffStatus = 'idle';
    schedule();
    syncChrome();
  }

  /** 工具栏上的「对比图」入口：单槽模式靠这个换图（分屏/网格用每栏/每格的下拉）。 */
  function openCandidateMenu(anchor: HTMLElement): void {
    const current = candidatePathOf();
    const items = round.candidates.map((candidate) => ({
      label: truncateFileName(candidate.name),
      checked: current === candidate.path,
      onSelect: () => pickCandidate(candidate.path),
    }));
    if (items.length === 0) return;
    openMenuHandle?.close();
    openMenuHandle = openMenu(anchor, items, { align: 'start', label: '选择对比图' });
  }

  // ---------- 图片右键菜单 ----------
  /** 指针是否落在这张图画出来的范围内（与绘制同一视口口径）。 */
  function pointerOnImage(
    path: string | null,
    pane: Size,
    vp: ViewportState,
    sx: number,
    sy: number,
  ): boolean {
    if (!path) return false;
    const entry = entryFor(path);
    if (entry.status !== 'ok' || entry.width <= 0 || entry.height <= 0) return false;
    const point = screenToImage(vp, pane, sx, sy);
    return point.x >= 0 && point.y >= 0 && point.x < entry.width && point.y < entry.height;
  }

  /**
   * 单画布的右键目标：取指针下「真正在画」的那张图——滑动看分割线两侧、
   * 叠加看顶层跑分图、闪烁看当前面、差异回到原图层；只有一侧命中时就用那一侧。
   * 不这样做会出现「右键原图区域却弹出跑分图菜单」的错位。
   * 返回真实路径（不是 AVIF/JXL 的 .png 代片）。
   */
  function singleContextTarget(
    pane: Size,
    vp: ViewportState,
    sx: number,
    sy: number,
  ): string | null {
    const refPath = round.reference?.path ?? null;
    const candPath = candidatePathOf();
    // 原图用共享绝对视口、跑分图用自己适配后的相对视口：命中测试必须各用各的
    const candVp = candidateViewport(pane);
    const refHit = pointerOnImage(refPath, pane, vp, sx, sy);
    const candHit = candVp ? pointerOnImage(candPath, pane, candVp, sx, sy) : false;
    if (!refHit) return candHit ? candPath : null;
    if (!candHit) return refPath;
    if (mode === 'slider') return sx < state.divider * pane.width ? refPath : candPath;
    if (mode === 'overlay') return candPath;
    if (mode === 'blink') {
      const showRef = longPressComparing ? false : state.compare.blinkShowingRef;
      return showRef ? refPath : candPath;
    }
    // diff：原图是底图，差异图是它的派生覆盖，右键语义仍回到原图层
    return refPath;
  }

  /**
   * 图片右键菜单：只在指针确实落在该格画出来的图片上时弹出（空白边距上右键不弹）。
   * 菜单项与失败提示复用 ui/image-menu（与检视器列表/结果表同一套），按鼠标坐标
   * （openMenu 的 at 选项）弹出；不改视口状态，因此不会打断左键的拖动平移、
   * 双击复位、长按看对比图。
   */
  function attachContextMenu(canvas: HTMLCanvasElement, index: number): () => void {
    const onContextMenu = (event: MouseEvent): void => {
      // 画布上的系统右键菜单没有用处，一律拦下；能否弹菜单看下面是否命中图像
      event.preventDefault();
      const shared = state.viewport;
      const pane = paneSizeOf(index);
      const vp = shared ? slotViewport(index, shared) : null;
      if (!pane || !vp) return;
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      let path: string | null;
      if (isSingleSlotMode(mode)) {
        path = singleContextTarget(pane, vp, sx, sy);
      } else {
        // 分屏/网格：右键针对该栏/该格当前显示的图
        const slotPath = resolveSlot(index);
        path = pointerOnImage(slotPath, pane, vp, sx, sy) ? slotPath : null;
      }
      if (!path) return;
      openMenuHandle?.close();
      openMenuHandle = openImageMenu(canvas, path, {
        at: { x: event.clientX, y: event.clientY },
      });
    };
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => canvas.removeEventListener('contextmenu', onContextMenu);
  }

  // ---------- 模式切换 ----------
  function setMode(next: ViewerMode): void {
    if (destroyed || next === mode) return;
    stopBlink();
    longPressComparing = false;
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = 0;
    if (mode === 'blink') state.compare.blinkShowingRef = true;
    mode = next;
    setPref('viewerMode', next);
    root.dataset.mode = next;
    focusIndex = null;
    hoverIndex = null;
    diffStatus = 'idle';
    faceTag = null;
    // 自动 fit 出来的比例不该带到新窗格（7 栏分屏的 5.69% 挪到滑动会变成一张小图）；
    // 用户手动缩放/拖过的视图仍然跨模式保留。保留时多窗格按「锚图所在栏」的绝对倍数
    // 对齐，其余栏按相对倍数换算（见 ui/canvas 的 relativeViewport），观感连续。
    if (!state.viewportTouched) state.viewport = null;
    toolbar?.setMode(next);
    toolbar?.buildProps(propsOptions());
    buildSurface();
    schedule();
  }

  function propsOptions() {
    return {
      mode,
      compare: state.compare,
      onOpacityInput: (value: number) => {
        state.compare.opacity = value;
        schedule();
        syncToolbar();
      },
      onThresholdInput: (value: number) => {
        state.compare.threshold = Math.round(value);
        diffStatus = 'idle';
        scheduleSoon(120);
      },
      onTogglePlay: () => toggleBlink(),
    };
  }

  // ---------- 闪烁 ----------
  function stopBlink(): void {
    if (blinkTimer === null) return;
    window.clearInterval(blinkTimer);
    blinkTimer = null;
  }

  function startBlink(): void {
    stopBlink();
    blinkTimer = window.setInterval(() => {
      state.compare.blinkShowingRef = !state.compare.blinkShowingRef;
      schedule();
    }, BLINK_INTERVAL_MS);
  }

  function toggleBlink(): void {
    state.compare.blinkPlaying = !state.compare.blinkPlaying;
    if (state.compare.blinkPlaying) {
      startBlink();
    } else {
      stopBlink();
      state.compare.blinkShowingRef = true; // 暂停 = 静止显示原图
    }
    schedule();
    syncToolbar();
  }

  // ---------- 差异图 ----------
  function ensureDiffCanvas(): HTMLCanvasElement | null {
    const reference = round.reference;
    const candidatePath = candidatePathOf();
    if (!reference || !candidatePath) return null;
    const refEntry = entryFor(reference.path);
    const candEntry = entryFor(candidatePath);
    if (refEntry.status !== 'ok' || candEntry.status !== 'ok') return null;
    if (refEntry.width !== candEntry.width || refEntry.height !== candEntry.height) {
      diffStatus = 'skip';
      return null;
    }
    if (diffExceedsLimit(refEntry.width, refEntry.height)) {
      diffStatus = 'skip';
      return null;
    }
    const key = diffCacheKey(reference.path, candidatePath, state.compare.threshold);
    if (diffCache && diffCache.key === key) {
      diffStatus = 'ready';
      return diffCache.canvas;
    }
    if (diffComputing) {
      diffStatus = 'computing';
      return null;
    }
    diffComputing = true;
    diffStatus = 'computing';
    const threshold = state.compare.threshold;
    const refImg = refEntry.img;
    const candImg = candEntry.img;
    if (!refImg || !candImg) {
      diffComputing = false;
      diffStatus = 'idle';
      return null;
    }
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (destroyed) return;
      const canvas = renderDiffCanvas(refImg, candImg, threshold);
      diffComputing = false;
      if (canvas) diffCache = { key, canvas };
      diffStatus = canvas ? 'ready' : 'skip';
      schedule();
    }, 60);
    timers.add(timer);
    return null;
  }

  // ---------- 绘制 ----------
  function draw(): void {
    if (destroyed || !root.isConnected || !surface) return;
    if (pendingRebuild) {
      if (dividerDragging || isPanning()) {
        // 数据变更撞上拖拽：等手松开再换结构（拖拽中的节点不能被整体替换）
        if (rebuildRetry === null) {
          rebuildRetry = window.setTimeout(() => {
            rebuildRetry = null;
            schedule();
          }, 120);
        }
      } else {
        pendingRebuild = false;
        buildSurface();
      }
    }
    if (!ensureViewport()) {
      syncPaneStatuses();
      syncStatus();
      return;
    }
    const vp = state.viewport;
    if (!vp) return;
    if (isSingleSlotMode(mode)) drawSingle(vp);
    else drawMulti(vp);
    syncPaneStatuses();
    syncStatus();
    syncToolbar();
  }

  function isPanning(): boolean {
    return surface?.canvases.some((canvas) => canvas.classList.contains('is-panning')) ?? false;
  }

  /**
   * 单画布模式里跑分图的绘制视口：按它自己的尺寸适配同一块画布，原图仍用共享绝对
   * 视口。两者因此视觉大小一致——否则 500px 宽的跑分图叠在 4000px 原图上只占中间
   * 一小块，滑动/叠加/闪烁都失去可比性。diff 只允许同尺寸，不需要这层换算。
   */
  function candidateViewport(pane: Size): ViewportState | null {
    const shared = state.viewport;
    const anchor = anchorEntry();
    const path = candidatePathOf();
    const entry = path ? entryFor(path) : null;
    if (!shared || !anchor || !entry || entry.status !== 'ok') return null;
    if (entry.width <= 0 || entry.height <= 0) return null;
    return relativeViewport(
      shared,
      { width: anchor.entry.width, height: anchor.entry.height },
      { width: entry.width, height: entry.height },
      pane,
    );
  }

  function drawSingle(vp: ViewportState): void {
    const canvas = surface?.canvases[0];
    if (!canvas) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { ctx, size } = prepared;
    const refEntry = referenceEntry();
    const candPath = candidatePathOf();
    const candEntry = candPath ? entryFor(candPath) : null;
    const refOk = refEntry?.status === 'ok' && refEntry.img !== undefined;
    const candOk = candEntry?.status === 'ok' && candEntry.img !== undefined;
    // 跑分图按自己的尺寸适配同一画布：与原图同屏时视觉大小一致
    const candVp = candidateViewport(size);

    if (mode === 'slider') {
      if (candOk && candVp) {
        drawSource(ctx, size, candEntry!.img!, candEntry!.width, candEntry!.height, candVp);
      }
      if (refOk) {
        if (candOk && candVp) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, state.divider * size.width, size.height);
          ctx.clip();
        }
        drawSource(ctx, size, refEntry!.img!, refEntry!.width, refEntry!.height, vp);
        if (candOk && candVp) ctx.restore();
      }
      return;
    }

    if (mode === 'overlay') {
      if (refOk) drawSource(ctx, size, refEntry!.img!, refEntry!.width, refEntry!.height, vp);
      if (candOk && candVp && state.compare.opacity > 0) {
        ctx.globalAlpha = state.compare.opacity;
        drawSource(ctx, size, candEntry!.img!, candEntry!.width, candEntry!.height, candVp);
        ctx.globalAlpha = 1;
      }
      return;
    }

    if (mode === 'diff') {
      const diffCanvas = ensureDiffCanvas();
      if (refOk) drawSource(ctx, size, refEntry!.img!, refEntry!.width, refEntry!.height, vp);
      if (diffCanvas) {
        drawSource(
          ctx,
          size,
          diffCanvas,
          refEntry?.width ?? diffCanvas.width,
          refEntry?.height ?? diffCanvas.height,
          vp,
        );
      }
      return;
    }

    // blink：长按期间强制显示跑分图；暂停/默认静止显示原图
    const showRef = longPressComparing ? false : state.compare.blinkShowingRef;
    const shownEntry = showRef ? refEntry : candEntry;
    const shownVp = showRef ? vp : candVp;
    if (shownEntry?.status === 'ok' && shownEntry.img && shownVp) {
      drawSource(ctx, size, shownEntry.img, shownEntry.width, shownEntry.height, shownVp);
    }
    if (faceTag) faceTag.textContent = showRef ? '原图' : '跑分图';
  }

  function drawMulti(vp: ViewportState): void {
    const canvases = surface?.canvases ?? [];
    // 分屏与多视图都是多窗格：每栏/格先按自己的图片尺寸适配，共享缩放只作
    // 「相对适应的倍数」（ui/canvas 的 relativeViewport）。这样一排大图里夹一张
    // 500px 宽的跑分图时，它也填满自己那一栏，而不是缩成一小块。
    const anchor = anchorSize();
    for (let index = 0; index < canvases.length; index++) {
      const prepared = prepareCanvas(canvases[index]!);
      if (!prepared) continue;
      const path = resolveSlot(index);
      if (!path) continue;
      const entry = entryFor(path);
      if (entry.status !== 'ok' || !entry.img) continue;
      const cellVp = anchor
        ? relativeViewport(vp, anchor, { width: entry.width, height: entry.height }, prepared.size)
        : vp;
      drawSource(prepared.ctx, prepared.size, entry.img, entry.width, entry.height, cellVp);
    }
  }

  // ---------- 每栏/每格占位状态 ----------
  function paneStatusFor(index: number): PaneStatus {
    if (!surface) return { kind: 'none' };
    if (surfaceKind() === 'single') return { kind: 'none' };
    const path = resolveSlot(index);
    if (!path) return { kind: 'none' };
    const entry = entryFor(path);
    const role = roleOf(path);
    if (entry.status === 'loading') return { kind: 'loading', role };
    if (entry.status === 'error') return { kind: 'error', role, path };
    return { kind: 'none' };
  }

  function syncPaneStatuses(): void {
    if (!surface || surfaceKind() === 'single') return;
    for (let index = 0; index < surface.canvases.length; index++) {
      surface.setStatus(index, paneStatusFor(index));
    }
  }

  // ---------- 整体状态覆盖层 ----------
  function syncStatus(): void {
    if (!surface) return;
    const view = statusView();
    if (view.key === statusKey) return;
    statusKey = view.key;
    overlay.replaceChildren(...view.nodes());
  }

  /** 只算 key（便宜）；nodes 是惰性构造，key 没变时不会建 DOM。 */
  function statusView(): { key: string; nodes: () => HTMLElement[] } {
    const reference = round.reference;
    if (!reference) {
      const chooseReferenceButton = (): HTMLButtonElement =>
        button({
          label: '选择原图',
          icon: 'image',
          variant: 'primary',
          onClick: () => void chooseReference(groupId, roundId),
        });
      // 已有跑分图但没有原图：用一条顶部提示，不挡着已经能看的候选图
      if (round.candidates.length > 0) {
        return {
          key: 'no-reference-with-candidates',
          nodes: () => [
            notice('还没有原图，无法对比', { label: '选择原图', onClick: () => void chooseReference(groupId, roundId) }),
          ],
        };
      }
      return {
        key: 'no-reference',
        nodes: () => [
          emptyState({
            icon: 'image',
            title: '还没有原图',
            hint: '选择一张图片作为对比基准，也可以把图片拖进这个窗口。',
            className: 'viewer__center',
            actions: [chooseReferenceButton()],
          }),
        ],
      };
    }

    // 还没有跑分图：任何模式都给同一条引导（比「正在加载原图」更贴近用户下一步）
    if (round.candidates.length === 0) {
      return { key: 'no-candidates', nodes: () => [addCandidateCta()] };
    }

    // 分屏/网格的加载与失败就地显示在每栏/每格（可单独重试），不再叠一张全局卡片
    if (!isSingleSlotMode(mode)) return { key: 'ok', nodes: () => [] };

    const refEntry = referenceEntry();
    if (!refEntry || refEntry.status === 'loading') {
      return { key: 'reference-loading', nodes: () => [noticeLoading('原图')] };
    }
    if (refEntry.status === 'error') {
      return {
        key: `reference-error|${reference.path}`,
        nodes: () => [errorCard('原图', reference.path)],
      };
    }

    {
      const candPath = candidatePathOf();
      if (!candPath) return { key: 'no-slot', nodes: () => [addCandidateCta()] };
      const candEntry = entryFor(candPath);
      if (candEntry.status === 'loading') {
        return { key: `candidate-loading|${candPath}`, nodes: () => [noticeLoading('跑分图')] };
      }
      if (candEntry.status === 'error') {
        return { key: `candidate-error|${candPath}`, nodes: () => [candidateErrorNotice(candPath)] };
      }
      if (mode === 'diff') {
        if (refEntry.width !== candEntry.width || refEntry.height !== candEntry.height) {
          return {
            key: `diff-size|${candPath}`,
            nodes: () => [
              notice('原图与跑分图尺寸不一致，无法生成差异图', {
                label: '改用叠加对比',
                onClick: () => setMode('overlay'),
              }),
            ],
          };
        }
        if (diffExceedsLimit(refEntry.width, refEntry.height)) {
          return {
            key: 'diff-too-large',
            nodes: () => [notice('图片过大，无法生成差异图（上限 4000 万像素）')],
          };
        }
        if (diffStatus === 'computing') {
          return {
            key: `diff-computing|${candPath}|${state.compare.threshold}`,
            nodes: () => [noticeLoading('差异图')],
          };
        }
      }
    }
    return { key: 'ok', nodes: () => [] };
  }

  function noticeLoading(role: string): HTMLElement {
    return el(
      'div',
      { class: 'viewer__notice' },
      spinner(`正在加载${role}…`),
      el('span', { text: `正在加载${role}…` }),
    );
  }

  function notice(text: string, action?: { label: string; onClick: () => void }): HTMLElement {
    return el(
      'div',
      { class: 'viewer__notice' },
      icon('info', 'icon'),
      el('span', { text }),
      action
        ? button({ label: action.label, size: 'sm', variant: 'quiet', onClick: action.onClick })
        : null,
    );
  }

  function candidateErrorNotice(path: string): HTMLElement {
    return el(
      'div',
      { class: 'viewer__notice viewer__notice--error' },
      icon('alert', 'icon'),
      el('span', { text: isProxyFormat(path) ? '这张 AVIF / JPEG XL 没有代片，无法预览' : `${truncateFileName(fileName(path))} 加载失败` }),
      button({
        label: '重试',
        size: 'sm',
        variant: 'quiet',
        onClick: () => {
          invalidateImage(displayPathOf(path));
          schedule();
        },
      }),
      button({
        label: '复制路径',
        size: 'sm',
        variant: 'quiet',
        onClick: () => copyText(path, () => toast('已复制路径', 'ok')),
      }),
    );
  }

  function errorCard(role: string, path: string): HTMLElement {
    const proxied = isProxyFormat(path);
    return emptyState({
      icon: 'alert',
      title: proxied ? '这个格式在查看器中无法直接显示' : `无法显示${role}`,
      hint: proxied
        ? 'AVIF / JPEG XL 需要由本工具生成 .png 代片后才能预览；跑分与结果表不受影响。人工导入的文件没有代片。'
        : `${truncateFileName(fileName(path))} 可能已被移动、重命名或删除。`,
      className: 'viewer__center',
      actions: [
        button({
          label: '重试',
          icon: 'refresh',
          variant: 'primary',
          onClick: () => {
            invalidateImage(displayPathOf(path));
            schedule();
          },
        }),
        button({
          label: '复制路径',
          icon: 'copy',
          variant: 'secondary',
          onClick: () => copyText(path, () => toast('已复制路径', 'ok')),
        }),
      ],
    });
  }

  function addCandidateCta(): HTMLElement {
    return el(
      'div',
      { class: 'viewer__cta' },
      el('span', { class: 'viewer__cta-text', text: '还没有跑分图，添加后即可开始对比' }),
      button({
        label: '添加跑分图',
        icon: 'plus',
        variant: 'primary',
        size: 'sm',
        onClick: () => void chooseCandidates(groupId, roundId),
      }),
    );
  }

  // ---------- 工具栏 / 选图入口同步 ----------
  function contextText(): string {
    const info = layoutInfo();
    if (mode === 'split') {
      return `分屏：原图 + ${round.candidates.length} 张跑分图（${info.panes} 栏）`;
    }
    if (mode === 'grid') {
      return `${MODE_META[mode].label} ${info.rows} × ${info.cols}（${info.cells} 格）`;
    }
    const path = candidatePathOf();
    const name = path ? truncateFileName(fileName(path)) : '未选择跑分图';
    return `${MODE_META[mode].label}：${name}`;
  }

  /**
   * 多窗格读数/操作用的「当前栏/格」：指针所在 → 聚焦 → 第一张就绪的那一栏。
   * 指针停在空白栏/格上时回落到有图的窗格，避免缩放按钮与读数在一处空位上失效；
   * 多窗格没有单一共享绝对倍数，缩放读数、比例尺、缩放按钮都以这一栏的逐栏视口为准。
   */
  function activeSlotIndex(): number | null {
    if (!isMultiPaneMode(mode) || !surface) return null;
    const count = surface.canvases.length;
    const preferred =
      hoverIndex !== null && hoverIndex < count
        ? hoverIndex
        : focusIndex !== null && focusIndex < count
          ? focusIndex
          : null;
    const candidates: number[] = preferred === null ? [] : [preferred];
    for (let index = 0; index < count; index += 1) {
      if (index !== preferred) candidates.push(index);
    }
    for (const index of candidates) {
      const path = resolveSlot(index);
      if (!path) continue;
      const entry = entryFor(path);
      if (entry.status === 'ok' && entry.width > 0) return index;
    }
    return preferred;
  }

  function activeViewport(): ViewportState | null {
    const shared = state.viewport;
    if (!shared) return null;
    if (!isMultiPaneMode(mode)) return shared;
    const index = activeSlotIndex();
    return index === null ? null : slotViewport(index, shared);
  }

  function syncToolbar(): void {
    if (!toolbar) return;
    // 多窗格读「当前栏/格」的逐栏视口；单画布模式就是共享视口（以原图为准）
    const vp = activeViewport();
    toolbar.setZoomEnabled(vp !== null);
    if (vp) toolbar.setZoom(vp.zoom, isPixelZoom(vp.zoom));
    syncScale(vp);
    // 单槽模式没有每栏/每格的下拉，上下文文字本身就是「换对比图」入口
    toolbar.setContext(
      contextText(),
      isSingleSlotMode(mode) && round.candidates.length > 0,
    );
    toolbar.syncProps(state.compare);
  }

  /**
   * 比例尺：在 1 / 2 / 5 × 10ⁿ 里挑一条显示宽度最接近 72px 的整数像素长度。
   * 这样任意缩放下刻度都是整数像素，不会出现 137 px 这种没法用的读数。
   *
   * 多窗格模式没有统一的绝对倍数：读数取「当前栏/格」的逐栏视口与那张图本身的尺寸
   * （各图尺寸不同，套共享倍率会给出错误数值，所以必须跟着当前栏走）。
   * 单画布模式仍以原图为准（原图用共享绝对视口绘制）。
   */
  function syncScale(vp: ViewportState | null): void {
    let entry: ImageEntry | null = null;
    let path: string | null = null;
    if (isMultiPaneMode(mode)) {
      const index = activeSlotIndex();
      path = index === null ? null : resolveSlot(index);
      entry = path ? entryFor(path) : null;
    } else {
      entry = referenceEntry();
      path = round.reference?.path ?? null;
    }
    if (!vp || !entry || entry.status !== 'ok' || vp.zoom <= 0) {
      scaleBar.hidden = true;
      return;
    }
    const idealPx = 72 / vp.zoom;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(idealPx, 1)));
    let best = magnitude;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const multiplier of [1, 2, 5, 10]) {
      const candidate = multiplier * magnitude;
      const gap = Math.abs(candidate * vp.zoom - 72);
      if (gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
    }
    scaleTrack.style.width = `${Math.round(best * vp.zoom)}px`;
    scaleText.textContent = `${Math.round(best)} px`;
    const label = isMultiPaneMode(mode) && path !== round.reference?.path ? '跑分图' : '原图';
    scaleBar.title = `${label} ${entry.width} × ${entry.height}，当前 ${formatZoomPercent(vp.zoom)}`;
    scaleBar.hidden = false;
  }

  /**
   * 网格每格右上角的判断徽标（画质最好 / 体积最小 / 综合最优）。
   * 分屏与单画布不建徽标宿主，surface 会直接忽略这些调用。
   */
  function syncChips(): void {
    if (!surface || mode !== 'grid') return;
    for (let index = 0; index < surface.canvases.length; index++) {
      const path = resolveSlot(index);
      surface.setChips(index, path ? chipsByPath.get(path) ?? [] : []);
    }
  }

  function syncPickers(): void {
    if (!surface || surfaceKind() === 'single') return;
    const count = surface.canvases.length;
    for (let index = 0; index < count; index++) {
      const path = resolveSlot(index);
      if (!path) {
        surface.setPicker(index, '选择图片', true, `第 ${index + 1} 栏：未选择图片`);
        continue;
      }
      const name = truncateFileName(fileName(path));
      const label = path === round.reference?.path ? `原图：${name}` : name;
      const full = path === round.reference?.path ? `原图 ${path}` : path;
      surface.setPicker(index, label, false, `第 ${index + 1} 栏：${full}`);
    }
    surface.setFocus(focusIndex);
  }

  function syncChrome(): void {
    syncToolbar();
    syncPickers();
    syncChips();
    surface?.setFocus(focusIndex);
  }

  // ---------- 初始装配 ----------
  toolbar = buildToolbar({
    mode,
    onModeChange: setMode,
    onZoomIn: () => zoomBy(steppedZoom(1, 1)),
    onZoomOut: () => zoomBy(steppedZoom(1, -1)),
    onZoomFit: resetViewport,
    onPickCandidate: (anchor) => openCandidateMenu(anchor),
    onZoomMenu: (anchor) => {
      // 多窗格读「当前栏/格」的逐栏视口（与读数、比例尺同一口径）
      const vp = activeViewport();
      // 缩放档位是单选（checked → menuitemradio）；「适应窗口」是动作，不带 checked。
      const items: MenuItem[] = ZOOM_PRESETS.map((preset) => ({
        label: preset === 1 ? '100%（1:1）' : `${Math.round(preset * 100)}%`,
        checked: vp !== null && Math.abs(vp.zoom - preset) < 0.001,
        onSelect: () => zoomTo(preset),
      }));
      items.push(
        { label: '适应窗口', onSelect: () => resetViewport() },
        { label: '1:1', checked: vp !== null && isPixelZoom(vp.zoom), onSelect: () => zoomTo(1) },
      );
      openMenuHandle?.close();
      openMenuHandle = openMenu(anchor, items, { align: 'end', label: '缩放档位' });
    },
  });
  root.append(toolbar.node, stage);
  host.replaceChildren(root);
  toolbar.buildProps(propsOptions());
  toolbar.setMode(mode);
  buildSurface();
  observeSize = watchSize(stage, (size) => {
    if (size.width < 4 || size.height < 4) return;
    // 自动模式跟随容器重新适应；用户手动调过就保留（不打断正在看的局部）
    if (!state.viewportTouched) state.viewport = null;
    schedule();
  });
  if (mode === 'blink' && state.compare.blinkPlaying) startBlink();
  schedule();

  // ---------- 对外句柄 ----------
  const commands: ViewerCommands = {
    setMode,
    toggleBlink,
    zoomIn: () => zoomBy(steppedZoom(1, 1)),
    zoomOut: () => zoomBy(steppedZoom(1, -1)),
    fit: resetViewport,
    oneToOne: () => zoomTo(1),
    isBlinkMode: () => mode === 'blink',
    isMounted: () => !destroyed && root.isConnected,
  };
  activeCommands = commands;

  function adoptRound(next: ViewerRound): void {
    const previousRound = round;
    const previousReference = round.reference?.path ?? null;
    syncLayoutDefaults(previousRound, next);
    round = next;
    refreshImageMap();
    if ((next.reference?.path ?? null) !== previousReference) {
      state.viewport = null;
      state.viewportTouched = false;
      diffCache = null;
      diffStatus = 'idle';
    }
    if (mode === 'slider') applyDivider();
    if (structureSignature() !== structureKey) {
      if (dividerDragging || isPanning()) {
        pendingRebuild = true;
      } else {
        buildSurface();
      }
    } else {
      syncChrome();
    }
    schedule();
  }

  return {
    update: () => {
      if (destroyed) return;
      const workspace = getState().workspace;
      const group = workspace?.groups.find((item) => item.id === groupId);
      const latest = group?.rounds.find((item) => item.id === roundId);
      if (!latest) return;
      // 指标变化（跑分完成/清空/失败）会改变判断徽标：先按最新一轮重算，再走既有
      // update 路径刷新舞台与每格角标（ctx.round 只是挂载时的快照）。
      chipsByPath = highlightChips(latest.candidates);
      adoptRound(
        buildRound({
          id: latest.id,
          referencePath: latest.referencePath,
          candidates: latest.candidates,
        }),
      );
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      stopBlink();
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = 0;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      if (rebuildRetry !== null) window.clearTimeout(rebuildRetry);
      rebuildRetry = null;
      observeSize?.();
      observeSize = null;
      openMenuHandle?.close();
      openMenuHandle = null;
      disposeSurface();
      toolbar?.destroy();
      root.remove();
      if (hostClassAdded) host.classList.remove('viewer-host');
      if (activeCommands === commands) activeCommands = null;
    },
  };
}
