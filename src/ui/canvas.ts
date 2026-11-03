// 共享画布层：<img> 解码缓存、DPR 画布准备、可见区绘制、视口几何、指针交互。
//
// 只放「与业务无关」的东西：图片对比查看器与视频逐帧对比都从这里取，不互相 import。
// 视口几何是纯函数（图片坐标系 + 窗格尺寸只作换算参数），由
// src/features/viewer/viewport.test.ts 守护；解码与画布部分依赖 DOM，不做单测。
//
// 约定：
// - 调用方负责业务语义（画什么、什么时候 fit），本模块只做换算与像素操作；
// - 画布背景交给 CSS（容器底色/棋盘格），canvas 只 clearRect，不用 JS 读颜色，
//   避免每帧 getComputedStyle（旧实现每格每帧一次，是大图卡顿的隐性来源）。

import { convertFileSrc } from '@tauri-apps/api/core';

// ---------- 视口几何（纯函数） ----------

export interface ViewportState {
  /** 视野中心在图片坐标系里的位置（图片像素） */
  centerX: number;
  centerY: number;
  /** 缩放倍数：屏幕像素 / 图片像素（2 表示图片上 1 像素占屏幕 2 像素） */
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 像素级查看的缩放上限（64 倍已足够分辨单像素）；下限允许缩得很小以总览超大图 */
export const MAX_ZOOM = 64;
export const MIN_ZOOM = 0.01;

/** 100% 附近用 epsilon 判等：滚轮连乘会让 zoom 变成 1.0000000001，严格比较会误关最近邻。 */
export const ZOOM_EPSILON = 1e-6;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 是否已到「1 图片像素 = 1 屏幕像素」或更高（此时关闭平滑，按最近邻显示）。 */
export function isPixelZoom(zoom: number): boolean {
  return zoom >= 1 - ZOOM_EPSILON;
}

/** 适配窗格：整图完整居中显示（小图放大、大图缩小） */
export function fitViewport(image: Size, pane: Size): ViewportState {
  if (image.width <= 0 || image.height <= 0 || pane.width <= 0 || pane.height <= 0) {
    return { centerX: 0, centerY: 0, zoom: 1 };
  }
  const zoom = Math.min(pane.width / image.width, pane.height / image.height);
  return { centerX: image.width / 2, centerY: image.height / 2, zoom: clampZoom(zoom) };
}

// ---------- 相对视口（多窗格逐窗归一：图片查看器与视频逐帧对比共用） ----------
//
// 多窗格并排时只存一份「共享视口」：中心按锚图（原图，没有时第一张候选）的图片像素、
// 倍数按锚图在首个窗格里的绝对倍数记录。若把这份绝对倍数直接套给每个窗格，分辨率小的
// 跑分图（例如 500px 宽的缩略产物）只会占窗格一角，同屏里各图差好几倍。
//
// 口径：先按每张图自己的尺寸适配所在窗格，共享缩放退化为「相对适应的倍数」——
// 相对 1 = 这张图正好填满窗格。中心按图片内的相对位置映射，所以默认居中时每张图都
// 精确居中；滚轮放大时各窗格按同一比例放大，视觉尺寸始终一致。
//
// 换算（anchor = 锚图，image = 该窗格图，pane = 该窗格画布）：
//   anchorFit     = fit(anchor, pane)
//   relative.zoom = fit(image, pane) × shared.zoom / anchorFit
//   relative.centerX = shared.centerX / anchor.width × image.width（Y 同理）
// 反向（滚轮/拖拽/键盘把某窗格视口写回共享状态）就是上面两式的逆运算。
//
// 各窗格同尺寸时 anchorFit 相同；万一尺寸不同（网格行高不同、分屏最后一栏被滚动裁切），
// 以该窗格自身画布换算（自洽优先，避免同一位置在两个窗格读出不同比例）。
//
// 边界：倍数仍受 MIN_ZOOM / MAX_ZOOM 钳制。极小图或极大图顶到上下限时相对尺寸不再严格
// 相等——这与 fitViewport 同一口径，不能为了「看起来一样大」越过缩放上限（否则像素级
// 查看失去意义）。
// 由 src/features/viewer/viewport.test.ts 用独立演算的字面量守护。

function usableSize(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/** 适配倍数与 fitViewport 同一口径（含上下限钳制），保证默认状态相对值精确等于 1。 */
function fitZoom(image: Size, pane: Size): number {
  return fitViewport(image, pane).zoom;
}

/**
 * 共享视口（锚图绝对口径）→ 某张图在某个窗格里的视口。
 * 尺寸不可用时原样返回共享视口：宁可暂时与其它窗格不同，也不产生 NaN 坐标；
 * 调用方（舞台）在资源未就绪时会先跳过绘制。
 */
export function relativeViewport(
  shared: ViewportState,
  anchor: Size,
  image: Size,
  pane: Size,
): ViewportState {
  if (!usableSize(anchor) || !usableSize(image) || !usableSize(pane) || shared.zoom <= 0) {
    return { ...shared };
  }
  const anchorFit = fitZoom(anchor, pane);
  const imageFit = fitZoom(image, pane);
  return {
    centerX: (shared.centerX / anchor.width) * image.width,
    centerY: (shared.centerY / anchor.height) * image.height,
    zoom: clampZoom(imageFit * (shared.zoom / anchorFit)),
  };
}

/**
 * relativeViewport 的逆运算：把某张图的视口写回共享的绝对口径。
 * 交互（滚轮锚点、拖拽、方向键）先在该窗格坐标系里算，再经这里写回共享状态，
 * 其它窗格因此按同一相对倍数跟随。
 */
export function absoluteViewportFromRelative(
  relative: ViewportState,
  anchor: Size,
  image: Size,
  pane: Size,
): ViewportState {
  if (!usableSize(anchor) || !usableSize(image) || !usableSize(pane) || relative.zoom <= 0) {
    return { ...relative };
  }
  const anchorFit = fitZoom(anchor, pane);
  const imageFit = fitZoom(image, pane);
  return {
    centerX: (relative.centerX / image.width) * anchor.width,
    centerY: (relative.centerY / image.height) * anchor.height,
    zoom: clampZoom((relative.zoom / imageFit) * anchorFit),
  };
}

/** 图片坐标 → 屏幕坐标（窗格内的 CSS 像素） */
export function imageToScreen(
  vp: ViewportState,
  pane: Size,
  ix: number,
  iy: number,
): { x: number; y: number } {
  return {
    x: pane.width / 2 + (ix - vp.centerX) * vp.zoom,
    y: pane.height / 2 + (iy - vp.centerY) * vp.zoom,
  };
}

/** 屏幕坐标 → 图片坐标（imageToScreen 的逆变换） */
export function screenToImage(
  vp: ViewportState,
  pane: Size,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: vp.centerX + (sx - pane.width / 2) / vp.zoom,
    y: vp.centerY + (sy - pane.height / 2) / vp.zoom,
  };
}

/**
 * 以屏幕点 (sx, sy) 为锚缩放 factor 倍：锚点下的图片内容缩放前后保持在同一屏幕位置，
 * 即「光标指哪放大哪」。
 */
export function zoomAt(
  vp: ViewportState,
  factor: number,
  sx: number,
  sy: number,
  pane: Size,
): ViewportState {
  const zoom = clampZoom(vp.zoom * factor);
  return {
    zoom,
    centerX: vp.centerX + (sx - pane.width / 2) * (1 / vp.zoom - 1 / zoom),
    centerY: vp.centerY + (sy - pane.height / 2) * (1 / vp.zoom - 1 / zoom),
  };
}

/** 直接改缩放（菜单档位/键盘）：中心不动，只换倍数。 */
export function withZoom(vp: ViewportState, zoom: number): ViewportState {
  return { ...vp, zoom: clampZoom(zoom) };
}

/** 在屏幕上把画面拖动 (dx, dy) 像素：内容跟着手走（往右拖，图往右移） */
export function panBy(vp: ViewportState, dx: number, dy: number): ViewportState {
  return {
    ...vp,
    centerX: vp.centerX - dx / vp.zoom,
    centerY: vp.centerY - dy / vp.zoom,
  };
}

/**
 * 当前视口下图片的可见部分，拆成 drawImage 需要的源区域（图片内）与目标区域（屏幕上）。
 * 只画可见部分：大图高倍缩放时避免让浏览器缩放整张图，保证拖拽流畅。
 * 视口完全移出图片时返回 null（无需绘制）。
 *
 * 源区域向外取整到整像素：不同尺寸/DPR 的窗格并排时，浮点源矩形会让相邻格子出现
 * 半像素错位（边缘看起来「一像素差」），取整后各窗格采到同一批像素。
 */
export function visibleRegion(
  vp: ViewportState,
  pane: Size,
  image: Size,
): { src: Rect; dst: Rect } | null {
  const originX = pane.width / 2 - vp.centerX * vp.zoom;
  const originY = pane.height / 2 - vp.centerY * vp.zoom;
  const visibleLeft = Math.max(0, originX);
  const visibleTop = Math.max(0, originY);
  const visibleRight = Math.min(pane.width, originX + image.width * vp.zoom);
  const visibleBottom = Math.min(pane.height, originY + image.height * vp.zoom);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;
  // 源矩形向外取整到整像素；目标矩形按同一变换反算（不是直接用可见区），
  // 这样「取整」只改变采样范围，不改变图像在屏幕上的位置。
  const srcX = Math.max(0, Math.floor((visibleLeft - originX) / vp.zoom));
  const srcY = Math.max(0, Math.floor((visibleTop - originY) / vp.zoom));
  const srcRight = Math.min(image.width, Math.ceil((visibleRight - originX) / vp.zoom));
  const srcBottom = Math.min(image.height, Math.ceil((visibleBottom - originY) / vp.zoom));
  const src = {
    x: srcX,
    y: srcY,
    width: Math.max(1, srcRight - srcX),
    height: Math.max(1, srcBottom - srcY),
  };
  return {
    src,
    dst: {
      x: originX + src.x * vp.zoom,
      y: originY + src.y * vp.zoom,
      width: src.width * vp.zoom,
      height: src.height * vp.zoom,
    },
  };
}

// ---------- 图片解码缓存（会话级） ----------

export interface ImageEntry {
  status: 'loading' | 'ok' | 'error';
  img?: HTMLImageElement;
  /** 图片原始像素尺寸；loading/error 时为 0。 */
  width: number;
  height: number;
}

/** 缓存上限：一张 4000×3000 的解码位图约 48MB，48 张已远超常规一轮评测的观测量。 */
const MAX_CACHED_IMAGES = 48;

interface CachedImage extends ImageEntry {
  listeners: Set<() => void>;
}

const imageCache = new Map<string, CachedImage>();

/** 图片 URL：asset protocol，交给 WebView 原生解码，不经 IPC 传像素。
 *  必须在调用时（而非模块顶层）取，浏览器/单测环境没有 __TAURI_INTERNALS__。 */
export function imageUrl(path: string): string {
  return convertFileSrc(path);
}

/** 淘汰最旧的已结算条目（连点几十张图时避免无限占内存；加载中的不淘汰）。 */
function evictIfNeeded(): void {
  if (imageCache.size <= MAX_CACHED_IMAGES) return;
  for (const [path, entry] of imageCache) {
    if (imageCache.size <= MAX_CACHED_IMAGES) return;
    if (entry.status === 'loading') continue;
    imageCache.delete(path);
  }
}

/**
 * 确保图片开始加载：已加载的直接返回，加载中的登记回调。
 * onSettle 在加载完成/失败时执行一次（缓存命中不触发，调用方立即读 status 即可）。
 */
export function loadImage(path: string, onSettle: () => void): ImageEntry {
  let entry = imageCache.get(path);
  if (!entry) {
    const created: CachedImage = { status: 'loading', width: 0, height: 0, listeners: new Set() };
    imageCache.set(path, created);
    evictIfNeeded();
    const img = new Image();
    // 差异图要把像素读进 canvas（getImageData）：不声明 crossOrigin 时画布会被
    // asset protocol 的跨源图片污染并抛 SecurityError。只 drawImage 的模式不受影响，
    // 但必须统一声明，避免同一缓存条目在两处行为不一致。
    img.crossOrigin = 'anonymous';
    const settle = (ok: boolean): void => {
      const current = imageCache.get(path);
      if (!current) return;
      current.status = ok ? 'ok' : 'error';
      if (ok) {
        current.img = img;
        current.width = img.naturalWidth;
        current.height = img.naturalHeight;
      }
      const listeners = [...current.listeners];
      current.listeners.clear();
      for (const listener of listeners) listener();
    };
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = imageUrl(path);
    entry = created;
  }
  if (entry.status === 'loading') entry.listeners.add(onSettle);
  return entry;
}

/** 清掉某张图的缓存（加载失败后的「重试」入口）：下次 loadImage 会重新解码。 */
export function invalidateImage(path: string): void {
  imageCache.delete(path);
}

/** 仅供测试/诊断：当前缓存的路径数。 */
export function imageCacheSize(): number {
  return imageCache.size;
}

// ---------- 画布准备与绘制 ----------

export interface PreparedCanvas {
  ctx: CanvasRenderingContext2D;
  /** CSS 像素尺寸（绘图坐标系已按 DPR 缩放） */
  size: Size;
  /** 设备像素比（写入 canvas.width/height 时用） */
  dpr: number;
}

/**
 * 把画布背板调到窗格实际尺寸 × 设备像素比，返回 CSS 尺寸的绘图上下文。
 * 尺寸小于 2px（隐藏/折叠/尚未布局）时返回 null：调用方必须跳过这一帧，
 * 否则会按 1×1 窗格 fit 出一个错误视口并写进状态。
 */
export function prepareCanvas(canvas: HTMLCanvasElement): PreparedCanvas | null {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 2 || height < 2) return null;
  const dpr = window.devicePixelRatio || 1;
  const bufferWidth = Math.round(width * dpr);
  const bufferHeight = Math.round(height * dpr);
  if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
    canvas.width = bufferWidth;
    canvas.height = bufferHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, size: { width, height }, dpr };
}

