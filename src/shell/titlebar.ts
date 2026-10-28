// 顶部栏：品牌、当前分组/轮次、状态文本、FFmpeg 提醒、快捷键帮助与设置入口。
//
// 状态文本单行截断，点击弹出可复制的完整内容（长错误不会被挤成一团或撑高顶栏）。

import { getState } from '../core/store';
import { ffmpegReady, ffmpegReason } from '../core/ffmpeg';
import { activeRound } from '../core/model';
import { el } from '../ui/dom';
import { icon } from '../ui/icons';
import { badge, button, iconButton, spinner } from '../ui/primitives';
import { openPopover } from '../ui/overlay';
import { copyText } from '../core/util';
import { toast } from '../ui/toast';
import { shellState, toggleImmersive, togglePanel } from './controller';
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
  const railToggle = iconButton({
    label: '折叠或展开跑分组栏（Ctrl+B）',
    icon: 'panelLeft',
    variant: 'quiet',
    onClick: () => togglePanel('rail'),
  });

  const groupLabel = el('span', { class: 'titlebar__doc-group' });
  const docSep = el('span', { class: 'titlebar__doc-sep', text: '/' });
  const roundLabel = el('span', { class: 'titlebar__doc-round' });
  const docTitle = el('div', { class: 'titlebar__doc' }, groupLabel, docSep, roundLabel);

  const status = el('div', { class: 'titlebar__status' });
  const alerts = el('div', { class: 'titlebar__alerts' });
  const saved = el('span', { class: 'titlebar__saved' });

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
    iconButton({
      label: '沉浸模式（F）',
      icon: 'expand',
      variant: 'quiet',
      onClick: () => toggleImmersive(),
    }),
  );

  host.appendChild(
    el(
      'header',
      { class: 'titlebar', attrs: { role: 'banner' } },
      el(
        'div',
        { class: 'titlebar__brand' },
        railToggle,
        el('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'titlebar__name', text: '像素竞技场' }),
      ),
      docTitle,
      status,
      alerts,
      actions,
    ),
  );

  const update = (): void => {
    const state = getState();
    railToggle.setAttribute('aria-pressed', String(!shellState.railCollapsed));

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
