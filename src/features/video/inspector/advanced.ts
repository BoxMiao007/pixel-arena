// 检视器「高级」分区（视频组）：高级创建的入口与一屏概览。
//
// 完整工作流（选编码器 → 配参数 → 看命令行 → 建轮）需要聚焦，主体在模态面板里
// （advanced/panel.ts）；这里只放入口、本版本能力边界说明与会话里已有的配置数。
// 按钮忙时置灰，并在 title 里说明原因（有长任务在跑），不静默。
//
// 命令 advanced-video-create 由本按钮调用；快捷键/其它入口共用同一命令。

import { isBusy, subscribe } from '../../../core/store';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { runCommand } from '../../../shell/registry';
import { el, paint } from '../../../ui/dom';
import { button, section } from '../../../ui/primitives';
import { sessionFor } from '../advanced/catalog';
import { persistSectionOpen, sectionOpen } from './shared';

const SECTION_ID = 'advanced-video';

export function mountAdvancedVideoSection(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const body = el('div', { class: 'video-panel' });
  const panel = section(
    {
      id: SECTION_ID,
      title: '高级',
      collapsible: true,
      open: sectionOpen(SECTION_ID),
      onToggle: (open) => persistSectionOpen(SECTION_ID, open),
    },
    body,
  );
  host.replaceChildren(panel.node);

  const update = (): void => {
    const busy = isBusy();
    const count = sessionFor(groupId).entries.length;
    const key = `${busy ? 1 : 0}|${count}`;

    paint(body, key, () => {
      const openButton = button({
        label: '高级创建…',
        variant: 'primary',
        size: 'sm',
        disabled: busy,
        title: busy
          ? '有任务正在运行，完成后再开始高级创建'
          : '打开视频高级创建：选原视频与编码器、配置参数、预览命令行，确认后新建并激活一轮评测',
        onClick: () => void runCommand('advanced-video-create'),
      });

      return el(
        'div',
        { class: 'adv-video-entry' },
        el('p', {
          class: 'video-hint',
          text:
            '选择视频编码器并逐项配置参数、预览命令行；确认后新建评测轮并自动激活，' +
            '把配置摘要与每项命令行写进轮备注。本版本不做视频自动编码；可复制命令行' +
            '自行编码后用「添加跑分视频」导入。',
        }),
        el(
          'div',
          { class: 'adv-video-entry__row' },
          openButton,
          busy
            ? el('span', {
                class: 'adv-video-entry__hint',
                text: '有任务正在运行，完成后再开始',
              })
            : null,
          count > 0
            ? el('span', {
                class: 'adv-video-entry__count',
                text: `已有 ${count} 条配置（关闭面板不丢）`,
              })
            : null,
        ),
      );
    });
  };

  const unsubscribe = subscribe(update);
  update();
  return {
    update,
    destroy(): void {
      unsubscribe();
    },
  };
}
