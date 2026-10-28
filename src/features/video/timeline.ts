// 逐帧对比的时间与帧换算（纯函数，无 DOM）。
//
// 口径（决策 0011 / 规格 §1.8）：
// - 时间轴总长取所有显示中视频时长的最小值（未就绪的 0 忽略）；
// - 帧序号 = floor(t * fps + 1e-6)，用浮点容差避免 0.4999999 归错帧；
// - ±1 帧：从当前帧序号跳到相邻帧边界；-1 帧在「帧中」时先落回本帧开头；
// - 帧率为 0/NaN/未知时不做换算，调用方据此禁用步进。
//
// 从旧 src/video-compare.ts 复制并扩展（旧文件原样保留，见规格 §8）。

/** 时间钳制到 [0, duration]；时长未知（0）或非法时间归 0。 */
export function clampTime(t: number, duration: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(0, t), Math.max(0, duration));
}

/** 时间点所在帧序号 = floor(t*fps)；加浮点容差避免 0.4999999 归错帧。 */
export function frameIndexAt(t: number, fps: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.floor(Math.max(0, t) * fps + 1e-6);
}

/** +1 帧后的时间点：从当前帧序号跳到下一帧边界，钳制在时长内。 */
export function nextFrameTime(t: number, fps: number, duration: number): number {
  if (!usableFps(fps)) return clampTime(t, duration);
  return clampTime((frameIndexAt(t, fps) + 1) / fps, duration);
}

/** -1 帧后的时间点：恰在帧界时退到上一帧，帧中落回本帧开头，钳制在 [0, duration]。 */
export function prevFrameTime(t: number, fps: number, duration: number): number {
  if (!usableFps(fps)) return clampTime(t, duration);
  const index = frameIndexAt(t, fps);
  const onBoundary = Math.abs(t - index / fps) < 1e-6;
  return clampTime((onBoundary ? index - 1 : index) / fps, duration);
}

/**
 * 按帧数步进（±1 / ±10 共用）：
 * - delta = -1 走 prevFrameTime 的语义（帧中先回到本帧开头）；
 * - 其余按「当前帧序号 + delta」直接落边界，再钳制到 [0, duration]。
 */
export function stepFrames(t: number, fps: number, duration: number, delta: number): number {
  if (!usableFps(fps)) return clampTime(t, duration);
  if (delta === 0) return clampTime(t, duration);
  if (delta === -1) return prevFrameTime(t, fps, duration);
  if (delta === 1) return nextFrameTime(t, fps, duration);
  const index = frameIndexAt(t, fps);
  return clampTime((index + Math.trunc(delta)) / fps, duration);
}

/** 多路时长的交集（最小值）：时间轴以最短的一路为准；0/非法值忽略，全未知为 0。 */
export function minDuration(durations: readonly number[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const duration of durations) {
    if (!Number.isFinite(duration) || duration <= 0) continue;
    if (duration < min) min = duration;
  }
  return Number.isFinite(min) ? min : 0;
}

/** 时间戳格式化：分:秒.毫秒（毫秒三位，四舍五入进位）。 */
export function formatTimestamp(t: number): string {
  const totalMs = Math.max(0, Math.round(t * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = (totalMs - minutes * 60000) / 1000;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(3)}`;
}

/** 可用的帧率：有限且 > 0 才算已知，否则 null（步进禁用）。 */
export function usableFps(fps: number | null | undefined): number | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null;
  return fps;
}

/** 帧长（毫秒，一位小数）——读数区展示用。 */
export function frameLengthMs(fps: number): number {
  return 1000 / fps;
}

/** 帧率读数：整数帧率不带小数点，非整数保留三位（29.970）。 */
export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/** 估算总帧数（显示「/ N 帧」用；未就绪/未知返回 0）。 */
export function estimateFrameTotal(duration: number, fps: number | null): number {
  const usable = usableFps(fps);
  if (!usable || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(1, Math.round(duration * usable));
}
