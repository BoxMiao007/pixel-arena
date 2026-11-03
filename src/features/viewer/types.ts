// 查看器的领域类型与模式元数据（纯数据，无 DOM）。
//
// 六个模式的 id 是稳定契约（既有状态、截图脚本、帮助文案都按 id 指认）；
// 键盘 1–6 的**顺序**与 id 不同，见 MODE_ORDER。

import type { IconName } from '../../ui/icons';

/** 对比模式。id 稳定，不要改。 */
export type ViewerMode = 'split' | 'slider' | 'overlay' | 'diff' | 'blink' | 'grid';

/** 共用「一张跑分图」槽的四个模式（分屏用 panePaths、网格用 cellPaths）。 */
export type SingleSlotMode = 'slider' | 'overlay' | 'diff' | 'blink';

export function isSingleSlotMode(mode: ViewerMode): mode is SingleSlotMode {
  return mode === 'slider' || mode === 'overlay' || mode === 'diff' || mode === 'blink';
}

export interface ModeMeta {
  label: string;
  /** 图标（toolbar 分段控制用，纯图标 + aria-label）。 */
  icon: IconName;
  /** 单行说明（title / 帮助面板）。 */
  description: string;
}

export const MODE_META: Record<ViewerMode, ModeMeta> = {
  split: { label: '分屏', icon: 'split', description: '原图与每张跑分图并排' },
  slider: { label: '滑动', icon: 'compare', description: '拖动分割线对比两侧' },
  overlay: { label: '叠加', icon: 'layers', description: '半透明叠加，调不透明度' },
  diff: { label: '差异', icon: 'diff', description: '高亮亮度差异，调阈值' },
  blink: { label: '闪烁', icon: 'eye', description: '交替显示，长按看对比图' },
  grid: { label: '多视图', icon: 'grid', description: '多图网格，逐格选图' },
};

/**
 * 键盘 1–6 与模式条的顺序（设计契约 §3.2）。
 *
 * 多视图紧跟分屏：两者都是「多栏/多格并排」的浏览方式，常用性仅次于主力分屏；
 * 滑动/叠加/差异/闪烁共用同一块单画布，排在后面。数字键、模式条、帮助文案
 * 全部由本数组派生，改顺序只需动这里。
 */
export const MODE_ORDER: readonly ViewerMode[] = [
  'split',
  'grid',
  'slider',
  'overlay',
  'diff',
  'blink',
];

/** 存储/外部输入 → 合法模式（localStorage 可能留着旧版本或手改的垃圾值）。 */
export function normalizeMode(value: unknown): ViewerMode {
  return typeof value === 'string' && (MODE_ORDER as readonly string[]).includes(value)
    ? (value as ViewerMode)
    : 'split';
}

/** 数字键 → 模式（'1'..'6'）；其它键返回 null。 */
export function modeForKey(key: string): ViewerMode | null {
  const index = Number(key) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= MODE_ORDER.length) return null;
  return MODE_ORDER[index] ?? null;
}

/** 查看器内的一张图：path 是真实路径（状态里存这个），displayPath 是实际加载的 URL 路径。 */
export interface ViewerImage {
  path: string;
  /** AVIF/JXL 指向 `<path>.png` 代片；其它与原路径相同。 */
  displayPath: string;
  /** 界面展示用文件名（不含目录、中间截断在调用处做）。 */
  name: string;
}

export interface ViewerRound {
  roundId: string;
  reference: ViewerImage | null;
  candidates: readonly ViewerImage[];
}

/** 选图纯函数只需要路径形状（测试也用它，不必构造 ViewerImage）。 */
export interface RoundLike {
  referencePath: string | null;
  candidates: readonly { path: string }[];
}

/** 叠加/差异/闪烁的可调参数（按轮隔离）。 */
export interface CompareUiState {
  /** 叠加：跑分图不透明度 0~1（默认 50%）。 */
  opacity: number;
  /** 差异：亮度差阈值 0~255 的实用区间 0~100（默认 2）。 */
  threshold: number;
  /** 闪烁：是否自动交替；暂停 = 静止显示原图。 */
  blinkPlaying: boolean;
  /** 闪烁：当前是否显示原图。 */
  blinkShowingRef: boolean;
}

/** 每个评测轮一份的查看器会话状态（切走保留、切回还原、不持久化）。 */
export interface ViewerState {
  /** 滑动对比分割线位置：占画布宽度比例 0~1。 */
  divider: number;
  /** 各单槽模式手动选中的跑分图（按「轮 × 模式」隔离；缺省=跟随候选顺序）。 */
  candidateChoices: Partial<Record<SingleSlotMode, string>>;
  /** 网格每格显式选图：''=显式留空，数组缺省位=默认布局。 */
  cellPaths: (string | null)[];
  /** 分屏每栏显式选图：数组缺省位=默认布局（第 0 栏原图、第 i 栏第 i 张跑分图）。 */
  panePaths: (string | null)[];
  /** 上一次构建时各栏/各格的默认布局（候选增删后据此让过期的显式选择失效）。 */
  paneDefaults: (string | null)[];
  cellDefaults: (string | null)[];
  /**
   * 全窗格共享视口，中心与倍数都按「锚图」（原图，没有时第一张候选）的图片像素
   * 绝对口径记录；null = 待适配（图片就绪后按窗格尺寸 fit）。
   * 网格模式不直接套这份绝对倍数：每格按自己的图片尺寸适配，共享倍数只作为
   * 「相对适应的倍数」使用（换算见 grid-view.ts），这样各格图像看起来一样大。
   */
  viewport: { centerX: number; centerY: number; zoom: number } | null;
  /**
   * 用户是否亲手调过缩放/位移（滚轮、拖拽、±、缩放档位、Shift+0）。
   * false = 仍处于「自动适应」：切模式或画布尺寸大幅变化时重算 fit；
   * true = 手动视图：切模式/改窗口都保留（不打断用户正在看的局部）。
   * 注意：显式「适应窗口」（0 / 双击 / 适应按钮 / 菜单适应）把它复位为 false——
   * 那本来就是要求自动适配，不该在换模式后沿用旧 fit。
   */
  viewportTouched: boolean;
  compare: CompareUiState;
}

export function defaultCompareUi(): CompareUiState {
  return {
    opacity: 0.5,
    // 默认 2：画质接近的编码对比里 24 太钝，细微差异几乎不出热区。
    threshold: 2,
    // 默认暂停并静止显示原图：长按看对比图才有意义（自动交替会把它淹没）。
    blinkPlaying: false,
    blinkShowingRef: true,
  };
}

export function defaultViewerState(): ViewerState {
  return {
    divider: 0.5,
    candidateChoices: {},
    cellPaths: [],
    panePaths: [],
    paneDefaults: [],
    cellDefaults: [],
    viewport: null,
    viewportTouched: false,
    compare: defaultCompareUi(),
  };
}

/** 闪烁间隔（毫秒）。 */
export const BLINK_INTERVAL_MS = 500;
/** 长按看对比图的判定时长与位移容差（像素）。 */
export const LONG_PRESS_MS = 400;
export const LONG_PRESS_CANCEL_PX = 5;
