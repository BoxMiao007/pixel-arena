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
      hint: '一个跑分组是一间独立的评测室。新建一个，把原图和已压好的跑分图拖进来，或让工具自动压一套编码阶梯。',
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
      hint: '每个评测轮是一组独立的对比：一张原图对若干张跑分图。',
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
      host.replaceChildren(
        el('div', { class: 'inspector__placeholder' }, '新建跑分组后，这里会出现选图与跑分操作。'),
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

/** 结果坞：页签 + 可折叠，内容按「轮 × 页签」挂载。 */
export function mountDock(host: HTMLElement): RegionHandle {
  let state: { key: string; tabId: string; handle: MountedView } | null = null;

  const tabsBar = el('div', { class: 'dock__tabs', attrs: { role: 'tablist', 'aria-label': '结果视图' } });
  const collapse = iconButton({
    label: '收起结果坞（Ctrl+J）',
    icon: 'chevronDown',
    variant: 'quiet',
    onClick: () => setPanelCollapsed('dock', true),
  });
  const content = el('div', { class: 'dock__content' });
  const head = el(
    'div',
    { class: 'dock__head' },
    tabsBar,
    el('div', { class: 'dock__actions' }, collapse),
  );
  host.append(head, content);

  const destroy = (): void => {
    state?.handle.destroy();
    state = null;
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

  const update = (): void => {
    const session = activeRound(getState().workspace);
    if (!session) {
      destroy();
      tabsBar.replaceChildren();
      content.replaceChildren(
        emptyState({
          title: '还没有可展示的结果',
          hint: '选好原图与跑分图后跑一次分，指标表会出现在这里。',
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
      state = { key, tabId: tab.id, handle: tab.mount(mountHost, session) };
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
