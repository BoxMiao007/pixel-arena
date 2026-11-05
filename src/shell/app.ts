// 应用外壳装配：四区布局、区域挂载、折叠与分隔条、订阅重绘。
//
// 渲染是「分区式」的：每个区域自己维护 DOM 与增量子节点，状态变化只调 update()，
// 不做整页 replaceChildren（那样会丢焦点、打断拖拽、重挂查看器）。
//
// 本次改动的位置：在左右栏与舞台之间各加一条竖直分隔条，宽度可用鼠标拖拽、
// 方向键微调、双击复位；数值口径在 resize.ts（纯函数、可单测），
// 这里只负责 DOM、事件绑定、写 CSS 变量与持久化。

import { subscribe } from '../core/store';
import { getPref, setPref } from '../core/ui-state';
import { el } from '../ui/dom';
import { mountTitlebar } from './titlebar';
import { mountRail } from './rail';
import { mountWorkbar } from './workbar';
import { mountDock, mountInspector, mountStage } from './regions';
import { setRenderHook, shellState } from './controller';
import { installShortcuts } from './shortcuts';
import { startFileDrop } from './file-drop';
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  dragSidebarWidth,
  keyboardSidebarWidth,
  sidebarRange,
  type SidebarSide,
} from './resize';

/** 单个区域渲染失败只记录并跳过，不打断整次重绘。 */
function renderRegion(name: string, render: () => void): void {
  try {
    render();
  } catch (err) {
    console.error(`${name}渲染失败:`, err);
  }
}

const DOCK_MIN = 140;
const DOCK_MAX = 560;
const DOCK_MAX_RATIO = 0.72;

/** 从界面偏好恢复折叠态与栏宽（设置加载后再调一次，保证「不记录状态」时用默认值）。 */
export function reloadShellPrefs(): void {
  shellState.railCollapsed = getPref('railCollapsed');
  shellState.inspectorCollapsed = getPref('inspectorCollapsed');
  shellState.dockCollapsed = getPref('dockCollapsed');
  applyDockHeight(getPref('dockHeight'));
  applySidebarPref('rail');
  applySidebarPref('inspector');
}

let appRoot: HTMLElement | null = null;

/** 两条侧栏分隔条所在栏与分隔条元素；bootApp 装配后赋值，偏好恢复与窗口 resize 复用。 */
interface SidebarElements {
  host: HTMLElement;
  resizer: HTMLElement;
}

let sidebarRefs: Record<SidebarSide, SidebarElements> | null = null;

const SIDEBAR_PREFS: Record<SidebarSide, { prop: string; pref: 'railWidth' | 'inspectorWidth' }> = {
  rail: { prop: '--rail-w', pref: 'railWidth' },
  inspector: { prop: '--inspector-w', pref: 'inspectorWidth' },
};

/** 当前渲染宽度：元素已在布局里就量实际值（含窄窗口 @media 的结果），否则退回默认值。 */
function currentSidebarWidth(side: SidebarSide): number {
  const measured = sidebarRefs?.[side].host.getBoundingClientRect().width ?? 0;
  return measured > 0 ? Math.round(measured) : defaultSidebarWidth(side, window.innerWidth);
}

function updateSidebarAria(side: SidebarSide, width: number): void {
  const resizer = sidebarRefs?.[side].resizer;
  if (!resizer) return;
  const range = sidebarRange(side, window.innerWidth);
  resizer.setAttribute('aria-valuemin', String(range.min));
  resizer.setAttribute('aria-valuemax', String(range.max));
  resizer.setAttribute('aria-valuenow', String(Math.round(width)));
}

/** 写内联宽度并同步 ARIA。persist 只在拖拽结束、键盘调整与双击复位时为 true。 */
function applySidebarWidth(side: SidebarSide, width: number, persist: boolean): void {
  if (!appRoot) return;
  const clamped = clampSidebarWidth(side, width, window.innerWidth);
  appRoot.style.setProperty(SIDEBAR_PREFS[side].prop, `${clamped}px`);
  updateSidebarAria(side, clamped);
  if (persist) setPref(SIDEBAR_PREFS[side].pref, clamped);
}

