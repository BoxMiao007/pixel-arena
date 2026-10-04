// 对比查看器（T07）：左右分屏与滑动对比两种模式，共享同一份「视口状态」实现同步缩放平移。
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
import { fileName } from './util';

export interface ViewerRound {
  roundId: string;
  referencePath: string;
  candidates: { path: string }[];
}

type ViewerMode = 'split' | 'slider';

/** 缩放≥100% 后关闭平滑，按最近邻显示原始像素（像素级查看） */
const NEAREST_ZOOM = 1;

// ---------- 查看器界面状态（跟随评测轮，不持久化，重启归零） ----------

let state: {
  roundId: string;
  mode: ViewerMode;
  /** 滑动对比的分割线位置：占画布宽度的比例 0~1 */
  divider: number;
  /** 当前在右栏/右侧显示的跑分图 */
  candidatePath: string | null;
  /** 共享视口；null = 待适配（图片就绪后按窗格尺寸 fit） */
  viewport: ViewportState | null;
} | null = null;

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

/** 确保图片开始加载；已加载的直接返回，加载中的登记回调。 */
function ensureImage(path: string, onReady: () => void): ImageEntry {
  let entry = imageCache.get(path);
  if (!entry) {
    entry = { status: 'loading', width: 0, height: 0, listeners: [] };
    imageCache.set(path, entry);
    const img = new Image();
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
 * 状态跟随评测轮：换轮重置（回到左右分屏、分割线居中、选中第一张跑分图并 fit）；
 * 同一轮内切换模式/跑分图/跑分刷新都保留视口与分割线。
 */
export function mountViewer(container: HTMLElement, round: ViewerRound): void {
  if (!state || state.roundId !== round.roundId) {
    state = {
      roundId: round.roundId,
      mode: 'split',
      divider: 0.5,
      candidatePath: round.candidates[0]?.path ?? null,
      viewport: null,
    };
  }
  // 跑分图可能被删光或换掉：失效时回落到第一张
  if (!state.candidatePath || !round.candidates.some((c) => c.path === state!.candidatePath)) {
    state.candidatePath = round.candidates[0]?.path ?? null;
    state.viewport = null;
  }

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
  const splitBtn = document.createElement('button');
  splitBtn.type = 'button';
  splitBtn.textContent = '左右分屏';
  const sliderBtn = document.createElement('button');
  sliderBtn.type = 'button';
  sliderBtn.textContent = '滑动对比';
  const syncModeButtons = (): void => {
    splitBtn.classList.toggle('active', state!.mode === 'split');
    sliderBtn.classList.toggle('active', state!.mode === 'slider');
  };
  // 切模式后窗格几何变了，重新 fit
  splitBtn.addEventListener('click', () => {
    if (state!.mode !== 'split') {
      state!.mode = 'split';
      state!.viewport = null;
      syncModeButtons();
      mountViewer(container, round);
    }
  });
  sliderBtn.addEventListener('click', () => {
    if (state!.mode !== 'slider') {
      state!.mode = 'slider';
      state!.viewport = null;
      syncModeButtons();
      mountViewer(container, round);
    }
  });
  syncModeButtons();
  modes.append(splitBtn, sliderBtn);

  const candLabel = document.createElement('label');
  candLabel.className = 'viewer-cand';
  candLabel.textContent = '跑分图';
  const candSelect = document.createElement('select');
  for (const candidate of round.candidates) {
    const option = document.createElement('option');
    option.value = candidate.path;
    option.textContent = fileName(candidate.path);
    option.title = candidate.path;
    candSelect.append(option);
  }
  candSelect.value = state.candidatePath ?? '';
  candSelect.addEventListener('change', () => {
    state!.candidatePath = candSelect.value;
    scheduleDraw();
  });
  candLabel.append(candSelect);

  const hint = document.createElement('span');
  hint.className = 'viewer-hint';
  hint.textContent = '滚轮缩放 · 拖拽平移 · 双击复位';

  bar.append(title, modes, candLabel, hint);

  // ----- 画布区 -----
  const area = document.createElement('div');
  area.className = 'viewer-area';
  container.replaceChildren(bar, area);

  let refCanvas: HTMLCanvasElement;
  let candCanvas: HTMLCanvasElement | null = null; // 分屏模式的右栏画布
  let sliderCanvas: HTMLCanvasElement | null = null;
  let dividerEl: HTMLDivElement | null = null;

  if (state.mode === 'split') {
    const left = document.createElement('div');
    left.className = 'viewer-pane';
    const right = document.createElement('div');
    right.className = 'viewer-pane';
    refCanvas = document.createElement('canvas');
    candCanvas = document.createElement('canvas');
    const refTag = document.createElement('span');
    refTag.className = 'viewer-tag';
    refTag.textContent = '原图';
    const candTag = document.createElement('span');
    candTag.className = 'viewer-tag';
    candTag.textContent = '跑分图';
    left.append(refCanvas, refTag);
    right.append(candCanvas, candTag);
    area.className = 'viewer-area split';
    area.append(left, right);
  } else {
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
  }

  // ----- 重绘调度（rAF 节流：一帧内多次改动只画一次） -----
  let rafId = 0;
  function scheduleDraw(): void {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  // ----- 通用交互：滚轮缩放（光标锚点）+ 拖拽平移 + 双击复位 -----
  function attachPanZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = state;
      if (!st?.viewport) return;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      st.viewport = zoomAt(
        st.viewport,
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
      const st = state;
      if (st?.viewport) {
        st.viewport = panBy(st.viewport, e.clientX - lastX, e.clientY - lastY);
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
      if (state) state.viewport = null; // 复位 = 重新按窗格 fit
      scheduleDraw();
    });
  }
  attachPanZoom(refCanvas);
  if (candCanvas) attachPanZoom(candCanvas);

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
      state!.divider = Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width));
      dividerEl!.style.left = `${state!.divider * rect.width}px`;
      scheduleDraw();
    });
    const stopDrag = (): void => { dragging = false; };
    dividerEl.addEventListener('pointerup', stopDrag);
    dividerEl.addEventListener('pointercancel', stopDrag);
  }

  // 窗格尺寸变化（拉伸窗口）：重设画布并重绘，视口保持不动
  const observer = new ResizeObserver(() => scheduleDraw());
  observer.observe(area);

  // 开始加载图片（缓存命中则立即就绪）
  const refEntry = ensureImage(round.referencePath, scheduleDraw);
  const candEntry = state.candidatePath ? ensureImage(state.candidatePath, scheduleDraw) : null;

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

  function drawImage(ctx: CanvasRenderingContext2D, size: Size, entry: ImageEntry): void {
    const vp = state!.viewport;
    if (!vp) return;
    const region = visibleRegion(vp, size, { width: entry.width, height: entry.height });
    if (!region) return;
    ctx.imageSmoothingEnabled = vp.zoom < NEAREST_ZOOM;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      entry.img!,
      region.src.x, region.src.y, region.src.width, region.src.height,
      region.dst.x, region.dst.y, region.dst.width, region.dst.height,
    );
  }

  /** 视口待适配时，用已就绪的图（优先原图）按窗格尺寸 fit。 */
  function ensureFitted(size: Size, first: ImageEntry | null | undefined): void {
    const st = state!;
    if (st.viewport || !first || first.status !== 'ok') return;
    st.viewport = fitViewport({ width: first.width, height: first.height }, size);
  }

  function draw(): void {
    const st = state;
    if (!st || !area.isConnected) return;
    if (st.mode === 'split') {
      const ctxA = prepare(refCanvas);
      const ctxB = candCanvas ? prepare(candCanvas) : null;
      if (!ctxA || !ctxB) return;
      ensureFitted(ctxA.size, refEntry.status === 'ok' ? refEntry : candEntry);
      // 两栏同尺寸，共用一次 fit；背景色让图片边界可辨
      for (const c of [ctxA.ctx, ctxB.ctx]) {
        c.fillStyle = '#2b2b2b';
        c.fillRect(0, 0, ctxA.size.width, ctxA.size.height);
      }
      drawPane(ctxA.ctx, ctxA.size, refEntry, '原图', round.referencePath);
      drawPane(ctxB.ctx, ctxB.size, candEntry, '跑分图', st.candidatePath ?? '');
    } else if (sliderCanvas) {
      const prepared = prepare(sliderCanvas);
      if (!prepared) return;
      const { ctx, size } = prepared;
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(0, 0, size.width, size.height);
      ensureFitted(size, refEntry.status === 'ok' ? refEntry : candEntry);

      if (!refEntry || refEntry.status !== 'ok') {
        drawPane(ctx, size, refEntry, '原图', round.referencePath);
      } else if (!candEntry || candEntry.status !== 'ok') {
        // 跑分图未就绪：先整幅显示原图
        drawImage(ctx, size, refEntry);
        drawPane(ctx, size, candEntry, '跑分图', st.candidatePath ?? '');
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
    }
  }

  scheduleDraw();
}
