// 对比查看器（T07）：左右分屏与滑动对比两种模式，共享同一份「视口状态」实现同步缩放平移。
// T09 接线：叠加对比 / 差异图 / 闪烁切换三种模式并入同一份视口状态（实现见 src/compare-modes.ts，
// 接线点在代码中均以「T09 接线」注释标记，便于与并行票 T08 的多视图做并集合并）。
// 渲染用 Canvas；滚轮缩放（光标为锚点）、拖拽平移、分割线拖动只改视口状态，按 rAF 节流重绘。
// 图片经 asset protocol（convertFileSrc）交给 WebView 原生解码，不经 IPC 传像素。
// 界面与交互不写 DOM 级自动化，以截图/录屏作为验收证据（规格 Testing Decisions）。

import { convertFileSrc } from '@tauri-apps/api/core';
import {
  fitViewport,
  panBy,
  visibleRegion,
  zoomAt,
  type Size,
  type ViewportState,
} from './viewport';
import {
  buildT09Controls,
  defaultCompareUi,
  renderDiffCanvas,
  startBlink,
  stopBlink,
  type CompareUiState,
} from './compare-modes';
import { fileName, truncateFileName } from './util';
import { mountMultiview, resolvePaneImage, applyGridZoom, buildGridZoomButton, gridLayout } from './multiview'; // T08 接线点：多视图网格的实现见 src/multiview.ts；T27：网格放大按钮同源
import { canvasBg } from './theme'; // T23 接线点：画布底色随主题

export interface ViewerRound {
  roundId: string;
  referencePath: string;
  candidates: { path: string }[];
}

// ---------- 槽位解析（纯函数，viewer.test.ts 守护） ----------

/** 单槽模式（分屏/滑动/叠加/差异/闪烁共用一个跑分图槽）的槽位解析：
 *  显式选择仍在本轮候选里则用之，否则回落第一张（候选删光时为 null）。
 *  换图路径必须每次经此解析（T19 回归：槽位状态曾与画布条目脱钩，画布持续画旧图）。 */
export function resolveCandidatePath(
  chosen: string | null,
  round: Pick<ViewerRound, 'candidates'>,
): string | null {
  if (chosen && round.candidates.some((c) => c.path === chosen)) return chosen;
  return round.candidates[0]?.path ?? null;
}

// T20 重组：模式入口收敛为六个——分屏（自动 N 栏）/滑动/网格（自动排布）/叠加/差异/闪烁；
// T08 的 multiview2/multiview3 双入口合并为单 'grid'（行列由 gridLayout 按数量自动排布）
type ViewerMode = 'split' | 'slider' | 'grid' | 'overlay' | 'diff' | 'blink';

/** 单槽模式：共用一个「跑分图」下拉的四个模式（分屏 T20 起自动 N 栏、网格用 cellPaths，不在此列） */
export type SingleSlotMode = 'slider' | 'overlay' | 'diff' | 'blink';

export function isSingleSlotMode(mode: ViewerMode): mode is SingleSlotMode {
  return mode === 'slider' || mode === 'overlay' || mode === 'diff' || mode === 'blink';
}

/** 各单槽模式手动选中的跑分图（US16 按「轮×模式」隔离，互不串扰）：
 *  键缺省 = 该模式未手动选过（跟随当前候选顺序）；换轮重置 */
export type ModeCandidateChoices = Partial<Record<SingleSlotMode, string>>;

/** 某个单槽模式的槽位解析：该模式自己的手动选择仍在本轮候选里则用之，
 *  否则回落第一张（未手动选过 / 选择已删除 / 候选删光时为 null）。
 *  换图路径必须每次经此解析（T19 回归：槽位状态曾与画布条目脱钩，画布持续画旧图）。 */
export function resolveModeCandidatePath(
  choices: ModeCandidateChoices,
  mode: SingleSlotMode,
  round: Pick<ViewerRound, 'candidates'>,
): string | null {
  return resolveCandidatePath(choices[mode] ?? null, round);
}

/** 缩放≥100% 后关闭平滑，按最近邻显示原始像素（像素级查看） */
const NEAREST_ZOOM = 1;