/** 按视口把一张可绘制源画进画布：只画可见部分，≥100% 关闭平滑（最近邻）。 */
export function drawSource(
  ctx: CanvasRenderingContext2D,
  size: Size,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  vp: ViewportState,
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const region = visibleRegion(vp, size, { width: sourceWidth, height: sourceHeight });
  if (!region) return;
  const pixel = isPixelZoom(vp.zoom);
  ctx.imageSmoothingEnabled = !pixel;
  if (!pixel) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    source,
    region.src.x, region.src.y, region.src.width, region.src.height,
    region.dst.x, region.dst.y, region.dst.width, region.dst.height,
  );
}

// ---------- 尺寸监听 ----------

/**
 * 监听元素尺寸变化（窗口拉伸、面板折叠、结果坞拖动）。
 * 隐藏/折叠时也会回调（尺寸 0），由调用方决定是否跳过——而不是在这里静默丢事件，
 * 否则「从隐藏变可见」的第一次布局可能没有回调。
 */
export function watchSize(element: Element, onChange: (size: Size) => void): () => void {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const box = entry.contentRect;
    onChange({ width: box.width, height: box.height });
  });
  observer.observe(element);
  return () => observer.disconnect();
}

// ---------- 指针交互：滚轮锚点缩放 + 拖拽平移 + 双击复位 ----------

