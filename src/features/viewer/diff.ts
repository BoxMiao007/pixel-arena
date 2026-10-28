// 差异图：逐像素亮度差热图 + 整图渲染 + 单条缓存键。
//
// computeDiffData / diffCacheKey / diffExceedsLimit 是纯逻辑（无 DOM），
// 由 src/features/viewer/diff.test.ts 守护；renderDiffCanvas 依赖 canvas，不做单测。
//
// 性能口径：整图一次算好并缓存一张画布，之后缩放平移走普通 drawImage；
// 只保留最近一条（同两张图同阈值只算一次，换图/换阈值自动重算）。

/** 与 ImageData 结构兼容的最小像素缓冲（测试环境无 DOM 也能构造）。 */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 差异图单张画布的像素上限：再大就只提示，不冻结界面（4000×3000 已是 1200 万）。 */
export const MAX_DIFF_PIXELS = 40_000_000;

/** 两颗图是否超过差异图计算上限（超过时查看器给提示而不是长时间卡住）。 */
export function diffExceedsLimit(width: number, height: number): boolean {
  return width * height > MAX_DIFF_PIXELS;
}

/**
 * 逐像素计算差异热图（要求 ref 与 cand 同尺寸，调用方保证）：
 * - 亮度 L = 0.299R + 0.587G + 0.114B，亮度差 diff = |L_ref - L_cand|（0~255）；
 * - diff ≤ 阈值：输出原图亮度 25% 的灰阶底——保留轮廓上下文又不抢眼；
 * - diff > 阈值：热区着色，超出程度从黄 (255,230,0) 渐变到纯红 (255,0,0)，
 *   越接近阈值越偏黄（刚过线）、差得越多越红。
 * 返回长度 = 像素数 ×4 的 RGBA 数组（alpha 恒 255）。
 */
export function computeDiffData(
  ref: PixelBuffer,
  cand: PixelBuffer,
  threshold: number,
): Uint8ClampedArray {
  const n = ref.width * ref.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lr = 0.299 * ref.data[o]! + 0.587 * ref.data[o + 1]! + 0.114 * ref.data[o + 2]!;
    const lc = 0.299 * cand.data[o]! + 0.587 * cand.data[o + 1]! + 0.114 * cand.data[o + 2]!;
    const diff = Math.abs(lr - lc);
    if (diff <= threshold) {
      const g = Math.round(lr * 0.25);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    } else {
      // 阈值 255 时 (255-threshold)=0 会除零：clamp 下限 1 保证有定义。
      const p = (diff - threshold) / Math.max(1, 255 - threshold);
      out[o] = 255;
      out[o + 1] = Math.round(230 * (1 - p));
      out[o + 2] = 0;
    }
    out[o + 3] = 255;
  }
  return out;
}

/** 差异图缓存键：同两张图（真实路径）同阈值只算一次；null 与空串是不同状态。 */
export function diffCacheKey(refPath: string | null, candPath: string | null, threshold: number): string {
  return JSON.stringify([refPath, candPath, threshold]);
}

/**
 * 把两张等尺寸的图生成一张差异画布（原图分辨率）。
 * 生成一次后整张缓存，缩放平移走普通 drawImage 路径，交互不重算像素。
 */
export function renderDiffCanvas(
  ref: HTMLImageElement,
  cand: HTMLImageElement,
  threshold: number,
): HTMLCanvasElement | null {
  const width = ref.naturalWidth;
  const height = ref.naturalHeight;
  if (width === 0 || height === 0) return null;
  if (diffExceedsLimit(width, height)) return null;
  const grab = (img: HTMLImageElement): ImageData | null => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(img, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    } catch {
      // 跨源图片污染画布（asset 协议未回 CORS 头）时读像素会抛 SecurityError：
      // 返回 null 让调用方走「不显示差异图」的降级，不要打断绘制循环。
      return null;
    }
  };
  const refData = grab(ref);
  const candData = grab(cand);
  if (!refData || !candData) return null;
  const data = computeDiffData(refData, candData, threshold);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const out = ctx.createImageData(width, height);
  out.data.set(data);
  ctx.putImageData(out, 0, 0);
  return canvas;
}
