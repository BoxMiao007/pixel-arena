// 外观分区：界面主题。
//
// 主题是唯一「改动要立刻看到」的设置：先在 onCommit 里 applyTheme 预览，保存失败再
// 回滚到上一个生效值——不用等保存成功才变色，也不必为了看效果去点别处。

import { applyTheme } from '../../../core/theme';
import type { SettingsData, ThemePref } from '../../../core/settings';
import { el } from '../../../ui/dom';
import type { SectionModule, SettingsCtx } from '../context';
import { selectWithError } from '../fields';
import { THEME_CHOICES } from '../model';

export function createAppearanceSection(ctx: SettingsCtx): SectionModule {
  const theme = selectWithError({
    label: '界面主题',
    value: ctx.settings().theme,
    choices: THEME_CHOICES,
    onCommit: async (value, previous) => {
      const next = value as ThemePref;
      applyTheme(next); // 预览：主题改动立即生效
      const error = await ctx.save({ theme: next });
      if (error !== null) applyTheme(previous as ThemePref); // 保存失败回到上一个生效值
      return error;
    },
  });

  const node = el('div', { class: 'settings__group' }, theme.node);

  return {
    node,
    sync: (settings: SettingsData) => {
      theme.select.value = settings.theme;
    },
  };
}
