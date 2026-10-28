// 外壳的界面开关（栏折叠、沉浸模式、结果坞页签）。
//
// 单独一个模块是为了避免「外壳 -> 各栏 -> 外壳」的循环依赖：各栏只读这里的开关状态、
// 调这里的动作，真正重绘由 app.ts 注册的 requestRender 执行。

import { getPref, setPref } from '../core/ui-state';

export type PanelId = 'rail' | 'inspector' | 'dock';

export interface ShellState {
  railCollapsed: boolean;
  inspectorCollapsed: boolean;
  dockCollapsed: boolean;
  immersive: boolean;
  /** 当前结果坞页签 id（按组类型各自记一份，切换组类型时不串）。 */
  dockTab: string;
}

export const shellState: ShellState = {
  railCollapsed: getPref('railCollapsed'),
  inspectorCollapsed: getPref('inspectorCollapsed'),
  dockCollapsed: getPref('dockCollapsed'),
  immersive: false,
  dockTab: '',
};

let renderFn: () => void = () => {};

/** app.ts 在装配完成后注册真正的重绘函数。 */
export function setRenderHook(fn: () => void): void {
  renderFn = fn;
}

export function requestRender(): void {
  renderFn();
}

export function isPanelCollapsed(panel: PanelId): boolean {
  if (panel === 'rail') return shellState.railCollapsed;
  if (panel === 'inspector') return shellState.inspectorCollapsed;
  return shellState.dockCollapsed;
}

export function togglePanel(panel: PanelId): void {
  if (panel === 'rail') {
    shellState.railCollapsed = !shellState.railCollapsed;
    setPref('railCollapsed', shellState.railCollapsed);
  } else if (panel === 'inspector') {
    shellState.inspectorCollapsed = !shellState.inspectorCollapsed;
    setPref('inspectorCollapsed', shellState.inspectorCollapsed);
  } else {
    shellState.dockCollapsed = !shellState.dockCollapsed;
    setPref('dockCollapsed', shellState.dockCollapsed);
  }
  // 展开任一栏时退出沉浸模式，避免出现「看不见的已展开栏」。
  shellState.immersive = false;
  requestRender();
}

export function setPanelCollapsed(panel: PanelId, collapsed: boolean): void {
  if (isPanelCollapsed(panel) === collapsed) return;
  togglePanel(panel);
}

export function toggleImmersive(): void {
  shellState.immersive = !shellState.immersive;
  requestRender();
}

export function exitImmersive(): boolean {
  if (!shellState.immersive) return false;
  shellState.immersive = false;
  requestRender();
  return true;
}

export function setDockTab(id: string): void {
  if (shellState.dockTab === id) return;
  shellState.dockTab = id;
  requestRender();
}
