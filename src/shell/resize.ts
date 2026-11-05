// 左右栏宽度调整的纯计算层：范围、夹取、拖拽方向与按键步进。
//
// 本次改动的位置：外壳新增两条竖直分隔条（app.ts 绑事件、shell.css 给样式），
// 数值口径全部收在这里，因此可以在 node 环境下单测，不必引 jsdom。
//
// 口径：
// - 左栏 160–360px；检视器 240–560px，且不超过窗口宽的一半（窄窗也要给舞台留画面）；
// - 未手动调过（偏好为 null）时宽度由 CSS 默认值与窄窗口 @media 决定，
//   所以这里的函数只在「已经决定写内联宽度」之后负责夹取；
// - NaN / 0 / 负数一律视为「没设置」，回落到默认宽度而不是最小值：
//   这些值只可能来自损坏的偏好或未初始化的测量，不是用户意图。

export type SidebarSide = 'rail' | 'inspector';

/** 键盘单步与按住 Shift 的粗调步长（px）。 */
export const SIDEBAR_KEY_STEP = 16;
export const SIDEBAR_KEY_STEP_LARGE = 48;

/** 双击分隔条恢复的默认宽度，与 shell.css 的初始值保持一致。 */
export const RAIL_DEFAULT_WIDTH = 208;
export const INSPECTOR_DEFAULT_WIDTH = 328;

interface SidebarRange {
  min: number;
  max: number;
  initial: number;
}

const RANGES: Record<SidebarSide, SidebarRange> = {
  rail: { min: 160, max: 360, initial: RAIL_DEFAULT_WIDTH },
  inspector: { min: 240, max: 560, initial: INSPECTOR_DEFAULT_WIDTH },
};

/** 检视器占窗口宽的硬上限比例。 */
const INSPECTOR_MAX_VIEWPORT_RATIO = 0.5;

function isUsableViewport(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth > 0;
}

/**
 * 当前可用的夹取区间。
 *
 * 窗口窄到连检视器最小宽度都放不下时（约 480px 以下），让「不超过一半」优先：
 * 宁可暂时低于 240px，也不要把舞台挤到看不见画面。
 */
export function sidebarRange(
  side: SidebarSide,
  viewportWidth: number,
): { min: number; max: number } {
  const base = RANGES[side];
  if (side === 'rail' || !isUsableViewport(viewportWidth)) {
    return { min: base.min, max: base.max };
  }
  const max = Math.min(base.max, Math.floor(viewportWidth * INSPECTOR_MAX_VIEWPORT_RATIO));
  return { min: Math.min(base.min, max), max };
}

/** 把任意输入收进合法区间；非法输入回落到默认宽度（必要时同样收进区间）。 */
export function clampSidebarWidth(
  side: SidebarSide,
  value: number,
  viewportWidth: number,
): number {
  const { min, max } = sidebarRange(side, viewportWidth);
  const wanted = Number.isFinite(value) && value > 0 ? value : RANGES[side].initial;
  // 取整：宽度最终要写进 CSS 变量与 aria-valuenow，整数更好读也更好比对。
  return Math.round(Math.min(Math.max(wanted, min), max));
}

/** 双击恢复的默认宽度（窄窗下可能被 50% 上限收窄）。 */
export function defaultSidebarWidth(side: SidebarSide, viewportWidth: number): number {
  return clampSidebarWidth(side, RANGES[side].initial, viewportWidth);
}

/** 拖拽结果：分隔条跟随指针，左栏边界右移变大，检视器边界左移变大。 */
export function dragSidebarWidth(
  side: SidebarSide,
  startWidth: number,
  deltaX: number,
  viewportWidth: number,
): number {
  const moved = side === 'rail' ? startWidth + deltaX : startWidth - deltaX;
  return clampSidebarWidth(side, moved, viewportWidth);
}

/**
 * 键盘调整：返回新的宽度，未处理的按键返回 null。
 *
 * 方向键让**分隔条自己**跟着箭头走（ARIA 分隔条惯例，也与拖拽一致）：左栏的分隔条在
 * 它右边，左移 = 左栏变窄；检视器的分隔条在它左边，左移 = 检视器变宽。两栏对同一个键
 * 的反应相反，但屏幕上看到的位移方向与手指方向一致，不会有「键和分隔条反向跑」的错觉。
 * Home / End 直接跳到区间两端。
 */
export function keyboardSidebarWidth(
  side: SidebarSide,
  currentWidth: number,
  key: string,
  shiftKey: boolean,
  viewportWidth: number,
): number | null {
  const step = shiftKey ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
  // 当前宽度不可信时从默认值起步，避免「从 NaN 加一步还是 NaN 再回落」的跳变。
  const base =
    Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : RANGES[side].initial;
  // 分隔条左移对宽度的影响：左栏的分隔条在右缘（左移 = 变窄），检视器的在左缘（左移 = 变宽）。
  const perArrowLeft = side === 'rail' ? -step : step;
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(side, base + perArrowLeft, viewportWidth);
    case 'ArrowRight':
      return clampSidebarWidth(side, base - perArrowLeft, viewportWidth);
    case 'Home':
      return sidebarRange(side, viewportWidth).min;
    case 'End':
      return sidebarRange(side, viewportWidth).max;
    default:
      return null;
  }
}
