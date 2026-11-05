// 三个内容区（舞台 / 检视器 / 结果坞）的挂载与更新。
//
// 统一规则：分组或轮次变化时销毁并重新 mount；其余状态变化只调 update()。
// 这样拖拽、输入焦点、媒体播放、视口缩放都不会被一次状态通知打断。

import { getState } from '../core/store';
import { activeRound, type GroupKind } from '../core/model';
import { el } from '../ui/dom';
import { button, emptyState, iconButton } from '../ui/primitives';
import { createGroup, createRound } from '../core/actions';
import {
  dockTabsFor,
  panelSectionsFor,
  stageViewFor,
  type DockTab,
  type MountedView,
  type PanelSection,
  type ViewCtx,
} from './registry';
import { setDockTab, setPanelCollapsed, shellState } from './controller';

export interface RegionHandle {
  update(): void;
}

function safeUpdate(handle: MountedView, region: string): void {
  try {
    handle.update();
  } catch (err) {
    console.error(`${region} update 失败:`, err);
  }
}

function emptyStage(): HTMLElement {
  const state = getState();
  const workspace = state.workspace;
  if (!workspace || workspace.groups.length === 0) {
    return emptyState({
      title: '还没有跑分组',
      hint: '先新建一个跑分组，再把原图和跑分图拖进来。',
      icon: 'compare',
      actions: [
        button({ label: '新建图片跑分组', variant: 'primary', onClick: () => void createGroup('image') }),
        button({ label: '新建视频跑分组', onClick: () => void createGroup('video') }),
      ],
      className: 'stage__empty',
    });
  }
  const session = activeRound(workspace);
  const group = workspace.groups.find((item) => item.id === workspace.activeGroupId);
  if (!session && group) {
    return emptyState({
      title: `${group.name} 里还没有评测轮`,
      icon: 'plus',
      actions: [
        button({ label: '新建评测轮', variant: 'primary', onClick: () => void createRound(group) }),
      ],
      className: 'stage__empty',
    });
  }
  return emptyState({ title: '选择一轮评测', className: 'stage__empty' });
}

/** 舞台：图片组挂对比查看器，视频组挂视频对比。 */
export function mountStage(host: HTMLElement): RegionHandle {
  let state: { key: string; handle: MountedView } | null = null;

  const destroy = (): void => {
    state?.handle.destroy();
    state = null;
  };

  const update = (): void => {
    const session = activeRound(getState().workspace);
    if (!session) {
      destroy();
      host.replaceChildren(emptyStage());
      return;
    }
    const view = stageViewFor(session.group.kind);
    if (!view) {
      destroy();
      host.replaceChildren(
        emptyState({
          title: '这个分组类型还没有舞台视图',
          hint: '图片组挂对比查看器，视频组挂视频对比。',
        }),
      );
      return;
    }
    const key = `${view.id}:${session.group.id}:${session.round.id}`;
    if (state?.key !== key) {
      destroy();
      const mountHost = el('div', { class: 'stage__view' });
      host.replaceChildren(mountHost);
      try {
        state = { key, handle: view.mount(mountHost, session) };
      } catch (err) {
        console.error('舞台挂载失败:', err);
        host.replaceChildren(
          emptyState({
            title: '舞台加载失败',
            hint: err instanceof Error ? err.message : String(err),
            icon: 'alert',
          }),
        );
        state = null;
        return;
      }
    }
    safeUpdate(state.handle, '舞台');
  };

  update();
  return { update };
}

