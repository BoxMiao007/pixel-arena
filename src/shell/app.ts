// 应用外壳装配：四区布局、区域挂载、折叠与分隔条、订阅重绘。
//
// 渲染是「分区式」的：每个区域自己维护 DOM 与增量子节点，状态变化只调 update()，
// 不做整页 replaceChildren（那样会丢焦点、打断拖拽、重挂查看器）。

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

/** 从界面偏好恢复折叠态（设置加载后再调一次，保证「不记录状态」时用默认值）。 */
export function reloadShellPrefs(): void {
  shellState.railCollapsed = getPref('railCollapsed');
  shellState.inspectorCollapsed = getPref('inspectorCollapsed');
  shellState.dockCollapsed = getPref('dockCollapsed');
  applyDockHeight(getPref('dockHeight'));
}

let appRoot: HTMLElement | null = null;

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

  const workspaceHost = el(
    'main',
    { class: 'workspace' },
    workbarHost,
    stageHost,
    dockResizer,
    dockHost,
  );

  appRoot.append(
    titlebarHost,
    el('div', { class: 'body' }, railHost, workspaceHost, inspectorHost),
  );

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

  const render = (): void => {
    appRoot!.classList.toggle('is-rail-collapsed', shellState.railCollapsed);
    appRoot!.classList.toggle('is-inspector-collapsed', shellState.inspectorCollapsed);
    appRoot!.classList.toggle('is-immersive', shellState.immersive);
    appRoot!.classList.toggle(
      'is-dock-collapsed',
      shellState.dockCollapsed || shellState.immersive,
    );
    railHost.hidden = shellState.railCollapsed || shellState.immersive;
    inspectorHost.hidden = shellState.inspectorCollapsed || shellState.immersive;
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

  setRenderHook(render);
  installShortcuts();
  startFileDrop();
  reloadShellPrefs();
  render();
  subscribe(() => render());

  // 窗口尺寸变化：结果坞高度按比例收进合法区间
  window.addEventListener('resize', () => {
    setDockHeight(currentDockHeight(), false);
  });
  // 供调试与自动化截图判断应用已就绪
  document.documentElement.dataset.app = 'ready';
}