// ---------- 查看器界面状态（按评测轮键控：切走保留、切回还原；不持久化，重启归零） ----------

interface ViewerState {
  mode: ViewerMode;
  /** 滑动对比的分割线位置：占画布宽度的比例 0~1 */
  divider: number;
  /** 各单槽模式（滑动/叠加/差异/闪烁）手动选中的跑分图（US16 按「轮×模式」隔离）：
   *  键缺省 = 未手动选过（跟随当前候选顺序）；分屏用 panePaths、网格用 cellPaths 不用此槽 */
  candidateChoices: ModeCandidateChoices;
  /** 网格每格显式选图（单一网格，T19 的按档位隔离随 2×2/3×3 合并退化为单数组）：
   *  ''=显式留空，数组缺省位=走默认布局 */
  cellPaths: (string | null)[];
  /** 分屏每栏显式选图（T25）：数组缺省位=走默认布局（第 0 栏原图、第 i 栏第 i 张跑分图），
   *  选项里没有「（空）」——分屏每栏必须显示一张图；失效选择由 resolvePaneImage 回落 */
  panePaths: (string | null)[];
  /** 共享视口；null = 待适配（图片就绪后按窗格尺寸 fit） */
  viewport: ViewportState | null;
  /** 网格放大态（T27，issue #32）：显式「放大/还原」切换，按轮键控，新轮默认未放大 */
  gridZoomed: boolean;
  /** T09 三种模式的控件状态（T25 第 2 项：每轮一份，切标签互不串扰、切走保留） */
  compareUi: CompareUiState;
}

/** T25 第 2 项：会话状态按评测轮键控（此前是「模块级单例 + 换轮重置」，
 *  切标签会丢模式和视口）。切走保留、切回还原，不持久化（重启归零）。 */
const viewerStates = new Map<string, ViewerState>();

/** 取该评测轮的状态；首次用到时按默认值创建（左右分屏、分割线居中、视口待 fit）。 */
function viewerStateFor(roundId: string): ViewerState {
  let st = viewerStates.get(roundId);
  if (!st) {
    st = {
      mode: 'split',
      divider: 0.5,
      candidateChoices: {},
      cellPaths: [],
      panePaths: [],
      viewport: null,
      gridZoomed: false,
      compareUi: defaultCompareUi(),
    };
    viewerStates.set(roundId, st);
  }
  return st;
}

// ---------- 解码图片缓存（会话级，同一张图切换模式/跑分刷新后直接复用） ----------

interface ImageEntry {
  status: 'loading' | 'ok' | 'error';
  img?: HTMLImageElement;
  width: number;
  height: number;
  /** 加载完成/失败时依次回调（多个查看器实例可能等同一张图） */
  listeners: Array<() => void>;
}

const imageCache = new Map<string, ImageEntry>();

// T09 接线：差异图整图缓存（同两张图同阈值只算一次；换图/换阈值后 key 不匹配自动重算）。
// 按原图分辨率整图生成，之后缩放平移走普通 drawImage 路径，交互全程零像素重算。
let diffCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** 确保图片开始加载；已加载的直接返回，加载中的登记回调。 */
function ensureImage(path: string, onReady: () => void): ImageEntry {
  let entry = imageCache.get(path);
  if (!entry) {
    entry = { status: 'loading', width: 0, height: 0, listeners: [] };
    imageCache.set(path, entry);
    const img = new Image();
    // T09：以匿名 CORS 方式加载 asset protocol 图片——差异图要把像素读进 canvas（getImageData），
    // 不声明 crossOrigin 时画布会被跨源图片污染并抛 SecurityError（叠加/分屏不受影响，但必须统一声明）
    img.crossOrigin = 'anonymous';
    const settle = (ok: boolean) => {
      const e = imageCache.get(path);
      if (!e) return;
      e.status = ok ? 'ok' : 'error';
      if (ok) {
        e.img = img;
        e.width = img.naturalWidth;
        e.height = img.naturalHeight;
      }
      for (const fn of e.listeners) fn();
      e.listeners = [];
    };
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = convertFileSrc(path);
  }
  if (entry.status === 'loading') entry.listeners.push(onReady);
  return entry;
}

// ---------- 挂载 ----------