/** 检视器：按组类型挂注册的分区，顺序由 order 决定。 */
export function mountInspector(host: HTMLElement): RegionHandle {
  let state: {
    key: string;
    items: { section: PanelSection; handle: MountedView }[];
  } | null = null;

  const destroy = (): void => {
    if (!state) return;
    for (const item of state.items) item.handle.destroy();
    state = null;
  };

  const update = (): void => {
    const session = activeRound(getState().workspace);
    if (!session) {
      destroy();
      // 无轮次有两种原因：没有跑分组，或组里轮次被删光。占位文案要跟着说准，
      // 否则上方舞台说「还没有评测轮」、这里却说「还没有跑分组」。
      const workspace = getState().workspace;
      const hasGroups = (workspace?.groups.length ?? 0) > 0;
      host.replaceChildren(
        el(
          'div',
          { class: 'inspector__placeholder' },
          hasGroups ? '还没有评测轮。' : '还没有跑分组。',
        ),
      );
      return;
    }
    const sections = panelSectionsFor(session.group.kind);
    const key = `${session.group.kind}:${session.group.id}:${session.round.id}:${sections
      .map((section) => section.id)
      .join(',')}`;
    if (state?.key !== key) {
      destroy();
      host.replaceChildren();
      const items: { section: PanelSection; handle: MountedView }[] = [];
      for (const section of sections) {
        const sectionHost = el('div', {
          class: 'inspector__section',
          dataset: { sectionId: section.id },
        });
        host.appendChild(sectionHost);
        items.push({ section, handle: section.mount(sectionHost, session) });
      }
      state = { key, items };
      if (sections.length === 0) {
        host.replaceChildren(
          el('div', { class: 'inspector__placeholder' }, '这个分组没有可用的检视器分区。'),
        );
      }
      return;
    }
    for (const item of state.items) safeUpdate(item.handle, `检视器/${item.section.id}`);
  };

  update();
  return { update };
}

/** 折叠态仍留一条页签栏：这两个文案说明下一步是展开还是收起。 */
const DOCK_EXPANDED_LABEL = '收起结果坞（Ctrl+J）';
const DOCK_COLLAPSED_LABEL = '展开结果坞（Ctrl+J）';

/**
 * 页签可以往页签行右侧带自己的按钮（现在只有评分表用它放「选择显示的列」）。
 * 这是挂载句柄上的可选扩展，不写进 registry 的必选契约：没实现的页签
 * （如视频指标）就什么都不显示。按钮与页签同生命周期，切换/销毁一起收。
 */
interface DockActionsView extends MountedView {
  mountDockActions?(host: HTMLElement): MountedView;
}

