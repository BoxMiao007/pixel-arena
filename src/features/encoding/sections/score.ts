// 「原图」分区内的跑分块：两个跑分入口 + 真实进度 + 失败就地展开。
//
// 主次关系：
// - 「开始跑分」= 唯一主按钮（Ctrl+Enter）：先把脏参数变体生成出来，再整轮重算指标；
// - 「重跑改过的（N 张）」= 次级动作：只补生成脏变体 + 只跑缺指标的跑分图（增量）；
// - 缺图时不只靠置灰按钮的悬浮提示：正文直接给「选择原图 / 添加跑分图」下一步
//   入口（设计契约 §3.3 渐进披露），点了就开对应的文件对话框；
// - 自动生成跑分在「编码阶梯」分区里，不在这里抢位置；
// - 本块不再单独占一个分区，直接并入「原图」分区正文（原图 + 本轮跑分动作是一个整体）。

import { button, progressBar } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { isBusy } from '../../../core/store';
import { fileName } from '../../../core/util';
import { planScore } from '../logic/entries';
import { busyProgressView } from '../logic/progress';
import { candidatesNeedingScore, rerunChangedButtonLabel } from '../logic/run';
import { queueIdentityProbe } from '../logic/runtime';
import {
  busyIdOf,
  pickCandidates,
  pickReference,
  refreshRoundIdentity,
  runChangedEntries,
  runFullScore,
  variantEntries,
} from '../actions';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { busyOf, hintWrap, liveRoundOf, paintBody } from './common';

/** 在给定容器里挂载跑分块（供「原图」分区嵌入；不再注册独立分区）。 */
export function mountScoreContent(host: HTMLElement, ctx: ViewCtx): MountedView {
  /** 标识自举只做一次：待跑计数依赖判定，标识没读到会把干净变体误计成待跑。 */
  let identityReady = false;
  const ensureIdentity = (referencePath: string): void => {
    if (identityReady || referencePath === '') return;
    identityReady = true;
    void refreshRoundIdentity(referencePath).then(() => render());
  };

  const render = (): void => {
    const busy = isBusy();
    // 同轮内加图只走 update()：ctx 是挂载快照，必须重取活数据（见 common.ts），
    // 否则「加原图后按钮仍灰、提示停在『先选择原图』」会复现。
    const round = liveRoundOf(ctx);
    if (round.referencePath !== null) ensureIdentity(round.referencePath);
    const hasReference = round.referencePath !== null;
    const candidates = round.candidates;
    const entries = variantEntries(ctx.group.id, round.id);
    const plan = planScore(entries, queueIdentityProbe());
    const pending = candidatesNeedingScore(candidates);
    const rerunCount = plan.runImageCount + pending.length;
    const failed = candidates.filter((candidate) => candidate.error !== null);
    const scoringBusy = busyOf(busyIdOf('score', ctx.round.id));
    const key = [
      'score',
      ctx.round.id,
      hasReference ? 'ref' : 'noref',
      candidates.length,
      entries.length,
      rerunCount,
      failed.length,
      busy ? 'busy' : 'idle',
      scoringBusy?.detail ?? '',
      scoringBusy?.completed ?? '',
      scoringBusy?.total ?? '',
    ].join(':');

    paintBody(host, key, () => {
      const progress = progressBar({ label: '跑分进度' });
      if (scoringBusy) {
        const view = busyProgressView(scoringBusy);
        if (view.kind === 'determinate') progress.set(view.completed, view.total, view.label);
        else progress.setIndeterminate(view.label);
      }

      const hasContent = candidates.length > 0 || plan.runImageCount > 0;
      const runDisabled = !hasReference || !hasContent || busy;
      const rerunDisabled = rerunCount === 0 || busy;
      const ready = hasReference && hasContent;
      const runHint = !hasReference
        ? '先选择原图'
        : !hasContent
          ? '先添加至少一张跑分图，或新建一个参数变体'
          : busy
            ? '正在跑分，完成后可再次触发'
            : '整轮跑分：先补生成待跑的参数变体，再逐张计算指标（Ctrl+Enter）';
      const rerunHint = busy
        ? '正在跑分，完成后可再次触发'
        : rerunCount === 0
          ? '没有改过的：参数变体与跑分图都已跑分且无变更（整轮重算请用「开始跑分」）'
          : '只跑改过的：待生成的参数变体 + 缺指标的跑分图；其余沿用已有结果';

      const runButton = button({
        label: scoringBusy ? '跑分中…' : '开始跑分',
        variant: 'primary',
        disabled: runDisabled,
        title: runHint,
        onClick: () => void runFullScore(ctx),
      });
      const rerunButton = button({
        label: rerunChangedButtonLabel(plan, pending.length),
        variant: 'secondary',
        size: 'md',
        disabled: rerunDisabled,
        title: rerunHint,
        onClick: () => void runChangedEntries(ctx),
      });

      return el(
        'div',
        { class: 'score' },
        ready
          ? el('div', { class: 'score__lead' }, [
              el('span', {
                class: 'score__count',
                text:
                  entries.length === 0
                    ? `本轮 ${candidates.length} 张跑分图`
                    : `本轮 ${candidates.length} 张跑分图，${entries.length} 个参数变体`,
              }),
            ])
          : el(
              'p',
              { class: 'score__blocked score__blocked--next' },
              el('span', {
                class: 'score__next-text',
                text: !hasReference ? '还没有原图：先选一张作为基准' : '还没有跑分图：加一张已压好的图',
              }),
              el('span', { class: 'score__next-spacer' }),
              button({
                label: hasReference ? '添加跑分图' : '选择原图',
                variant: 'secondary',
                size: 'sm',
                disabled: busy,
                title: !hasReference
                  ? '选一张未压缩的原图作为本轮基准'
                  : '把用其它工具压好的图加入本轮；也可以在「跑分图」分区从原图新建编码',
                onClick: () => void (hasReference ? pickCandidates(ctx) : pickReference(ctx)),
              }),
            ),
        el('div', { class: 'score__actions' }, [
          runDisabled ? hintWrap(runButton, runHint, true) : runButton,
          rerunDisabled ? hintWrap(rerunButton, rerunHint) : rerunButton,
        ]),
        scoringBusy ? el('div', { class: 'score__progress' }, progress.node) : null,
        failed.length > 0
          ? el(
              'details',
              { class: 'score__failures' },
              el('summary', {
                class: 'score__summary',
                text: `${failed.length} 张失败（展开看原因）`,
              }),
              el(
                'ul',
                { class: 'score__failure-list' },
                ...failed.map((candidate) =>
                  el('li', { class: 'score__failure' }, [
                    el('span', { class: 'score__failure-name', text: fileName(candidate.path) }),
                    el('span', {
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
}