/**
 * 没手动调过（偏好为 null）时移除内联宽度，把宽度交回 CSS 默认值与窄窗口 @media，
 * 否则窗口变窄时会被一个写死的 208 / 328 顶住；同时按实际布局刷新 ARIA 数值。
 */
function restoreSidebarWidth(side: SidebarSide): void {
  if (!appRoot) return;
  appRoot.style.removeProperty(SIDEBAR_PREFS[side].prop);
  updateSidebarAria(side, currentSidebarWidth(side));
}

function applySidebarPref(side: SidebarSide): void {
  const width = getPref(SIDEBAR_PREFS[side].pref);
  if (typeof width === 'number') applySidebarWidth(side, width, false);
  else restoreSidebarWidth(side);
}

function applyDockHeight(height: number): void {
  const clamped = Math.round(
    Math.max(DOCK_MIN, Math.min(height, DOCK_MAX, window.innerHeight * DOCK_MAX_RATIO)),
  );
  appRoot?.style.setProperty('--dock-h', `${clamped}px`);
}

/** 装配外壳并开始订阅状态。root 为 index.html 的 #app。 */
export function bootApp(root: HTMLElement): void {
  appRoot = el('div', { class: 'app' });
  root.replaceChildren(appRoot);

  const titlebarHost = el('div', { class: 'titlebar-host' });
  const railHost = el('aside', { class: 'rail', attrs: { 'aria-label': '跑分组' } });
  const workbarHost = el('div', { class: 'workbar' });
  const stageHost = el('section', { class: 'stage', attrs: { 'aria-label': '对比舞台' } });
  const dockResizer = el('div', {
    class: 'dock-resizer',
    attrs: {
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': '调整结果坞高度（方向键）',
      'aria-valuemin': String(DOCK_MIN),
      'aria-valuemax': String(Math.round(window.innerHeight * DOCK_MAX_RATIO)),
      tabindex: '0',
    },
  });
  const dockHost = el('section', { class: 'dock', attrs: { 'aria-label': '结果' } });
  const inspectorHost = el('aside', { class: 'inspector', attrs: { 'aria-label': '检视器' } });

  // 竖直分隔条：与结果坞分隔条同一套 ARIA 写法（有 aria-valuenow 才是可调分隔条，
  // 读屏才会念出当前宽度）。具体数值在 reloadShellPrefs / 交互时刷新。
  const createSidebarResizer = (side: SidebarSide, className: string, label: string): HTMLElement => {
    const range = sidebarRange(side, window.innerWidth);
    return el('div', {
      class: className,
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': label,
        'aria-valuemin': String(range.min),
        'aria-valuemax': String(range.max),
        'aria-valuenow': String(defaultSidebarWidth(side, window.innerWidth)),
        tabindex: '0',
      },
    });
  };
  const railResizer = createSidebarResizer('rail', 'rail-resizer', '调整左栏宽度（方向键）');
  const inspectorResizer = createSidebarResizer(
    'inspector',
    'inspector-resizer',
    '调整检视器宽度（方向键）',
  );

  // 全应用没有 h1：补一个视觉隐藏的应用标题，供读屏与文档大纲定位。
  // 样式层归样式负责人维护，这里用内联隐藏样式，避免为了一个工具类跨文件协调。
  const appTitle = el('h1', {
    text: '像素竞技场',
    style: {
      position: 'absolute',
      width: '1px',
      height: '1px',
      margin: '-1px',
      padding: '0',
      overflow: 'hidden',
      'clip-path': 'inset(50%)',
      'white-space': 'nowrap',
      border: '0',
    },
  });

  const workspaceHost = el(
    'main',
    { class: 'workspace' },
    appTitle,
    workbarHost,
    stageHost,
    dockResizer,
    dockHost,
  );

  // 列顺序与 shell.css 的 grid-template-columns 一致：左栏 / 左分隔条 / 工作区 / 右分隔条 / 右栏
  appRoot.append(
    titlebarHost,
    el(
      'div',
      { class: 'body' },
      railHost,
      railResizer,
      workspaceHost,
      inspectorResizer,
      inspectorHost,
    ),
  );

  const refs = {
    rail: { host: railHost, resizer: railResizer },
    inspector: { host: inspectorHost, resizer: inspectorResizer },
  } as const;
  sidebarRefs = refs;

  const titlebar = mountTitlebar(titlebarHost);
  const rail = mountRail(railHost);
  const workbar = mountWorkbar(workbarHost);
  const stage = mountStage(stageHost);
  const inspector = mountInspector(inspectorHost);
  const dock = mountDock(dockHost);

  // 折叠不等于消失：坞收成一条页签栏，点页签或头栏即可再展开，不必绕到工作栏图标。
  // 只有沉浸模式才把坞整块隐藏（沉浸的语义就是「只看画面」）。
  const applyDockCollapse = (): void => {
    dockHost.hidden = shellState.immersive;
    dockResizer.hidden = shellState.dockCollapsed || shellState.immersive;
  };

  /** 栏折叠或沉浸时分隔条一起隐藏（否则会留下一条 5px 的空白命中带）。 */
  const applySidebarCollapse = (side: SidebarSide, hidden: boolean): void => {
    const resizer = refs[side].resizer;
    if (resizer.hidden === hidden) return;
    resizer.hidden = hidden;
    // 重新可见时按当前布局刷新 ARIA：折叠期间窗口可能变窄，CSS 默认值已经不同。
    if (!hidden) updateSidebarAria(side, currentSidebarWidth(side));
  };

  const render = (): void => {
    appRoot!.classList.toggle('is-rail-collapsed', shellState.railCollapsed);
    appRoot!.classList.toggle('is-inspector-collapsed', shellState.inspectorCollapsed);
    appRoot!.classList.toggle('is-immersive', shellState.immersive);
    appRoot!.classList.toggle(
      'is-dock-collapsed',
      shellState.dockCollapsed || shellState.immersive,
    );
    const railHidden = shellState.railCollapsed || shellState.immersive;
    const inspectorHidden = shellState.inspectorCollapsed || shellState.immersive;
    railHost.hidden = railHidden;
    inspectorHost.hidden = inspectorHidden;
    applySidebarCollapse('rail', railHidden);
    applySidebarCollapse('inspector', inspectorHidden);
    applyDockCollapse();

    renderRegion('顶栏', () => titlebar.update());
    renderRegion('左栏', () => rail.update());
    renderRegion('工作栏', () => workbar.update());
    renderRegion('舞台', () => stage.update());
    renderRegion('检视器', () => inspector.update());
    renderRegion('结果坞', () => dock.update());

  };

  // 拖拽分隔条调整结果坞高度
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  const currentDockHeight = (): number => {
    const value = Number.parseFloat(
      appRoot!.style.getPropertyValue('--dock-h') || String(getPref('dockHeight')),
    );
    return Number.isFinite(value) ? value : 232;
  };

  const setDockHeight = (height: number, persist: boolean): void => {
    applyDockHeight(height);
    dockResizer.setAttribute(
      'aria-valuenow',
      String(
        Math.round(Math.max(DOCK_MIN, Math.min(height, DOCK_MAX, window.innerHeight * DOCK_MAX_RATIO))),
      ),
    );
    if (persist) setPref('dockHeight', Math.round(height));
  };

  dockResizer.addEventListener('pointerdown', (event) => {
    if (shellState.dockCollapsed) return;
    dragging = true;
    startY = event.clientY;
    startHeight = currentDockHeight();
    dockResizer.setPointerCapture(event.pointerId);
    appRoot!.classList.add('is-resizing');
    event.preventDefault();
  });
  dockResizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    setDockHeight(startHeight - (event.clientY - startY), false);
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    appRoot!.classList.remove('is-resizing');
    setDockHeight(currentDockHeight(), true);
  };
  dockResizer.addEventListener('pointerup', endDrag);
  dockResizer.addEventListener('pointercancel', endDrag);
  dockResizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setDockHeight(currentDockHeight() + step, true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDockHeight(currentDockHeight() - step, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setDockHeight(DOCK_MIN, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      setDockHeight(window.innerHeight * DOCK_MAX_RATIO, true);
    }
  });

  // ---------- 左右栏宽度：拖拽 / 键盘 / 双击复位 ----------
  //
  // 三条约束决定了写法：
  // 1. 分隔条跟着指针走，所以拖拽期间不落盘（每帧写 localStorage 既慢又无意义），
  //    只在 pointerup / pointercancel 时持久化一次；
  // 2. 「只点一下没拖」不算手动调过：保持偏好为 null，窄窗口 @media 继续生效；
  // 3. 窗口 resize 时按偏好重新夹取（检视器要守 50% 上限），拖拽中的一侧跳过，
  //    免得松手前的指针位置和刚夹好的宽度互相打架。
  let draggingSide: SidebarSide | null = null;
  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragMoved = false;

  const startSidebarDrag = (side: SidebarSide, event: PointerEvent): void => {
    if (appRoot === null) return;
    draggingSide = side;
    dragMoved = false;
    dragStartX = event.clientX;
    dragStartWidth = currentSidebarWidth(side);
    const { resizer } = refs[side];
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('is-dragging');
    appRoot.classList.add('is-resizing-col');
    event.preventDefault();
  };

  const moveSidebarDrag = (side: SidebarSide, event: PointerEvent): void => {
    if (draggingSide !== side) return;
    const deltaX = event.clientX - dragStartX;
    if (deltaX === 0) return;
    dragMoved = true;
    applySidebarWidth(side, dragSidebarWidth(side, dragStartWidth, deltaX, window.innerWidth), false);
  };

  const endSidebarDrag = (side: SidebarSide): void => {
    if (draggingSide !== side) return;
    refs[side].resizer.classList.remove('is-dragging');
    appRoot!.classList.remove('is-resizing-col');
    if (dragMoved) setPref(SIDEBAR_PREFS[side].pref, currentSidebarWidth(side));
    draggingSide = null;
    dragMoved = false;
  };

  for (const side of ['rail', 'inspector'] as const) {
    const { resizer } = refs[side];
    resizer.addEventListener('pointerdown', (event) => startSidebarDrag(side, event));
    resizer.addEventListener('pointermove', (event) => moveSidebarDrag(side, event));
    resizer.addEventListener('pointerup', () => endSidebarDrag(side));
    resizer.addEventListener('pointercancel', () => endSidebarDrag(side));
    resizer.addEventListener('dblclick', () => {
      // 恢复默认时同样按当前窗口夹取：窄窗下 328 也不能越过 50% 上限
      applySidebarWidth(side, defaultSidebarWidth(side, window.innerWidth), true);
    });
    resizer.addEventListener('keydown', (event) => {
      const next = keyboardSidebarWidth(
        side,
        currentSidebarWidth(side),
        event.key,
        event.shiftKey,
        window.innerWidth,
      );
      if (next === null) return;
      event.preventDefault();
      applySidebarWidth(side, next, true);
    });
  }

  setRenderHook(render);
  installShortcuts();
  startFileDrop();
  reloadShellPrefs();
  render();
  subscribe(() => render());

  // 窗口尺寸变化：结果坞高度按比例收进合法区间，栏宽重新夹取
  window.addEventListener('resize', () => {
    setDockHeight(currentDockHeight(), false);
    for (const side of ['rail', 'inspector'] as const) {
      if (draggingSide === side) continue;
      applySidebarPref(side);
    }
  });
  // 供调试与自动化截图判断应用已就绪
  document.documentElement.dataset.app = 'ready';
}
