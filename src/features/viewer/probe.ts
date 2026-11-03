// 像素探针：鼠标所指的图片像素坐标，以及原图/跑分图在该点的 RGB 与差值。
//
// 纯逻辑（坐标换算、亮度、差值、文案、缓存键）可单测；
// samplePixel 依赖 canvas 的 getImageData（需要图片以 CORS 方式加载，见 ui/canvas 的 loadImage）。
//
// 只在图片已就绪且指针落在图片范围内时显示；越界/未加载时返回 null（工具栏隐藏读数）。

import { screenToImage, type Size, type ViewportState } from '../../ui/canvas';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ProbeDelta {
  dr: number;
  dg: number;
  db: number;
  /** 亮度差（跑分图 - 原图），保留一位小数。 */
  dl: number;
}

export interface ProbeReading {
  /** 图片像素坐标（整数，原点在左上角）。 */
  x: number;
  y: number;
  ref: Rgb;
  cand: Rgb | null;
  delta: ProbeDelta | null;
}

/** 屏幕坐标（窗格内 CSS 像素）→ 图片整像素坐标；越界/非法视口返回 null。 */
export function pixelAt(
  vp: ViewportState,
  pane: Size,
  screenX: number,
  screenY: number,
  image: Size,
): { x: number; y: number } | null {
  if (vp.zoom <= 0 || image.width <= 0 || image.height <= 0) return null;
  const point = screenToImage(vp, pane, screenX, screenY);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  return { x, y };
}

/**
 * 像素坐标按比例映射到另一张图（逐窗归一后的探针口径）：
 * 两张图尺寸不同时，「同一屏幕位置」在这两张图里对应的是同一相对位置，而不是同一像素
 * 坐标——直接把原坐标拿去另一张图取样会读到完全无关的内容。
 * 尺寸相同直接返回原点（不改变原有 1:1 行为）；结果钳进目标像素范围，供 getImageData 取样。
 */
export function mapPixelPoint(
  point: { x: number; y: number },
  from: Size,
  to: Size,
): { x: number; y: number } {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return point;
  const x = from.width === to.width ? point.x : Math.floor((point.x * to.width) / from.width);
  const y = from.height === to.height ? point.y : Math.floor((point.y * to.height) / from.height);
  return {
    x: Math.min(to.width - 1, Math.max(0, x)),
    y: Math.min(to.height - 1, Math.max(0, y)),
  };
}

/** 相对亮度（与差异图同一口径）。 */
export function luminance(rgb: Rgb): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

/** 跑分图相对原图的差值。 */
export function deltaOf(ref: Rgb, cand: Rgb): ProbeDelta {
  return {
    dr: cand.r - ref.r,
    dg: cand.g - ref.g,
    db: cand.b - ref.b,
    dl: Math.round((luminance(cand) - luminance(ref)) * 10) / 10,
  };
}

/** 带符号整数：+12 / -3 / 0。 */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** 工具栏一行读数（不出现中点分隔符；各段用空白分隔）。 */
export function formatProbe(reading: ProbeReading): string {
  const position = `x ${reading.x}  y ${reading.y}`;
  if (!reading.delta) return position;
  return `${position}  ΔR ${signed(reading.delta.dr)}  ΔG ${signed(reading.delta.dg)}  ΔB ${signed(reading.delta.db)}`;
}

/** 悬浮提示 / 复制内容：坐标 + 两图 RGB + 亮度差。 */
export function formatProbeDetail(reading: ProbeReading): string {
  const lines = [
    `坐标 (${reading.x}, ${reading.y})`,
    `原图 RGB(${reading.ref.r}, ${reading.ref.g}, ${reading.ref.b})`,
  ];
  if (reading.cand) {
    lines.push(`跑分图 RGB(${reading.cand.r}, ${reading.cand.g}, ${reading.cand.b})`);
  }
  if (reading.delta) {
    lines.push(
      `差值 ΔR ${signed(reading.delta.dr)} ΔG ${signed(reading.delta.dg)} ΔB ${signed(reading.delta.db)} ΔL ${reading.delta.dl > 0 ? '+' : ''}${reading.delta.dl}`,
    );
  }
  return lines.join('\n');
}

/** 采样缓存键：同图同像素只读一次（鼠标扫过同一块区域时不重复 getImageData）。 */
export function probeKey(path: string, x: number, y: number): string {
  return `${path}\u0000${x}\u0000${y}`;
}

/** 采样缓存上限：一屏扫过最多几千个点，超了直接清空（比 LRU 更简单，命中率已够）。 */
export const PROBE_CACHE_LIMIT = 2048;

/** 1×1 离屏画布：只用于读单个像素。 */
let scratch: HTMLCanvasElement | null = null;
const sampleCache = new Map<string, Rgb | null>();

/** 读取图片某个像素的 RGB；图片未就绪、越界或画布不可用时返回 null。 */
export function samplePixel(img: HTMLImageElement, x: number, y: number): Rgb | null {
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = 1;
    scratch.height = 1;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
  } catch {
    // 画布被跨源图片污染（asset 协议未回 CORS 头）时读像素会抛 SecurityError：
    // 探针只是辅助信息，失败就不显示，不能打断指针交互。
    return null;
  }
}

/** 带缓存的采样（缓存按「展示路径 + 像素」去重）。 */
export function samplePixelCached(displayPath: string, img: HTMLImageElement, x: number, y: number): Rgb | null {
  const key = probeKey(displayPath, x, y);
  if (sampleCache.has(key)) return sampleCache.get(key) ?? null;
  const value = samplePixel(img, x, y);
  if (sampleCache.size >= PROBE_CACHE_LIMIT) sampleCache.clear();
  sampleCache.set(key, value);
  return value;
}

/** 清空采样缓存（换原图/切轮时无需，但测试与「重试」后可调用）。 */
export function clearProbeCache(): void {
  sampleCache.clear();
}
