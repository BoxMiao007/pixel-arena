// 跑分与导出分区：并发度 + 文件名冲突策略。
//
// 并发度下面直接写出「这一档实际同时跑几个任务」：后端按逻辑核比例取整，档位本身
// 看不出结果，用户要的是这个数。文件名冲突策略说清两种行为的差别（自动追加 vs 写入前询问）。

import type {
  ConflictPolicyPref,
  ScoreConcurrencyPref,
  SettingsData,
} from '../../../core/settings';
import { el } from '../../../ui/dom';
import type { SectionModule, SettingsCtx } from '../context';
import { selectWithError } from '../fields';
import { CONCURRENCY_CHOICES, CONFLICT_CHOICES, concurrencyHint } from '../model';

export function createScoringSection(ctx: SettingsCtx): SectionModule {
  const settings = ctx.settings();
  // 逻辑核数拿不到时不出数字（不编造），只留一句口径说明
  const cores =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 0;
  const hintFor = (pref: ScoreConcurrencyPref): string =>
    cores > 0 ? concurrencyHint(pref, cores) : '同时跑的任务数按逻辑核比例限制';

  const concurrency = selectWithError({
    label: '跑分并发度',
    value: settings.scoreConcurrency,
    choices: CONCURRENCY_CHOICES,
    hint: hintFor(settings.scoreConcurrency),
    onCommit: async (value) => {
      const error = await ctx.save({ scoreConcurrency: value as ScoreConcurrencyPref });
      if (error === null) concurrency.setHint(hintFor(value as ScoreConcurrencyPref));
      return error;
    },
  });

  const conflict = selectWithError({
    label: '文件名冲突',
    value: settings.conflictPolicy,
    choices: CONFLICT_CHOICES,
    hint: '产物与已有文件同名时：自动在文件名后追加 _1/_2，或写入前弹窗由你选择覆盖还是跳过',
    onCommit: async (value) => ctx.save({ conflictPolicy: value as ConflictPolicyPref }),
  });

  const node = el('div', { class: 'settings__group' }, concurrency.node, conflict.node);

  return {
    node,
    sync: (next: SettingsData) => {
      concurrency.select.value = next.scoreConcurrency;
      concurrency.setHint(hintFor(next.scoreConcurrency));
      conflict.select.value = next.conflictPolicy;
    },
  };
}
