// 检视器分区「跑分」：两个跑分入口 + 真实进度 + 失败就地展开。
//
// 主次关系（收敛前是工具栏上三个平级按钮）：
// - 「开始跑分」= 唯一主按钮（整轮全量，Ctrl+Enter）；
// - 「只跑改过的（N 张）」= 次级动作，只跑参数改过 / 换过图 / 上次失败的条目，
//   0 张时置灰并在 title 里说明原因（不静默，也不假装能跑）；
// - 自动生成跑分在「编码阶梯」分区里，不在这里抢位置。

import { button, progressBar } from '../../../ui/primitives';
import { isBusy } from '../../../core/store';
import { fileName } from '../../../core/util';
import { planScore } from '../logic/entries';
import { rerunChangedButtonLabel } from '../logic/run';
import { queueIdentityProbe } from '../logic/runtime';
import { busyIdOf, queueEntries, runChangedEntries, runFullScore } from '../actions';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import { block, busyOf, hintWrap, mountSection, paintBody } from './common';

export const scoreSection: PanelSection = {
  id: 'score',
  title: '跑分',
  order: 30,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const { body } = mountSection(host, { id: 'score', title: '跑分' });

    const render = (): void => {
      const busy = isBusy();
      const hasReference = ctx.round.referencePath !== null;
      const candidates = ctx.round.candidates;
      const plan = planScore(queueEntries(ctx.group.id), queueIdentityProbe());
      const rerunCount = plan.runImageCount;
      const failed = candidates.filter((candidate) => candidate.error !== null);
      const scoringBusy = busyOf(busyIdOf('score', ctx.round.id));
      const key = [
        'score',
        ctx.round.id,
        candidates.length,
        rerunCount,
        failed.length,
        busy ? 'busy' : 'idle',
        scoringBusy?.detail ?? '',
      ].join(':');

      paintBody(body, key, () => {
        const progress = progressBar({ label: '跑分进度' });
        if (scoringBusy) {
          const [done, total] = scoringBusy.detail.split('/');
          const value = Number(done);
          const max = Number(total);
          if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
            progress.set(value, max);
          } else {
            progress.setIndeterminate(scoringBusy.label);
          }
        }

        const runDisabled = !hasReference || candidates.length === 0 || busy;
        const rerunDisabled = rerunCount === 0 || busy;
        const ready = hasReference && candidates.length > 0;
        const runHint = !hasReference
          ? '先选择原图'
          : candidates.length === 0
            ? '先添加至少一张跑分图'
            : busy
              ? '正在跑分，完成后可再次触发'
              : '整轮全量：逐张计算各跑分图相对原图的指标（Ctrl+Enter）';
        const rerunHint = busy
          ? '正在跑分，完成后可再次触发'
          : rerunCount === 0
            ? '没有改过的条目：全部都已跑分且无变更（整轮重算请用「开始跑分」）'
            : '只跑改过的：参数改过 / 换过图 / 上次失败的条目；其余沿用上一轮结果';

        const runButton = button({
          label: scoringBusy ? '跑分中…' : '开始跑分',
          variant: 'primary',
          disabled: runDisabled,
          title: runHint,
          onClick: () => void runFullScore(ctx),
        });
        const rerunButton = button({
          label: rerunChangedButtonLabel(plan),
          variant: 'secondary',
          size: 'md',
          disabled: rerunDisabled,
          title: rerunHint,
          onClick: () => void runChangedEntries(ctx.group.id),
        });

        return block(
          'div',
          { class: 'score' },
          ready
            ? block('div', { class: 'score__lead' }, [
                block('span', {
                  class: 'score__count',
                  text: `本轮 ${candidates.length} 张跑分图`,
                }),
              ])
            : block('p', {
                class: 'score__blocked',
                text: '选好原图与跑分图后在这里开始跑分',
              }),
          block('div', { class: 'score__actions' }, [
            runDisabled ? hintWrap(runButton, runHint, true) : runButton,
            rerunDisabled ? hintWrap(rerunButton, rerunHint) : rerunButton,
          ]),
          scoringBusy
            ? block('div', { class: 'score__progress' }, progress.node)
            : null,
          failed.length > 0
            ? block(
                'details',
                { class: 'score__failures' },
                block('summary', {
                  class: 'score__summary',
                  text: `${failed.length} 张失败（展开看原因）`,
                }),
                block(
                  'ul',
                  { class: 'score__failure-list' },
                  ...failed.map((candidate) =>
                    block('li', { class: 'score__failure' }, [
                      block('span', { class: 'score__failure-name', text: fileName(candidate.path) }),
                      block('span', {
                        class: 'score__failure-reason',
                        text: candidate.error ?? '',
                        title: candidate.error ?? '',
                      }),
                    ]),
                  ),
                ),
              )
            : null,
        );
      });
    };

    // 行内「跑分中」由图外（结果坞）也读同一份 store 状态；这里只需跟随重画
    render();
    return { update: render, destroy: () => undefined };
  },
};
