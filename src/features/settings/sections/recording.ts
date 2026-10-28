// 记录分区：记住上次状态 + 默认导出目录 + 只读的两项「记了什么」。
//
// 「最近目录」与「窗口大小」不由面板编辑（一个来自每次选文件，一个来自窗口事件），
// 但它们正是「记住上次状态」实际影响的东西，所以把当前值如实列出来——旧面板只能
// 靠猜，用户没法确认上次到底记没记住。

import type { SettingsData } from '../../../core/settings';
import { el } from '../../../ui/dom';
import type { SectionModule, SettingsCtx } from '../context';
import { pathField, switchWithError } from '../fields';

/** 只读信息行：标签 + 值（长文本单行截断，悬停看全文）。 */
function metaLine(label: string): { node: HTMLElement; value: HTMLElement } {
  const value = el('span', { class: 'settings__meta-value mono truncate' });
  const node = el(
    'div',
    { class: 'settings__meta' },
    el('span', { class: 'settings__meta-label', text: label }),
    value,
  );
  return { node, value };
}

export function createRecordingSection(ctx: SettingsCtx): SectionModule {
  const settings = ctx.settings();

  const remember = switchWithError({
    label: '记住上次状态',
    checked: settings.recordState,
    hint: '关闭后启动时不恢复分组、窗口大小与最近目录，也不再记录新的最近目录',
    onCommit: async (checked) => ctx.save({ recordState: checked }),
  });

  const exportDir = pathField({
    id: 'settings-export-dir',
    label: '默认导出目录',
    value: settings.defaultExportDir,
    placeholder: '未设置（使用系统默认位置）',
    docTitle: 'CSV 与 HTML 报告对话框的起始目录',
    browseTitle: '选择默认导出目录',
    kind: 'directory',
    hint: '导出的 CSV 与 HTML 报告默认放在这里',
    onCommit: async (value) => ctx.save({ defaultExportDir: value }),
  });

  const recent = metaLine('最近目录');
  const windowSize = metaLine('上次窗口大小');
  const meta = el('div', { class: 'settings__meta-block' }, recent.node, windowSize.node);

  const node = el('div', { class: 'settings__group' }, remember.node, exportDir.node, meta);

  const paintMeta = (value: SettingsData): void => {
    recent.value.textContent = value.recentDir ?? '未记录';
    recent.value.title = value.recentDir ?? '';
    const size = value.window;
    windowSize.value.textContent = size
      ? `${Math.round(size.width)} × ${Math.round(size.height)}`
      : '未记录';
    windowSize.value.title = windowSize.value.textContent;
  };
  paintMeta(settings);

  return {
    node,
    sync: (next) => {
      remember.setChecked(next.recordState);
      exportDir.sync(next.defaultExportDir);
      paintMeta(next);
    },
  };
}