/**
 * 把对比查看器挂到 container 上（container 原有内容被替换）。
 * 界面状态按评测轮键控（T25 第 2 项）：切走保留、切回还原；新轮回到默认（左右分屏、
 * 分割线居中、选中第一张跑分图并 fit）。同一轮内切换模式/跑分图/跑分刷新都保留视口与分割线。
 */
export function mountViewer(container: HTMLElement, round: ViewerRound): void {
  // T09 接线：重挂（换轮/切模式/跑分刷新）先停闪烁定时器；若仍处于闪烁模式，挂载尾部会重启
  stopBlink();
  const state = viewerStateFor(round.roundId);

  // ----- 工具条：模式切换 + 跑分图选择 -----
  const bar = document.createElement('div');
  bar.className = 'viewer-bar';

  const title = document.createElement('span');
  title.className = 'viewer-title';
  title.textContent = '对比查看器';

  const modes = document.createElement('div');
  modes.className = 'viewer-modes';
  modes.role = 'group';
  modes.ariaLabel = '对比模式';

  // T20 重组：六个模式入口（原 2×2/3×3 网格合并为「网格」，行列自动排布）
  const MODES: Array<{ id: ViewerMode; label: string }> = [
    { id: 'split', label: '左右分屏' },
    { id: 'slider', label: '滑动对比' },
    { id: 'grid', label: '网格' },
    { id: 'overlay', label: '叠加对比' },
    { id: 'diff', label: '差异图' },
    { id: 'blink', label: '闪烁切换' },
  ];
  const modeButtons = new Map<ViewerMode, HTMLButtonElement>();
  const syncModeButtons = (): void => {
    for (const [id, btn] of modeButtons) {
      btn.classList.toggle('active', state.mode === id);
    }
  };
  const switchMode = (mode: ViewerMode): void => {
    if (state.mode === mode) return;
    // 审查修复：离开闪烁模式把显示面归位原图——否则「播放中停在跑分图就切走」会把这面存进
    // 本轮状态，下次进模式静止显示跑分图，与「进模式静止显示原图」的语义相反
    if (state.mode === 'blink') state.compareUi.blinkShowingRef = true;
    stopBlink(); // 离开闪烁模式先停表；若正切进闪烁模式，挂载尾部会重启
    state.mode = mode;
    state.viewport = null; // 切模式后窗格几何变了，重新 fit（沿用 T07 行为）
    syncModeButtons();
    mountViewer(container, round);
  };
  for (const { id, label } of MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => switchMode(id));
    modeButtons.set(id, btn);
    modes.append(btn);
  }
  syncModeButtons();

  const candLabel = document.createElement('label');
  candLabel.className = 'viewer-cand';
  candLabel.textContent = '跑分图';
  const candSelect = document.createElement('select');
  for (const candidate of round.candidates) {
    const option = document.createElement('option');
    option.value = candidate.path;
    // T18：下拉选项统一中间截断，悬浮 title 看全路径
    option.textContent = truncateFileName(fileName(candidate.path));
    option.title = candidate.path;
    candSelect.append(option);
  }
  // 当前模式的槽位解析（该模式自己的选择；未手动选过回落第一张）
  const currentCandidate = isSingleSlotMode(state.mode)
    ? resolveModeCandidatePath(state.candidateChoices, state.mode, round)
    : null;
  candSelect.value = currentCandidate ?? '';
  candSelect.addEventListener('change', () => {
    // T19 修复：换图只更新槽位状态即可——draw() 每次绘制按最新选择重新解析
    // 图像条目，不再依赖挂载时闭包捕获的 candEntry（曾导致画布持续画旧图直到重挂）。
    // US16：选择写进当前模式自己的键位，不串扰其他单槽模式
    if (!isSingleSlotMode(state.mode)) return;
    state.candidateChoices = { ...state.candidateChoices, [state.mode]: candSelect.value };
    scheduleDraw();
  });
  candLabel.append(candSelect);

  const hint = document.createElement('span');
  hint.className = 'viewer-hint';
  // T25 第 4 项：闪烁模式提示补「长按看对比图」（该模式的手动对比交互，不新增按钮）
  hint.textContent = state.mode === 'blink'
    ? '滚轮缩放 · 拖拽平移 · 双击复位 · 长按看对比图'
    : '滚轮缩放 · 拖拽平移 · 双击复位';

  bar.append(title, modes);

  // T27（issue #32）：网格模式的显式「放大/还原」切换。放大状态按轮键控（决策 0019），
  // 接线与视频网格共用 multiview 的 buildGridZoomButton（几何切换 + 重新 fit）；
  // area 在下方才创建，由回调延迟取用
  if (state.mode === 'grid') {
    bar.append(buildGridZoomButton(state, () => gridLayout(1 + round.candidates.length).rows, () => area));
  }

  // T09 接线：三种新模式的专属控件（叠加不透明度滑杆 / 差异阈值滑杆 / 闪烁播放按钮），
  // 控件构建在 compare-modes.ts、状态由本轮 state.compareUi 持有；改动后回调整 scheduleDraw
  //（闪烁还要管定时器启停）
  if (state.mode === 'overlay' || state.mode === 'diff' || state.mode === 'blink') {
    const onChange =
      state.mode === 'blink'
        ? (): void => {
            if (state.compareUi.blinkPlaying) {
              startBlink(onBlinkFlip);
            } else {
              stopBlink();
              // 审查修复：暂停 = 静止显示原图。不归位的话「播放中暂停在跑分图 → 切走 → 切回」
              // 会静止在跑分图，长按不变、松手反跳原图，方向与需求相反
              state.compareUi.blinkShowingRef = true;
            }
            scheduleDraw();
          }
        : (): void => scheduleDraw();
    bar.append(buildT09Controls(state.mode, state.compareUi, onChange));
  }

  // T20 重组：分屏每栏有自己的下拉（挂到画布区），单槽「跑分图」下拉只属于
  // 滑动/叠加/差异/闪烁四个模式（网格用每格自己的下拉）
  if (isSingleSlotMode(state.mode)) {
    bar.append(candLabel);
  }
  bar.append(hint);

  // ----- 画布区 -----
  const area = document.createElement('div');
  area.className = 'viewer-area';
  container.replaceChildren(bar, area);

  let refCanvas: HTMLCanvasElement | null = null;
  let sliderCanvas: HTMLCanvasElement | null = null;
  // T20 重组：分屏自动 N 栏——第 0 栏原图、其余各一栏跑分图；T25 起每栏路径逐帧现解析
  const splitPanes: Array<{ canvas: HTMLCanvasElement }> = [];
  // T09 接线：叠加/差异/闪烁共用的单画布，以及随内容变化的角标（闪烁时显示当前是哪张）
  let stageCanvas: HTMLCanvasElement | null = null;
  let stageTag: HTMLSpanElement | null = null;
  /** 差异图正在后台整图计算（防滑杆连续触发时排队重复计算） */
  let diffComputing = false;
  let dividerEl: HTMLDivElement | null = null;

  if (state.mode === 'grid') {
    // ---- 多视图整体交给 multiview 模块渲染（T08 立项；T20 起行列自动排布） ----
    // 共享本查看器的 state（viewport + cellPaths）与解码缓存 ensureImage，
    // 因此格子间同步、切模式保留状态、图片不重复解码都与现有模式一致。
    area.className = 'viewer-area grid';
    mountMultiview(area, round, state, ensureImage);
    // T27：放大态按轮状态恢复（area 每次挂载都是新建元素，类与高度变量必须重放，
    // 否则切轮回来按钮显示「还原」而网格区是默认高度；与视频侧同一模式）
    applyGridZoom(area, gridLayout(1 + round.candidates.length).rows, state.gridZoomed);
  } else if (state.mode === 'split') {
    // ---- T20 重组：分屏自动 N 栏 ----
    // 原图固定最左，每张已选跑分图各加一栏（N 张 = N+1 栏）；同一张卡片内无缝拼接，
    // 全部栏读同一份 state.viewport 实现同步缩放平移；栏多时 flex 各自收窄。
    // T25 第 1 项：每栏左上角由文件名角标改成选图下拉（沿用网格格子样式），
    // 每栏可独立换图；选项 = 原图 + 全部跑分图，无「（空）」（栏必须显示一张图）。
    area.className = 'viewer-area split';
    const card = document.createElement('div');
    card.className = 'viewer-split-card';
    const paneCount = 1 + round.candidates.length;
    for (let i = 0; i < paneCount; i++) {
      const pane = document.createElement('div');
      pane.className = 'viewer-pane';
      const canvas = document.createElement('canvas');
      const select = document.createElement('select');
      select.className = 'viewer-cell-select';
      select.title = `第 ${i + 1} 栏：选本栏显示的图`;
      select.ariaLabel = `第 ${i + 1} 栏选图`;
      const refOption = document.createElement('option');
      refOption.value = round.referencePath;
      // T18：下拉选项统一中间截断，悬浮 title 看全路径
      refOption.textContent = `原图：${truncateFileName(fileName(round.referencePath))}`;
      refOption.title = round.referencePath;
      select.append(refOption);
      for (const candidate of round.candidates) {
        const option = document.createElement('option');
        option.value = candidate.path;
        option.textContent = truncateFileName(fileName(candidate.path));
        option.title = candidate.path;
        select.append(option);
      }
      select.value = resolvePaneImage(state.panePaths, i, round) ?? round.referencePath;
      select.addEventListener('change', () => {
        // 首次手动改选才落状态；数组按当前栏数扩长（缺省位=默认布局）
        const next = Array.from({ length: paneCount }, (_, k) => state.panePaths[k] ?? null);
        next[i] = select.value;
        state.panePaths = next;
        scheduleDraw(); // 换图立即生效：draw() 每帧按最新选择现解析，不重挂
      });
      pane.append(canvas, select);
      card.append(pane);
      splitPanes.push({ canvas });
    }
    area.append(card);
  } else if (state.mode === 'slider') {
    const slider = document.createElement('div');
    slider.className = 'viewer-slider';
    sliderCanvas = document.createElement('canvas');
    dividerEl = document.createElement('div');
    dividerEl.className = 'viewer-divider';
    dividerEl.title = '拖动分割线对比两侧画面';
    const handle = document.createElement('div');
    handle.className = 'viewer-handle';
    handle.textContent = '⟷';
    dividerEl.append(handle);
    const refTag = document.createElement('span');
    refTag.className = 'viewer-tag';
    refTag.textContent = '原图';
    const candTag = document.createElement('span');
    candTag.className = 'viewer-tag right';
    candTag.textContent = '跑分图';
    slider.append(sliderCanvas, dividerEl, refTag, candTag);
    area.append(slider);
    refCanvas = sliderCanvas;
  } else {
    // T09 接线：叠加/差异图/闪烁切换——单画布 + 角标，与分屏/滑动共用同一份视口状态
    const stage = document.createElement('div');
    stage.className = 'viewer-stage';
    stageCanvas = document.createElement('canvas');
    stageTag = document.createElement('span');
    stageTag.className = 'viewer-tag';
    stageTag.textContent =
      state.mode === 'overlay' ? '叠加对比' : state.mode === 'diff' ? '差异图' : '原图';
    stage.append(stageCanvas, stageTag);
    area.append(stage);
    refCanvas = stageCanvas;
  }

  // ----- 重绘调度（rAF 节流：一帧内多次改动只画一次） -----
  let rafId = 0;
  function scheduleDraw(): void {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  // T09 接线：闪烁定时器每次到点把显示内容翻面（tag 文案在 draw 里随内容同步）
  const onBlinkFlip = (): void => {
    state.compareUi.blinkShowingRef = !state.compareUi.blinkShowingRef;
    scheduleDraw();
  };

  // ----- 通用交互：滚轮缩放（光标锚点）+ 拖拽平移 + 双击复位 -----
  function attachPanZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!state.viewport) return;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      state.viewport = zoomAt(
        state.viewport,
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
      if (state.viewport) {
        state.viewport = panBy(state.viewport, e.clientX - lastX, e.clientY - lastY);
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
      state.viewport = null; // 复位 = 重新按窗格 fit
      scheduleDraw();
    });
  }
  // 多视图模式下画布归 multiview 模块管；分屏 N 栏逐栏接交互，其余模式接在 refCanvas
  if (splitPanes.length > 0) {
    for (const pane of splitPanes) attachPanZoom(pane.canvas);
  } else if (refCanvas) {
    attachPanZoom(refCanvas);
  }

  // ----- T25 第 4 项：闪烁模式的「长按看对比图」-----
  // 画布按下 400ms 无位移 → 一直显示跑分图（覆盖自动播放状态），角标随之显示「跑分图」；
  // 松开或指针取消 → 回原图。与拖拽平移兼容：位移超过 5px 即取消长按判定（拖动时不闪出
  // 对比图），长按触发后继续拖动仍平移（平移路径不受影响）。
  const LONG_PRESS_MS = 400;
  const LONG_PRESS_CANCEL_PX = 5;
  /** 长按期间是否强制显示跑分图（瞬时交互态，不进状态容器：松手即失效） */
  let longPressComparing = false;
  function attachBlinkLongPress(canvas: HTMLCanvasElement): void {
    let timer = 0;
    let originX = 0;
    let originY = 0;
    const cancelTimer = (): void => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
    };
    const release = (): void => {
      cancelTimer();
      if (!longPressComparing) return;
      longPressComparing = false;
      state.compareUi.blinkShowingRef = true; // 松开恢复原图
      scheduleDraw();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cancelTimer();
      originX = e.clientX;
      originY = e.clientY;
      timer = window.setTimeout(() => {
        timer = 0;
        longPressComparing = true;
        scheduleDraw();
      }, LONG_PRESS_MS);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!timer) return;
      // 「位移」按离按下原点的距离判定：静止长按的微小抖动不误取消，真拖动（>5px）正常取消
      if (Math.hypot(e.clientX - originX, e.clientY - originY) > LONG_PRESS_CANCEL_PX) cancelTimer();
    });
    // 指针抬起/取消都要收回对比图（指针可能移出画布，事件仍经 pointer capture 回到本画布）
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }
  if (state.mode === 'blink' && stageCanvas) attachBlinkLongPress(stageCanvas);

  // ----- 分割线拖动 -----
  if (dividerEl && sliderCanvas) {
    let dragging = false;
    dividerEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      dividerEl!.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    dividerEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = sliderCanvas!.getBoundingClientRect();
      state.divider = Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width));
      dividerEl!.style.left = `${state.divider * rect.width}px`;
      scheduleDraw();
    });
    const stopDrag = (): void => { dragging = false; };
    dividerEl.addEventListener('pointerup', stopDrag);
    dividerEl.addEventListener('pointercancel', stopDrag);
  }

  // 窗格尺寸变化（拉伸窗口）：重设画布并重绘，视口保持不动
  const observer = new ResizeObserver(() => scheduleDraw());
  observer.observe(area);

  // 开始加载原图（缓存命中则立即就绪）。跑分图条目不在此处绑定：
  // draw() 每帧按当前模式的最新选择重新解析（T19 修复，见 draw 内注释）。
  const refEntry = ensureImage(round.referencePath, scheduleDraw);

  /** 把画布背后 store 调到窗格实际尺寸 × 设备像素比，返回 CSS 尺寸的绘图上下文。 */
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
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, size: { width: w, height: h } };
  }

  function drawMessage(ctx: CanvasRenderingContext2D, size: Size, msg: string): void {
    ctx.fillStyle = '#9a9a9a';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, size.width / 2, size.height / 2);
  }

  /** 把一张图按当前视口画进窗格；图片未就绪时画提示文字。 */
  function drawPane(
    ctx: CanvasRenderingContext2D,
    size: Size,
    entry: ImageEntry | null | undefined,
    role: string,
    path: string,
  ): void {
    if (!entry || entry.status === 'loading') {
      drawMessage(ctx, size, `正在加载${role}…`);
      return;
    }
    if (entry.status === 'error' || !entry.img) {
      drawMessage(ctx, size, `${role}加载失败：${fileName(path)} 可能已被移动、重命名或删除`);
      return;
    }
    drawImage(ctx, size, entry);
  }

  /** 把一个可绘制源（图片或生成的差异画布）按当前视口画进窗格；只画可见部分保证流畅。 */
  function drawSource(
    ctx: CanvasRenderingContext2D,
    size: Size,
    source: CanvasImageSource,
    width: number,
    height: number,
  ): void {
    const vp = state!.viewport;
    if (!vp) return;
    const region = visibleRegion(vp, size, { width, height });
    if (!region) return;
    ctx.imageSmoothingEnabled = vp.zoom < NEAREST_ZOOM;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      source,
      region.src.x, region.src.y, region.src.width, region.src.height,
      region.dst.x, region.dst.y, region.dst.width, region.dst.height,
    );
  }

  function drawImage(ctx: CanvasRenderingContext2D, size: Size, entry: ImageEntry): void {
    drawSource(ctx, size, entry.img!, entry.width, entry.height);
  }

  /** 视口待适配时，用已就绪的图（优先原图）按窗格尺寸 fit。 */
  function ensureFitted(size: Size, first: ImageEntry | null | undefined): void {
    const st = state;
    if (st.viewport || !first || first.status !== 'ok') return;
    st.viewport = fitViewport({ width: first.width, height: first.height }, size);
  }

  function draw(): void {
    const st = state;
    if (!area.isConnected) return;
    // T19 修复：每次绘制按最新选择重新解析跑分图条目——换图立即生效。
    // US16：解析走当前模式自己的键位（滑动/叠加/差异/闪烁各用各的，互不串扰）；
    // 分屏每栏走 panePaths；差异图缓存 key 含解析出的路径，随之自动失效重算。
    const candPath = isSingleSlotMode(st.mode)
      ? resolveModeCandidatePath(st.candidateChoices, st.mode, round)
      : null;
    const candEntry = candPath ? ensureImage(candPath, scheduleDraw) : null;
    if (st.mode === 'split') {
      // ---- T20 重组：自动 N 栏——全部栏同一视口，逐栏解析并绘制 ----
      if (splitPanes.length === 0) return;
      const preparedPanes = splitPanes.map((pane) => prepare(pane.canvas));
      const first = preparedPanes[0];
      if (!first) return;
      // T25 第 1 项：每栏路径逐帧现解析（显式选择 / 失效回落 / 越界都在 resolvePaneImage 里），
      // 换图只改 state.panePaths 后重绘，不重挂；条目解析永远跟随最新槽位（T19 纪律）
      const paneEntries = splitPanes.map((_, i) => {
        const path = resolvePaneImage(st.panePaths, i, round);
        return path ? ensureImage(path, scheduleDraw) : null;
      });
      // 原图未就绪时用第一栏的图兜底 fit（沿用 T07「优先原图、否则候选」行为）
      ensureFitted(first.size, refEntry.status === 'ok' ? refEntry : paneEntries[0]);
      for (let i = 0; i < splitPanes.length; i++) {
        const prepared = preparedPanes[i];
        if (!prepared) continue;
        prepared.ctx.fillStyle = canvasBg(); // 主题同源：读 CSS 变量 --canvas-bg（T23）
        prepared.ctx.fillRect(0, 0, prepared.size.width, prepared.size.height);
        const path = resolvePaneImage(st.panePaths, i, round);
        const role = path === round.referencePath ? '原图' : '跑分图';
        drawPane(prepared.ctx, prepared.size, paneEntries[i], role, path ?? '');
      }
    } else if (sliderCanvas) {
      const prepared = prepare(sliderCanvas);
      if (!prepared) return;
      const { ctx, size } = prepared;
      ctx.fillStyle = canvasBg(); // 主题同源：读 CSS 变量 --canvas-bg（T23）
      ctx.fillRect(0, 0, size.width, size.height);
      ensureFitted(size, refEntry.status === 'ok' ? refEntry : candEntry);

      if (!refEntry || refEntry.status !== 'ok') {
        drawPane(ctx, size, refEntry, '原图', round.referencePath);
      } else if (!candEntry || candEntry.status !== 'ok') {
        // 跑分图未就绪：先整幅显示原图
        drawImage(ctx, size, refEntry);
        drawPane(ctx, size, candEntry, '跑分图', candPath ?? '');
      } else {
        // 右侧整幅画跑分图，再裁出左半幅画原图——两侧共享同一视口
        drawImage(ctx, size, candEntry);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, st.divider * size.width, size.height);
        ctx.clip();
        drawImage(ctx, size, refEntry);
        ctx.restore();
      }
      if (dividerEl) dividerEl.style.left = `${st.divider * size.width}px`;
    } else if (stageCanvas) {
      // ----- T09 接线：叠加 / 差异图 / 闪烁切换（与分屏/滑动共用同一份视口状态） -----
      const prepared = prepare(stageCanvas);
      if (!prepared) return;
      const { ctx, size } = prepared;
      ctx.fillStyle = canvasBg(); // 主题同源：读 CSS 变量 --canvas-bg（T23）
      ctx.fillRect(0, 0, size.width, size.height);
      ensureFitted(size, refEntry.status === 'ok' ? refEntry : candEntry);
      const refOk = refEntry.status === 'ok' && refEntry.img !== undefined;
      const candOk = candEntry !== null && candEntry.status === 'ok' && candEntry.img !== undefined;

      if (st.mode === 'overlay') {
        // 先整幅画原图，再按不透明度把跑分图叠上去：两次 drawImage 走同一 visibleRegion
        if (!refOk) {
          drawPane(ctx, size, refEntry, '原图', round.referencePath);
        } else {
          drawImage(ctx, size, refEntry);
          if (candOk && st.compareUi.opacity > 0) {
            ctx.globalAlpha = st.compareUi.opacity;
            drawImage(ctx, size, candEntry);
            ctx.globalAlpha = 1;
          } else if (!candOk) {
            drawPane(ctx, size, candEntry, '跑分图', candPath ?? '');
          }
        }
        if (stageTag) stageTag.textContent = '叠加对比';
      } else if (st.mode === 'diff') {
        if (!refOk) {
          drawPane(ctx, size, refEntry, '原图', round.referencePath);
        } else if (!candOk) {
          drawPane(ctx, size, candEntry, '跑分图', candPath ?? '');
        } else if (refEntry.width !== candEntry.width || refEntry.height !== candEntry.height) {
          // 逐像素运算要求同尺寸：尺寸不一致给中文提示，应用不崩（与加载失败处理一致）
          drawMessage(ctx, size, '原图与跑分图尺寸不一致，无法生成差异图');
          if (stageTag) stageTag.textContent = '差异图';
        } else {
          const key = `${round.referencePath}|${candPath}|${st.compareUi.threshold}`;
          if (diffCache && diffCache.key === key) {
            drawSource(ctx, size, diffCache.canvas, refEntry.width, refEntry.height);
          } else {
            // 计算期间每帧都显示提示（整图计算放到宏任务里，本帧先画出来；算完回填缓存再重绘）
            drawMessage(ctx, size, '正在计算差异图…');
            if (!diffComputing) {
              diffComputing = true;
              const refImg = refEntry.img!;
              const candImg = candEntry.img!;
              const threshold = st.compareUi.threshold;
              setTimeout(() => {
                diffComputing = false;
                const canvas = renderDiffCanvas(refImg, candImg, threshold);
                if (canvas) diffCache = { key, canvas };
                scheduleDraw();
              }, 0);
            }
          }
          if (stageTag) stageTag.textContent = '差异图';
        }
      } else {
        // 闪烁切换：按固定间隔在原图/跑分图之间翻面（定时器启停见 compare-modes.ts 接线）；
        // T25 第 4 项：长按期间强制显示跑分图（覆盖自动播放），松手回原图
        const showRef = longPressComparing ? false : st.compareUi.blinkShowingRef;
        const entry = showRef ? refEntry : candEntry;
        const role = showRef ? '原图' : '跑分图';
        if (entry && entry.status === 'ok' && entry.img !== undefined) {
          drawImage(ctx, size, entry);
        } else {
          drawPane(ctx, size, entry, role, showRef ? round.referencePath : candPath ?? '');
        }
        if (stageTag) stageTag.textContent = role;
      }
    }
  }

  // T09 接线：重挂后仍处于闪烁模式且在播放中，恢复自动交替（定时器生命周期见 compare-modes.ts）
  if (state.mode === 'blink' && state.compareUi.blinkPlaying) {
    startBlink(onBlinkFlip);
  }

  scheduleDraw();
}