export interface PanZoomOptions {
  getViewport: () => ViewportState | null;
  setViewport: (vp: ViewportState) => void;
  /** 视口变化后调用（一般就是 scheduleDraw）。 */
  onChange: () => void;
  /** 双击：复位到适应（由调用方实现，通常 setViewport(null) 后重绘）。 */
  onReset: () => void;
  /** 滚轮缩放灵敏度（默认与旧实现一致：1.0015^-deltaY）。 */
  wheelFactor?: (deltaY: number) => number;
}

/**
 * 给画布接上滚轮缩放（光标锚点）、左键拖拽平移、双击复位。
 * 返回 detach：destroy 时必须调用，否则移除的 DOM 仍被监听闭包引用。
 */
export function attachPanZoom(canvas: HTMLCanvasElement, options: PanZoomOptions): () => void {
  const factorFor = options.wheelFactor ?? ((deltaY: number) => Math.pow(1.0015, -deltaY));

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const vp = options.getViewport();
    if (!vp) return;
    const rect = canvas.getBoundingClientRect();
    options.setViewport(
      zoomAt(
        vp,
        factorFor(event.deltaY),
        event.clientX - rect.left,
        event.clientY - rect.top,
        { width: rect.width, height: rect.height },
      ),
    );
    options.onChange();
  };

  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let activePointer = -1;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    panning = true;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-panning');
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!panning || event.pointerId !== activePointer) return;
    const vp = options.getViewport();
    if (vp) {
      options.setViewport(panBy(vp, event.clientX - lastX, event.clientY - lastY));
      options.onChange();
    }
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const stopPan = (event: PointerEvent): void => {
    if (!panning || (event.pointerId !== undefined && event.pointerId !== activePointer)) return;
    panning = false;
    activePointer = -1;
    canvas.classList.remove('is-panning');
  };
  const onDoubleClick = (): void => options.onReset();

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', stopPan);
  canvas.addEventListener('pointercancel', stopPan);
  canvas.addEventListener('dblclick', onDoubleClick);

  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', stopPan);
    canvas.removeEventListener('pointercancel', stopPan);
    canvas.removeEventListener('dblclick', onDoubleClick);
  };
}
