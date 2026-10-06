// 多视图对比（T08 立项，T20 重组）：单「网格」模式同时查看多张图，行列按图片总数
// 自动排布（gridLayout，2×2/3×3 双入口已合并）。同步原理（T07 笔记定下的底座）：
// 所有格子读同一份「视口状态」（图片坐标系），各格用自己的窗格尺寸调 viewport.ts
// 换算——不复制任何视口几何逻辑。
// 图片解码经 loadImage 注入复用查看器的解码缓存（同一路径只解码一次，满格也不重复）。
// 选图逻辑（默认布局 / 每格显式选择 / 失效回落）是纯函数，由 multiview.test.ts 守护。

import {
  fitViewport,
  panBy,
  visibleRegion,
  zoomAt,
  type Size,
  type ViewportState,
} from './viewport';
import { fileName, truncateFileName } from './util';
import { canvasBg } from './theme'; // T23 接线点：画布底色随主题

/** 多视图用到的查看器界面状态切片（viewer.ts 的 state 结构兼容即可，按引用共享可写） */
export interface MultiviewState {
  /** 全格共享的视口；null = 待适配（图片就绪后按格子尺寸 fit） */
  viewport: ViewportState | null;
  /** 每格显式选图（单一网格，T19 的按档位隔离随 2×2/3×3 合并退化为单数组）：
   *  ''=显式留空，数组缺省位=走默认布局 */
  cellPaths: (string | null)[];
}

export interface MultiviewRound {
  referencePath: string;
  candidates: { path: string }[];
}

/** 与 viewer.ts 解码缓存条目的结构兼容切片（避免为复用缓存而引入模块环） */
export interface MultiviewImageEntry {
  status: 'loading' | 'ok' | 'error';
  img?: HTMLImageElement;
  width: number;
  height: number;
}

export type LoadImage = (path: string, onReady: () => void) => MultiviewImageEntry;

/** 缩放≥100% 后关闭平滑，按最近邻显示原始像素（与 viewer.ts 的像素级查看一致） */
const NEAREST_ZOOM = 1;

// ---------- 选图逻辑（纯函数，单测覆盖） ----------

/** 网格行列按图片总数自动排布（T20 合并 2×2/3×3 双入口后的票面映射）：
 *  1→单格、2→1×2、3-4→2×2、5-6→2×3、7-9→3×3、更多按 3 列折行。
 *  count 由调用方按「参与对比的图片总数」传入（图片=原图+跑分图，视频=全部源）。 */
export function gridLayout(count: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.floor(count));
  if (n <= 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  if (n <= 9) return { rows: 3, cols: 3 };
  return { rows: Math.ceil(n / 3), cols: 3 };
}

/** 第 index 位的默认选图：第 0 位原图，其余按跑分图顺序填入，不够的留空。
 *  网格（cellPaths）与分屏（panePaths）的默认布局完全同构，共用本函数。 */
export function defaultPaneImage(index: number, round: MultiviewRound): string | null {
  if (index === 0) return round.referencePath;
  return round.candidates[index - 1]?.path ?? null;
}

/** 第 index 位最终显示的图：显式选择仍有效则用之（''=显式留空），否则回落到默认布局。
 *  T25 抽成通用形式：网格每格与分屏每栏共用同一套「显式选择 / 失效回落 / 越界留空」语义
 *  （分屏不提供「（空）」选项，但空串语义仍由本函数承载）。 */
export function resolvePaneImage(
  paths: ReadonlyArray<string | null | undefined> | null | undefined,
  index: number,
  round: MultiviewRound,
): string | null {
  const chosen = paths?.[index];
  if (chosen !== null && chosen !== undefined) {
    if (chosen === '') return null; // 显式留空
    const valid = chosen === round.referencePath
      || round.candidates.some((c) => c.path === chosen);
    if (valid) return chosen;
    // 图已不在本轮（被删除等）：回落默认，不显示失效图
  }
  return defaultPaneImage(index, round);
}

/** 第 index 格的默认选图（薄封装，实现在 defaultPaneImage）。
 *  保留「格」口径签名：视频侧 resolveCellVideo 与既有调用方/测试都用它，改签名会扩散到无关模块。 */
export function defaultCellImage(index: number, round: MultiviewRound): string | null {
  return defaultPaneImage(index, round);
}

/** 每格最终显示的图：显式选择仍有效则用之（''=显式留空），否则回落到默认布局。
 *  同上是为视频侧 resolveCellVideo 与既有调用方/测试保留的薄封装（实现见 resolvePaneImage）。 */
export function resolveCellImage(
  shared: MultiviewState,
  index: number,
  round: MultiviewRound,
): string | null {
  return resolvePaneImage(shared.cellPaths, index, round);
}

// ---------- 挂载 ----------

/**
 * 把多视图网格挂到 area 上（area 原有内容被替换）。
 * shared 即 viewer.ts 的界面状态对象：viewport 全格共享（同步缩放平移的关键），
 * cellPaths 记录每格显式选择，跨跑分刷新保留。
 * 行列按「原图 + 跑分图总数」经 gridLayout 自动排布（T20：2×2/3×3 双入口合并为单网格）。
 */
