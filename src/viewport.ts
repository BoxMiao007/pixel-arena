// 对比查看器的统一「视口状态」：一份状态（视野中心 + 缩放）描述"看图片的哪个部位"。
// 左右分屏、滑动对比以及后续的多视图/叠加/视频逐帧都共享同一份状态在各自窗格里渲染，
// 从而天然获得同步缩放平移；状态用图片坐标（而非屏幕坐标）描述，窗格尺寸只作为换算参数，
// 因此 N 个尺寸不同的窗格都能用同一份状态（T08 多视图的底座）。
//
// 本模块是纯几何逻辑，不依赖 DOM，由 src/viewport.test.ts 守护。

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

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 适配窗格：整图完整居中显示（小图放大、大图缩小） */
export function fitViewport(image: Size, pane: Size): ViewportState {
  if (image.width <= 0 || image.height <= 0 || pane.width <= 0 || pane.height <= 0) {
    return { centerX: 0, centerY: 0, zoom: 1 };
  }
  const zoom = Math.min(pane.width / image.width, pane.height / image.height);
  return { centerX: image.width / 2, centerY: image.height / 2, zoom: clampZoom(zoom) };
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
 * 即"光标指哪放大哪"。
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
 */
export function visibleRegion(
  vp: ViewportState,
  pane: Size,
  image: Size,
): { src: Rect; dst: Rect } | null {
  const originX = pane.width / 2 - vp.centerX * vp.zoom;
  const originY = pane.height / 2 - vp.centerY * vp.zoom;
  const dstX = Math.max(0, originX);
  const dstY = Math.max(0, originY);
  const dstRight = Math.min(pane.width, originX + image.width * vp.zoom);
  const dstBottom = Math.min(pane.height, originY + image.height * vp.zoom);
  if (dstRight <= dstX || dstBottom <= dstY) return null;
  return {
    src: {
      x: (dstX - originX) / vp.zoom,
      y: (dstY - originY) / vp.zoom,
      width: (dstRight - dstX) / vp.zoom,
      height: (dstBottom - dstY) / vp.zoom,
    },
    dst: { x: dstX, y: dstY, width: dstRight - dstX, height: dstBottom - dstY },
  };
}
