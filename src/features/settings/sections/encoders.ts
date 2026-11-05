// 编码器分区：五个编码器的来源状态 + 外部路径覆盖。
//
// 每行三件事：现在用的是哪个（内置/外部/未配置/不可用 + 实际生效路径）、怎么换成外部
// 的可执行文件、缺了去哪里拿（官方发布页，仅 https 才渲染成链接）。状态与路径都就地
// 更新；保存成功后只重探本区（编码器路径不影响 FFmpeg 之外的东西，但重探共用同一条 IPC）。

import { ENCODER_FIELDS, type EncoderOverrides, type SettingsData } from '../../../core/settings';
import { el } from '../../../ui/dom';
import { button } from '../../../ui/primitives';
import type { SectionModule, SettingsCtx } from '../context';
import { pathField, type PathFieldHandle } from '../fields';
import { describeTool } from '../model';
import { toolRow, type ToolRowHandle } from '../tool-row';

interface EncoderRow {
  key: keyof EncoderOverrides;
  field: PathFieldHandle;
  row: ToolRowHandle;
}

export function createEncodersSection(ctx: SettingsCtx): SectionModule {
  const settings = ctx.settings();

  const refreshBtn = button({
    label: '重新检测',
    icon: 'refresh',
    size: 'sm',
    variant: 'quiet',
    title: '重新探测五个编码器的来源、版本与实际路径',
    onClick: () => ctx.tools.refresh(),
  });
  const intro = el('p', {
    class: 'field__hint',
    text: '留空使用内置编码器；指定外部路径后优先使用，对后续评测立即生效',
  });
  // 说明与「重新检测」放同一行：避免上面单独留一条只有右侧按钮的空行。
  const headRow = el('div', { class: 'settings__actions settings__actions--start' }, intro, refreshBtn);

  const rows: EncoderRow[] = [];
  const body = el('div', { class: 'settings__encoders' });

  for (const field of ENCODER_FIELDS) {
    const snapshot = ctx.tools.snapshot();
    const status = toolRow(
      describeTool(field.key, snapshot.statuses?.get(field.key), snapshot.phase, snapshot.error),
    );
    const path = pathField({
      id: `settings-encoder-${field.key}`,
      label: field.label,
      value: settings.encoderOverrides[field.key],
      placeholder: '留空使用内置编码器',
      docTitle: `${field.label} 可执行文件；留空使用内置版本`,
      browseTitle: `选择 ${field.label} 可执行文件`,
      kind: 'file',
      onCommit: async (value) => {
        // 基于「此刻最新的设置」合并，避免覆盖别处刚写入的字段
        const error = await ctx.save((current) => ({
          encoderOverrides: { ...current.encoderOverrides, [field.key]: value } as EncoderOverrides,
        }));
        if (error === null) ctx.tools.refresh();
        return error;
      },
    });
    rows.push({ key: field.key, field: path, row: status });
    body.append(el('div', { class: 'settings__encoder' }, status.node, path.node));
  }

  const node = el('div', { class: 'settings__group' }, headRow, body);

  const paint = (): void => {
    const snapshot = ctx.tools.snapshot();
    for (const item of rows) {
      item.row.update(
        describeTool(item.key, snapshot.statuses?.get(item.key), snapshot.phase, snapshot.error),
      );
    }
  };

  const unsubTools = ctx.tools.subscribe(paint);

  return {
    node,
    sync: (next: SettingsData) => {
      for (const item of rows) item.field.sync(next.encoderOverrides[item.key]);
    },
    destroy: () => unsubTools(),
  };
}