export function mountMultiview(
  area: HTMLElement,
  round: MultiviewRound,
  shared: MultiviewState,
  loadImage: LoadImage,
): void {
  const { rows, cols } = gridLayout(1 + round.candidates.length);
  const count = rows * cols;

  // ----- 网格与每格（画布 + 选图下拉）：格子随窗口伸缩，留白与边框沿用现有查看器样式 -----
  const grid = document.createElement('div');
  grid.className = 'viewer-grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  area.replaceChildren(grid);

  interface Cell {
    canvas: HTMLCanvasElement;
    select: HTMLSelectElement;
  }
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const pane = document.createElement('div');
    pane.className = 'viewer-pane';
    const canvas = document.createElement('canvas');
    const select = document.createElement('select');
    select.className = 'viewer-cell-select';
    select.title = `格 ${i + 1}：选本格显示的图`;
    select.ariaLabel = `格 ${i + 1} 选图`;
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '（空）';
    const refOption = document.createElement('option');
    refOption.value = round.referencePath;
    // T18：下拉选项统一中间截断，悬浮 title 看全路径
    refOption.textContent = `原图：${truncateFileName(fileName(round.referencePath))}`;
    refOption.title = round.referencePath;
    select.append(emptyOption, refOption);
    for (const candidate of round.candidates) {
      const option = document.createElement('option');
      option.value = candidate.path;
      option.textContent = truncateFileName(fileName(candidate.path));
      option.title = candidate.path;
      select.append(option);
    }
    select.value = resolveCellImage(shared, i, round) ?? '';
    select.addEventListener('change', () => {
      // 首次手动改选才落状态；写回单份 cellPaths（单一网格，无档位维度）
      const nextPaths: (string | null)[] = Array.from(
        { length: count },
        (_, k) => shared.cellPaths[k] ?? null,
      );
      nextPaths[i] = select.value; // '' = 显式留空
      shared.cellPaths = nextPaths;
      refreshImages();
      scheduleDraw();
    });
    pane.append(canvas, select);
    grid.append(pane);
    cells.push({ canvas, select });
  }

  // ----- 每格当前要画的图（选图变化时整体刷新；loadImage 内部按路径去重解码） -----
  interface CellImage {
    path: string | null;
    entry: MultiviewImageEntry | null;
  }
  let cellImages: CellImage[] = [];
  function refreshImages(): void {
    cellImages = cells.map((_, i) => {
      const path = resolveCellImage(shared, i, round);
      return { path, entry: path ? loadImage(path, scheduleDraw) : null };
    });
  }
  refreshImages();

  // ----- 重绘调度（rAF 节流：一帧内多次改动只画一次） -----
  let rafId = 0;
  function scheduleDraw(): void {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  // ----- 交互：任一格滚轮缩放（光标锚点）/ 拖拽平移 / 双击复位，全格同步 -----
  function attachPanZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const vp = shared.viewport;
      if (!vp) return;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      shared.viewport = zoomAt(
        vp,
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
      if (shared.viewport) {
        shared.viewport = panBy(shared.viewport, e.clientX - lastX, e.clientY - lastY);
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
      shared.viewport = null; // 复位 = 重新按格子尺寸 fit
      scheduleDraw();
    });
  }
  for (const cell of cells) attachPanZoom(cell.canvas);

  // 格子尺寸变化（拉伸窗口）：格子由 CSS 伸缩，重设画布背板并重绘，视口保持不动
  const observer = new ResizeObserver(() => scheduleDraw());
  observer.observe(grid);

  // ----- 绘制 -----
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

  function drawCell(i: number): void {
    const prepared = prepare(cells[i].canvas);
    if (!prepared) return;
    const { ctx, size } = prepared;
    // 背景色与 viewer.ts 一致，让图片边界可辨
    ctx.fillStyle = canvasBg(); // 主题同源：读 CSS 变量 --canvas-bg（T23）
    ctx.fillRect(0, 0, size.width, size.height);
    const { path, entry } = cellImages[i];
    if (!entry || entry.status === 'loading') {
      drawMessage(ctx, size, '正在加载图片…');
      return;
    }
    if (entry.status === 'error' || !entry.img) {
      drawMessage(ctx, size, `图片加载失败：${fileName(path ?? '')} 可能已被移动、重命名或删除`);
      return;
    }
    const vp = shared.viewport;
    if (!vp) return;
    const region = visibleRegion(vp, size, { width: entry.width, height: entry.height });
    if (!region) return;
    ctx.imageSmoothingEnabled = vp.zoom < NEAREST_ZOOM;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      entry.img,
      region.src.x, region.src.y, region.src.width, region.src.height,
      region.dst.x, region.dst.y, region.dst.width, region.dst.height,
    );
  }

  function draw(): void {
    if (!area.isConnected) return;
    // 视口待适配：用第一格已就绪的图（默认即原图）按格子尺寸 fit；格子还没量出尺寸就等下次重绘
    if (!shared.viewport) {
      for (let i = 0; i < cells.length; i++) {
        const entry = cellImages[i].entry;
        if (entry?.status !== 'ok') continue;
        const rect = cells[i].canvas.getBoundingClientRect();
        const pane = { width: Math.round(rect.width), height: Math.round(rect.height) };
        if (pane.width > 1 && pane.height > 1) {
          shared.viewport = fitViewport({ width: entry.width, height: entry.height }, pane);
        }
        break;
      }
    }
    for (let i = 0; i < cells.length; i++) drawCell(i);
  }

  scheduleDraw();
}