/** 结果坞：页签 + 可折叠，内容按「轮 × 页签」挂载。 */
export function mountDock(host: HTMLElement): RegionHandle {
  let state: { key: string; tabId: string; handle: MountedView } | null = null;
  let actions: MountedView | null = null;

  const tabsBar = el('div', { class: 'dock__tabs', attrs: { role: 'tablist', 'aria-label': '结果视图' } });
  // 页签自己的头栏按钮落在这里（折叠按钮固定在它右边，位置不随页签变）。
  const tabActions = el('div', { class: 'dock__tab-actions' });
  const collapse = iconButton({
    label: DOCK_EXPANDED_LABEL,
    icon: 'chevronDown',
    variant: 'quiet',
    onClick: (event) => {
      // 折叠条整条可点展开；这个按钮自己切换方向，别让冒泡把它又展开回来
      event.stopPropagation();
      setPanelCollapsed('dock', !shellState.dockCollapsed);
    },
  });
  collapse.classList.add('dock__collapse');
  const content = el('div', { class: 'dock__content' });
  const head = el(
    'div',
    { class: 'dock__head' },
    tabsBar,
    el('div', { class: 'dock__actions' }, tabActions, collapse),
  );
  // 折叠态下头栏本身就是展开入口：点页签会顺带展开并切到那页
  head.addEventListener('click', (event) => {
    if (!shellState.dockCollapsed) return;
    if ((event.target as HTMLElement).closest('.dock__collapse')) return;
    setPanelCollapsed('dock', false);
  });
  // 同一个入口补键盘：只在折叠态生效，且只在头栏自己被聚焦时响应
  // （页签、折叠按钮自己的 Enter/Space 不抢）。展开态头栏只是布局容器，
  // 不带 role/tabindex，避免把含页签按钮的容器声明成 button。
  head.addEventListener('keydown', (event) => {
    if (!shellState.dockCollapsed) return;
    if (event.target !== head) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setPanelCollapsed('dock', false);
  });
  host.append(head, content);

  const destroy = (): void => {
    state?.handle.destroy();
    state = null;
    actions?.destroy();
    actions = null;
    // 兜底：页签的 destroy 应已清空，这里再收一次，避免残留一个点不动的按钮。
    tabActions.replaceChildren();
  };

  const tabButton = (tab: DockTab, active: string, ctx: ViewCtx): HTMLElement => {
    const isActive = tab.id === active;
    const count = tab.id === 'results' ? countBadge(ctx) : null;
    return el(
      'button',
      {
        class: `dock__tab${isActive ? ' is-active' : ''}`,
        attrs: {
          type: 'button',
          role: 'tab',
          'aria-selected': String(isActive),
          'aria-controls': 'dock-content',
          tabindex: isActive ? '0' : '-1',
        },
        dataset: { tabId: tab.id },
        on: {
          click: () => setDockTab(tab.id),
          keydown: (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const tabs = tabsBar.querySelectorAll<HTMLElement>('.dock__tab');
            const index = [...tabs].indexOf(event.currentTarget as HTMLElement);
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            next?.focus();
            next?.click();
          },
        },
      },
      tab.label,
      count,
    );
  };

  content.id = 'dock-content';

  const syncCollapseControl = (): void => {
    const collapsed = shellState.dockCollapsed;
    const label = collapsed ? DOCK_COLLAPSED_LABEL : DOCK_EXPANDED_LABEL;
    collapse.title = label;
    collapse.setAttribute('aria-label', label);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    // 只有折叠态整条头栏才是「展开」按钮（CSS 也只在折叠态给它 pointer 光标）。
    if (collapsed) {
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-label', DOCK_COLLAPSED_LABEL);
      head.setAttribute('aria-expanded', 'false');
    } else {
      for (const name of ['role', 'tabindex', 'aria-label', 'aria-expanded']) {
        head.removeAttribute(name);
      }
    }
  };

  const update = (): void => {
    syncCollapseControl();
    const session = activeRound(getState().workspace);
    if (!session) {
      destroy();
      tabsBar.replaceChildren();
      content.replaceChildren(
        emptyState({
          title: '还没有可展示的结果',
          hint: '跑分后指标表会出现在这里。',
        }),
      );
      return;
    }
    const tabs = dockTabsFor(session.group.kind);
    if (tabs.length === 0) {
      destroy();
      tabsBar.replaceChildren();
      content.replaceChildren(
        el('div', { class: 'inspector__placeholder' }, '这个分组类型没有结果视图。'),
      );
      return;
    }
    // 用户点过的页签优先；否则按组类型给默认页（视频组首看视频指标）
    const preferred = session.group.kind === 'video' ? 'video-metrics' : 'results';
    const active = tabs.some((tab) => tab.id === shellState.dockTab)
      ? shellState.dockTab
      : tabs.some((tab) => tab.id === preferred)
        ? preferred
        : tabs[0].id;

    tabsBar.replaceChildren(
      ...tabs.map((tab) => tabButton(tab, active, { group: session.group, round: session.round })),
    );

    const key = `${session.group.kind}:${session.group.id}:${session.round.id}:${active}`;
    if (state?.key !== key) {
      destroy();
      content.replaceChildren();
      const tab = tabs.find((item) => item.id === active) ?? tabs[0];
      const mountHost = el('div', { class: 'dock__view' });
      content.appendChild(mountHost);
      const handle = tab.mount(mountHost, session);
      state = { key, tabId: tab.id, handle };
      // 页签若自带页签行按钮，跟着这次挂载一起上；destroy() 会一并收掉。
      const withActions = handle as DockActionsView;
      if (typeof withActions.mountDockActions === 'function') {
        actions = withActions.mountDockActions(tabActions);
      }
    }
    safeUpdate(state.handle, `结果坞/${state.tabId}`);
  };

  update();
  return { update };
}

/** 结果坞页签计数：跑分图张数（0 时不显示）。 */
function countBadge(ctx: ViewCtx): HTMLElement | null {
  const count = ctx.round.candidates.length;
  if (count === 0) return null;
  return el('span', { class: 'dock__tab-count', text: String(count) });
}

/** 供其它域按需触发的「切到某页签后打开」。 */
export function focusDockTab(id: string): void {
  setPanelCollapsed('dock', false);
  setDockTab(id);
}

/** 组类型对应的图标名（左栏与顶栏共用）。 */
export function kindIcon(kind: GroupKind): 'image' | 'film' {
  return kind === 'video' ? 'film' : 'image';
}
