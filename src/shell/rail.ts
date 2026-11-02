// 左栏：跑分组列表、新建入口、右键菜单与就地重命名。
//
// 只有分组集合、当前激活项、正在编辑的 id 变化时才重建列表；状态栏文案等高频变化
// 不会冲掉正在输入的重命名框。

import { getState, isBusy, setStatus } from '../core/store';
import { activateGroup, closeGroup, createGroup, renameGroup } from '../core/actions';
import type { Group } from '../core/model';
import { el } from '../ui/dom';
import { icon } from '../ui/icons';
import { button, iconButton } from '../ui/primitives';
import { openMenu } from '../ui/overlay';

export interface RailHandle {
  update(): void;
}

let editingId: string | null = null;

function groupSignature(groups: readonly Group[], activeId: string | null): string {
  return [
    activeId ?? '',
    isBusy() ? 'busy' : 'idle',
    editingId ?? '',
    ...groups.map((group) => `${group.id}:${group.kind}:${group.name}:${group.rounds.length}`),
  ].join('|');
}

function findItem(groupId: string): HTMLElement | null {
  for (const item of document.querySelectorAll<HTMLElement>('.rail__item')) {
    if (item.dataset.groupId === groupId) return item;
  }
  return null;
}

function beginRename(item: HTMLElement, group: Group): void {
  if (isBusy()) {
    setStatus('有任务正在进行，结束再改名');
    return;
  }
  if (item.querySelector('.rail__rename')) return;
  const nameNode = item.querySelector<HTMLElement>('.rail__name');
  if (!nameNode) return;
  editingId = group.id;
  const input = el('input', {
    class: 'rail__rename input',
    // 就地改名是临时输入，关掉自动补全与拼写检查（避免浏览器弹历史/红波浪线）。
    attrs: {
      type: 'text',
      maxlength: '60',
      'aria-label': '跑分组名称',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  }) as HTMLInputElement;
  input.value = group.name;
  nameNode.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    editingId = null;
    const value = input.value.trim();
    if (commit && value.length > 0 && value !== group.name) {
      void renameGroup(group, value);
    } else {
      input.replaceWith(nameNode);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function groupMenu(anchor: HTMLElement, group: Group): void {
  openMenu(
    anchor,
    [
      {
        label: '重命名',
        hint: isBusy() ? '跑分中' : 'F2',
        disabled: isBusy(),
        onSelect: () => {
          const item = findItem(group.id);
          if (item) beginRename(item, group);
        },
      },
      {
        label: '关闭跑分组',
        danger: true,
        disabled: isBusy(),
        onSelect: () => void closeGroup(group),
      },
    ],
    { label: `${group.name} 的操作` },
  );
}

function groupItem(group: Group, activeId: string | null): HTMLElement {
  const active = group.id === activeId;
  const item = el('div', {
    class: `rail__item${active ? ' is-active' : ''}`,
    dataset: { groupId: group.id },
  });

  const main = el(
    'button',
    {
      class: 'rail__main',
      attrs: {
        type: 'button',
        'aria-current': active ? 'true' : null,
        title: `${group.name}（${group.rounds.length} 个评测轮）`,
      },
      on: {
        click: () => void activateGroup(group),
        dblclick: (event) => {
          event.preventDefault();
          beginRename(item, group);
        },
        contextmenu: (event) => {
          event.preventDefault();
          groupMenu(item, group);
        },
        keydown: (event) => {
          if (event.key === 'F2') {
            event.preventDefault();
            beginRename(item, group);
          }
        },
      },
    },
    icon(group.kind === 'video' ? 'film' : 'image', 'icon rail__kind'),
    el(
      'span',
      { class: 'rail__body' },
      el('span', { class: 'rail__name truncate', text: group.name }),
      el('span', { class: 'rail__meta', text: `${group.rounds.length} 个评测轮` }),
    ),
  );

  const more = iconButton({
    label: `${group.name} 的操作`,
    icon: 'more',
    variant: 'quiet',
    onClick: () => groupMenu(item, group),
  });
  more.classList.add('rail__more');

  item.append(main, more);
  return item;
}

export function mountRail(host: HTMLElement): RailHandle {
  // 用真正的 <nav> 表达导航地标，role 不再由 div 模拟。
  const list = el('nav', {
    class: 'rail__list',
    attrs: { 'aria-label': '跑分组' },
  });
  const count = el('span', { class: 'rail__count' });

  const newGroup = button({
    label: '新建跑分组',
    icon: 'plus',
    variant: 'secondary',
    onClick: (event) => {
      openMenu(
        event.currentTarget as HTMLElement,
        [
          { label: '图片跑分组', onSelect: () => void createGroup('image') },
          { label: '视频跑分组', onSelect: () => void createGroup('video') },
        ],
        { align: 'start', label: '新建跑分组类型' },
      );
    },
  });
  newGroup.classList.add('rail__new');

  host.append(
    el(
      'div',
      { class: 'rail__inner' },
      el('div', { class: 'rail__head' }, el('span', { class: 'rail__title', text: '跑分组' }), count),
      list,
      el('div', { class: 'rail__foot' }, newGroup),
    ),
  );

  let lastKey = '';

  const draw = (): void => {
    const workspace = getState().workspace;
    const groups = workspace?.groups ?? [];
    const activeId = workspace?.activeGroupId ?? null;
    count.textContent = groups.length > 0 ? String(groups.length) : '';
    const busy = isBusy();
    newGroup.disabled = busy;
    newGroup.title = busy ? '有任务正在进行，结束再新建跑分组' : '新建跑分组';
    const key = groupSignature(groups, activeId);
    if (key === lastKey) return;
    lastKey = key;
    if (groups.length === 0) {
      list.replaceChildren(
        el('p', {
          class: 'rail__empty',
          text: '还没有跑分组。新建一个，把原图与跑分图放进来对比。',
        }),
      );
      return;
    }
    list.replaceChildren(...groups.map((group) => groupItem(group, activeId)));
  };

  draw();

  return { update: draw };
}
