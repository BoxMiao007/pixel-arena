// 顶部栏：品牌、当前分组/轮次、状态文本、FFmpeg 提醒、快捷键帮助与设置入口。
//
// 状态文本单行截断，点击弹出可复制的完整内容（长错误不会被挤成一团或撑高顶栏）。

import { getState, isBusy, setStatus } from '../core/store';
import { ffmpegReady, ffmpegReason } from '../core/ffmpeg';
import { activeRound } from '../core/model';
import { el } from '../ui/dom';
import { icon } from '../ui/icons';
import { badge, button, iconButton, spinner } from '../ui/primitives';
import { prompt } from '../ui/overlay';
import { renameGroup, renameRound } from '../core/actions';
import { openPopover } from '../ui/overlay';
import { copyText } from '../core/util';
import { toast } from '../ui/toast';
import { runCommand } from './registry';

export interface TitlebarHandle {
  update(): void;
}

/** 状态文本：单行截断；点击弹出全文与复制。 */
function statusNode(): HTMLElement {
  const status = getState().status;
  if (!status.text) {
    return el('span', { class: 'status-line status-line--empty' });
  }
  const node = el(
    'button',
    {
      class: 'status-line',
      attrs: {
        type: 'button',
        'aria-label': `状态：${status.text}`,
        title: '点击查看完整内容',
      },
    },
    status.isError ? icon('alert', 'icon status-line__icon') : null,
    el('span', {
      class: `status-line__text${status.isError ? ' is-error' : ''}`,
      text: status.text,
    }),
  );
  node.addEventListener('click', () => {
    const content = el(
      'div',
      { class: 'status-popover' },
      el('p', { class: 'status-popover__text', text: status.detail }),
      el(
        'div',
        { class: 'status-popover__actions' },
        button({
          label: '复制',
          size: 'sm',
          icon: 'copy',
          onClick: () => copyText(status.detail, () => toast('已复制到剪贴板', 'ok')),
        }),
      ),
    );
    openPopover(node, content, { align: 'end', label: '状态详情' });
  });
  return node;
}

export function mountTitlebar(host: HTMLElement): TitlebarHandle {
  /** 面包屑改名：双击或聚焦后 F2，弹命名框（与左栏/轮次栏同一套动作）。 */
  const renameWithPrompt = async (kind: 'group' | 'round'): Promise<void> => {
    const session = activeRound(getState().workspace);
    if (!session) return;
    if (isBusy()) {
      setStatus('有任务正在进行，结束再改名');
      return;
    }
    const target = kind === 'group' ? session.group : session.round;
    const name = await prompt({
      title: kind === 'group' ? '重命名跑分组' : '重命名评测轮',
      label: '名称',
      value: target.name,
      confirmLabel: '保存',
    });
    if (name === null || name === target.name) return;
    if (kind === 'group') await renameGroup(session.group, name);
    else await renameRound(session.group, session.round, name);
  };

  const crumb = (kind: 'group' | 'round', className: string): HTMLButtonElement =>
    el('button', {
      class: className,
      attrs: { type: 'button', title: '双击或按 F2 改名' },
      on: {
        dblclick: () => void renameWithPrompt(kind),
        keydown: (event) => {
          if (event.key !== 'F2') return;
          event.preventDefault();
          void renameWithPrompt(kind);
        },
      },
    });

  const groupLabel = crumb('group', 'titlebar__doc-group');
  const docSep = el('span', {
    class: 'titlebar__doc-sep',
    text: '/',
    attrs: { 'aria-hidden': 'true' },
  });
  const roundLabel = crumb('round', 'titlebar__doc-round');
  const docTitle = el('div', { class: 'titlebar__doc' }, groupLabel, docSep, roundLabel);

  // 应用唯一的主错误/状态通道：补 live region，异步失败才会被读屏播报。
  const status = el('div', {
    class: 'titlebar__status',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const alerts = el('div', { class: 'titlebar__alerts' });
  const saved = el('span', { class: 'titlebar__saved' });

  // 顶栏只放「全局动作」（帮助、设置）。沉浸模式是「面板可见性」的一种，
  // 归工作栏那组折叠按钮（Ctrl+B / Ctrl+I / Ctrl+J / F），不要在这里再放一个。
  const actions = el(
    'div',
    { class: 'titlebar__actions' },
    saved,
    iconButton({
      label: '快捷键（?）',
      icon: 'keyboard',
      variant: 'quiet',
      onClick: () => void runCommand('open-help'),
    }),
    iconButton({
      label: '设置（Ctrl+,）',
      icon: 'settings',
      variant: 'quiet',
      onClick: () => void runCommand('open-settings'),
    }),
  );

  host.appendChild(
    el(
      'header',
      { class: 'titlebar', attrs: { role: 'banner' } },
      docTitle,
      status,
      alerts,
      actions,
    ),
  );

  const update = (): void => {
    const state = getState();

    const session = activeRound(state.workspace);
    groupLabel.textContent = session?.group.name ?? '没有打开的跑分组';
    groupLabel.title = session?.group.name ?? '';
    roundLabel.textContent = session?.round.name ?? '';
    roundLabel.title = session?.round.name ?? '';
    docSep.hidden = !session;
    roundLabel.hidden = !session;
    docTitle.classList.toggle('is-empty', !session);

    status.replaceChildren(statusNode());

    // 长任务：标题栏只展示第一条（label + 真实进度细节），其余靠状态栏与各自分区
    const busy = [...state.busy.values()][0];
    const busyNode = busy
      ? el(
          'span',
          { class: 'titlebar__busy', title: busy.detail || busy.label },
          spinner(busy.label),
          el('span', { class: 'titlebar__busy-label', text: busy.label }),
          busy.detail ? el('span', { class: 'titlebar__busy-detail', text: busy.detail }) : null,
        )
      : null;

    const alert = ((): HTMLElement | null => {
      if (!session || session.group.kind !== 'video' || ffmpegReady()) return null;
      return el(
        'button',
        {
          class: 'titlebar__alert',
          attrs: { type: 'button', title: ffmpegReason() },
          on: { click: () => void runCommand('open-settings') },
        },
        badge('FFmpeg 未就绪', 'danger'),
      );
    })();
    alerts.replaceChildren(...[busyNode, alert].filter((node): node is HTMLElement => node !== null));

    saved.textContent = state.savedAt ?? '';
    saved.title = state.savedAt ? `最近一次自动保存 ${state.savedAt}` : '';
  };

  update();
  return { update };
}
