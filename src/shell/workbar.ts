// 工作栏：当前分组的评测轮切换、新建轮、导出与三栏开关。
//
// 轮次 chip 单击切换、双击就地改名、右键菜单（重命名 / 删除，删除有内容时会确认）。

import { getState, isBusy, setStatus } from '../core/store';
import {
  activateRound,
  createRound,
  deleteRound,
  renameRound,
} from '../core/actions';
import type { Group, Round } from '../core/model';
import { el } from '../ui/dom';
import { button, iconButton } from '../ui/primitives';
import { openMenu } from '../ui/overlay';
import {
  isPanelCollapsed,
  shellState,
  toggleImmersive,
  togglePanel,
} from './controller';
import { runCommand } from './registry';

export interface WorkbarHandle {
  update(): void;
}

let editingId: string | null = null;
let lastKey = '';

function roundsSignature(group: Group): string {
  return [
    group.id,
    group.activeRoundId ?? '',
    editingId ?? '',
    ...group.rounds.map((round) => `${round.id}:${round.name}`),
  ].join('|');
}

function beginRename(item: HTMLElement, group: Group, round: Round): void {
  if (isBusy()) {
    setStatus('有任务正在进行，结束再改名');
    return;
  }
  if (item.querySelector('.round-chip__rename')) return;
  const nameNode = item.querySelector<HTMLElement>('.round-chip__name');
  if (!nameNode) return;
  editingId = round.id;
  const input = el('input', {
    class: 'round-chip__rename input',
    // 就地改名是临时输入，关掉自动补全与拼写检查。
    attrs: {
      type: 'text',
      maxlength: '60',
      'aria-label': '评测轮名称',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  }) as HTMLInputElement;
  input.value = round.name;
  nameNode.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    editingId = null;
    const value = input.value.trim();
    if (commit && value.length > 0 && value !== round.name) {
      void renameRound(group, round, value);
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

function roundMenu(anchor: HTMLElement, group: Group, round: Round): void {
  openMenu(
    anchor,
    [
      {
        label: '重命名',
        disabled: isBusy(),
        onSelect: () => {
          const item = anchor.closest<HTMLElement>('.round-chip');
          if (item) beginRename(item, group, round);
        },
      },
      {
        label: '删除评测轮',
        danger: true,
        disabled: isBusy(),
        onSelect: () => void deleteRound(group, round),
      },
    ],
    { label: `${round.name} 的操作` },
  );
}

function roundChip(group: Group, round: Round, tabbable: boolean): HTMLElement {
  const active = group.activeRoundId === round.id;
  const chip = el('div', {
    class: `round-chip${active ? ' is-active' : ''}`,
    dataset: { roundId: round.id },
  });
  const main = el(
    'button',
    {
      class: 'round-chip__main',
      attrs: {
        type: 'button',
        // 容器是 tablist，每个轮次就是一张页签：补 role/aria-selected 与 roving tabindex，
        // 整个 tablist 只保留一个 Tab 停靠点，组内用左右方向键漫游（与结果坞页签一致）。
        role: 'tab',
        'aria-selected': String(active),
        tabindex: tabbable ? '0' : '-1',
        'aria-current': active ? 'true' : null,
        title: `${round.name}（双击改名，右键更多操作）`,
      },
      on: {
        click: () => void activateRound(group, round),
        dblclick: (event) => {
          event.preventDefault();
          beginRename(chip, group, round);
        },
        contextmenu: (event) => {
          event.preventDefault();
          roundMenu(chip, group, round);
        },
        keydown: (event) => {
          if (event.key === 'F2') {
            event.preventDefault();
            beginRename(chip, group, round);
            return;
          }
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          event.preventDefault();
          const tablist = chip.closest('.workbar__rounds');
          if (!tablist) return;
          const tabs = [...tablist.querySelectorAll<HTMLElement>('.round-chip__main')];
          const index = tabs.indexOf(event.currentTarget as HTMLElement);
          if (index < 0) return;
          const delta = event.key === 'ArrowRight' ? 1 : -1;
          const next = tabs[(index + delta + tabs.length) % tabs.length];
          // 焦点先落到目标页签再激活：激活会触发重绘，update() 里会把焦点接回来。
          next.focus();
          next.click();
        },
      },
    },
    el('span', { class: 'round-chip__name truncate', text: round.name }),
  );
  chip.append(main);
  return chip;
}

export function mountWorkbar(host: HTMLElement): WorkbarHandle {
  const roundsHost = el('div', {
    class: 'workbar__rounds',
    attrs: { role: 'tablist', 'aria-label': '评测轮' },
  });
  const label = el('span', { class: 'workbar__label', text: '评测轮' });
  const newRound = iconButton({
    label: '新建评测轮（Ctrl+N）',
    icon: 'plus',
    variant: 'bordered',
    onClick: () => {
      const workspace = getState().workspace;
      const group = workspace?.groups.find((item) => item.id === workspace.activeGroupId);
      if (group) void createRound(group);
    },
  });
  const exportBtn = button({
    label: '导出',
    icon: 'export',
    size: 'sm',
    variant: 'secondary',
    title: '导出本轮报告（Ctrl+E）',
    onClick: (event) =>
      void runCommand('export-menu', { anchor: event.currentTarget as HTMLElement }),
  });
  // 键盘入口（Ctrl+E）没有事件锚点：给结果域一个稳定的首选锚点
  exportBtn.dataset.exportAnchor = '';
  const inspectorToggle = iconButton({
    label: '折叠或展开检视器（Ctrl+I）',
    icon: 'panelRight',
    variant: 'quiet',
    onClick: () => togglePanel('inspector'),
  });
  const dockToggle = iconButton({
    label: '折叠或展开结果坞（Ctrl+J）',
    icon: 'panelBottom',
    variant: 'quiet',
    onClick: () => togglePanel('dock'),
  });
  const immersive = iconButton({
    label: '沉浸模式（F）',
    icon: 'expand',
    variant: 'quiet',
    onClick: () => toggleImmersive(),
  });

  const right = el(
    'div',
    { class: 'workbar__right' },
    exportBtn,
    el('span', { class: 'workbar__divider', attrs: { 'aria-hidden': 'true' } }),
    inspectorToggle,
    dockToggle,
    immersive,
  );
  host.append(
    el(
      'div',
      { class: 'workbar__inner' },
      el('div', { class: 'workbar__left' }, label, roundsHost, newRound),
      right,
    ),
  );

  const update = (): void => {
    const workspace = getState().workspace;
    const group = workspace?.groups.find((item) => item.id === workspace.activeGroupId) ?? null;
    const rounds = group?.rounds ?? [];
    const key = group ? roundsSignature(group) : '~none~';
    label.hidden = rounds.length === 0;

    if (key !== lastKey) {
      lastKey = key;
      // 切换轮次会重建 chip：先记下焦点是否还在轮次栏内，重建后把焦点还给新的选中页签，
      // 否则方向键漫游只生效一次（旧节点被替换，焦点掉回 body）。
      const focusWasInside = roundsHost.contains(document.activeElement);
      if (!group || rounds.length === 0) {
        roundsHost.replaceChildren(
          el('span', { class: 'workbar__empty', text: group ? '还没有评测轮' : '' }),
        );
      } else {
        // 没有激活轮次时也要留一个 Tab 停靠点，否则整个 tablist 键盘不可达。
        const activeExists = rounds.some((round) => round.id === group.activeRoundId);
        roundsHost.replaceChildren(
          ...rounds.map((round, index) =>
            roundChip(
              group,
              round,
              round.id === group.activeRoundId || (!activeExists && index === 0),
            ),
          ),
        );
        if (focusWasInside && editingId === null) {
          roundsHost
            .querySelector<HTMLElement>('.round-chip.is-active .round-chip__main')
            ?.focus();
        }
      }
    }

    const hasGroup = group !== null;
    const busy = isBusy();
    exportBtn.disabled = !hasGroup || busy;
    exportBtn.title = busy
      ? '有任务正在进行，结束后再导出（Ctrl+E）'
      : '导出本轮报告（Ctrl+E）';
    newRound.disabled = !hasGroup || busy;
    newRound.title = busy ? '有任务正在进行，结束后再新建' : '新建评测轮（Ctrl+N）';
    inspectorToggle.setAttribute('aria-pressed', String(!isPanelCollapsed('inspector')));
    dockToggle.setAttribute('aria-pressed', String(!isPanelCollapsed('dock')));
    immersive.setAttribute('aria-pressed', String(shellState.immersive));
  };

  update();
  return { update };
}
