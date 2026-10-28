// 检视器分区「高级」：图片条目队列的入口与一屏概览。
//
// 条目队列（一张图 + 一套编码器配置 = 一个评测轮）是需要聚焦的完整工作流，主体仍在
// 模态里（两步：条目列表 → 逐图编辑）；这里只放入口、概览与拖放落区，避免在检视器
// 里再长出一套完整列表。日常单张调参不必开模态：候选分区里点胶囊即可就地编辑。

import { badge, button, emptyState, toolbar } from '../../../ui/primitives';
import { fileName } from '../../../core/util';
import { isBusy } from '../../../core/store';
import { badgeText, judgeEntries, planScore } from '../logic/entries';
import { queueIdentityProbe } from '../logic/runtime';
import { addQueuePaths, openQueue, pickQueueImages, queueEntries } from '../actions';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import { STATE_BADGE_KIND } from '../overlay/queue-modal';
import { block, dropTarget, mountSection, paintBody } from './common';

/** 概览里最多列几行（其余进模态看）。 */
const PREVIEW_ROWS = 4;

export const advancedSection: PanelSection = {
  id: 'advanced',
  title: '高级',
  order: 50,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const groupId = ctx.group.id;
    const { body } = mountSection(host, { id: 'advanced', title: '高级', defaultOpen: false });
    const unregisterDrop = dropTarget(body, {
      id: 'encoding-advanced',
      accept: 'image',
      hint: '松开：加入图片条目（待配置后跑分）',
      onDrop: (paths) => {
        void addQueuePaths(groupId, paths).then(render);
      },
      disabled: () => isBusy(),
    });

    const open = (): void => {
      openQueue(groupId);
    };

    const render = (): void => {
      const entries = queueEntries(groupId);
      const plan = planScore(entries, queueIdentityProbe());
      const busy = isBusy();
      const key = [
        'advanced',
        groupId,
        entries.length,
        plan.runImageCount,
        entries.map((entry) => entry.encoders.length).join(','),
        busy ? 'busy' : 'idle',
      ].join(':');

      paintBody(body, key, () => {
        if (entries.length === 0) {
          return emptyState({
            title: '还没有图片条目',
            hint: '条目 = 一张图 + 一套编码器配置，对应一个评测轮。添加后可以直接跑分，也可以逐张调参数。',
            icon: 'gauge',
            actions: [
              button({
                label: '添加图片',
                variant: 'primary',
                disabled: busy,
                onClick: () => void pickQueueImages(groupId).then(render),
              }),
            ],
          });
        }
        const verdicts = judgeEntries(entries, queueIdentityProbe());
        const rows = block('div', { class: 'adv-list' });
        entries.slice(0, PREVIEW_ROWS).forEach((entry, index) => {
          const verdict = verdicts[index];
          rows.append(
            block(
              'div',
              { class: 'adv-row' },
              block('span', {
                class: 'adv-row__name',
                text: fileName(entry.path),
                title: entry.path,
              }),
              badge(badgeText(verdict.state, verdict.reasons), STATE_BADGE_KIND[verdict.state]),
              block('span', { class: 'adv-row__spacer', text: '' }),
              block('span', {
                class: 'adv-row__cards',
                text: `${entry.encoders.length} 条配置`,
              }),
            ),
          );
        });
        if (entries.length > PREVIEW_ROWS) {
          rows.append(
            block('p', {
              class: 'adv-more',
              text: `另有 ${entries.length - PREVIEW_ROWS} 张，打开队列查看全部`,
            }),
          );
        }

        return block(
          'div',
          { class: 'adv' },
          toolbar(
            button({
              label: '＋ 添加图片',
              variant: 'primary',
              disabled: busy,
              title: '多选图片直接加入条目队列（不弹窗）',
              onClick: () => void pickQueueImages(groupId).then(render),
            }),
            button({
              label: '打开条目队列',
              variant: 'secondary',
              disabled: busy,
              title: '完整工作流：条目列表 → 逐图编辑 → 跑分',
              onClick: open,
            }),
            block('span', {
              class: 'adv__count',
              text: `${entries.length} 张，待跑 ${plan.runImageCount} 张`,
            }),
          ),
          rows,
          block('p', {
            class: 'adv__note',
            text:
              plan.runImageCount > 0
                ? '有待跑的条目：到「跑分」分区点「只跑改过的」，或在队列里点跑分。'
                : '条目参数改动即时生效；点「跑分」才会写工作区。',
          }),
        );
      });
    };

    render();
    return { update: render, destroy: () => unregisterDrop() };
  },
};
