// 多视图的逐格视口换算（纯函数，无 DOM）。
//
// 问题：六个模式共用一份「共享视口」，它按锚图（原图，没有时第一张候选）适配
// 第一个画布算出了**绝对**倍数。网格若把这个倍数直接套到每一格，分辨率小的跑分图
// （例如 500px 宽的缩略产物）只会占格子的一角，同一屏里各格图像差好几倍。
//
// 口径：网格每格先按自己的图片尺寸适配该格，共享缩放退化为「相对适应的倍数」——
// 相对 1 = 该格正好填满。中心坐标同样按图片内的相对位置映射，所以默认居中时
// 每格都精确居中；滚轮放大时各格按同一比例放大，视觉上尺寸始终一致。
//
// 换算（anchor = 锚图，image = 该格图，pane = 该格画布）：
//   anchorFit  = fit(anchor, pane)
//   cell.zoom  = fit(image, pane) × shared.zoom / anchorFit
//   cell.centerX = shared.centerX / anchor.width × image.width（Y 同理）
// 反向（滚轮/拖拽/键盘把逐格视口写回共享状态）就是上面两式的逆运算。
//
// 网格各格由布局保证同尺寸，因此「该格 pane」与「首个画布 pane」算出的 anchorFit
// 相同；万一尺寸不同，以该格自身画布换算（自洽优先，避免同一个位置在两格读出不同比例）。
//
// 边界：倍数仍受画布上下限（MIN_ZOOM / MAX_ZOOM）钳制。极小图或极大图顶到上下限时，
// 相对尺寸不再严格相等——这与 fitViewport 的口径一致，不能为了「看起来一样大」越过
// 缩放上限（那会让像素级查看失去意义）。
//
// 由 grid-view.test.ts 用独立演算的字面量守护。

import { clampZoom, fitViewport, type Size, type ViewportState } from '../../ui/canvas';

function usable(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

/** 适配倍数与 fitViewport 同一口径（含上下限钳制），保证默认状态相对值精确等于 1。 */
function fitZoom(image: Size, pane: Size): number {
  return fitViewport(image, pane).zoom;
}

/**
 * 共享视口（锚图绝对口径）→ 该格视口。
 * 尺寸不可用时原样返回共享视口：宁可暂时与其它格不同，也不产生 NaN 坐标；
 * 调用方（stage）在图片未就绪时会先跳过绘制。
 */
export function cellViewport(
  shared: ViewportState,
  anchor: Size,
  image: Size,
  pane: Size,
): ViewportState {
  if (!usable(anchor) || !usable(image) || !usable(pane) || shared.zoom <= 0) {
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
 * 该格视口 → 共享视口（cellViewport 的逆运算）。
 * 交互（滚轮锚点、拖拽、方向键）都先在本格坐标系里算，再经这里写回共享状态，
 * 其它格因此按同一相对倍数跟随。
 */
export function sharedViewportFromCell(
  cell: ViewportState,
  anchor: Size,
  image: Size,
  pane: Size,
): ViewportState {
  if (!usable(anchor) || !usable(image) || !usable(pane) || cell.zoom <= 0) {
    return { ...cell };
  }
  const anchorFit = fitZoom(anchor, pane);
  const imageFit = fitZoom(image, pane);
  return {
    centerX: (cell.centerX / image.width) * anchor.width,
    centerY: (cell.centerY / image.height) * anchor.height,
    zoom: clampZoom((cell.zoom / imageFit) * anchorFit),
  };
}
