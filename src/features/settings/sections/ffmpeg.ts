// FFmpeg 分区：状态 + 外部路径 + 应用内下载。
//
// 「应用内下载」是模块级任务（见 ../download），这里只负责把它的状态画出来：
// 进行中禁用按钮、显示真实进度条与后端原文，失败留在原地给「重试下载」。
// 路径保存成功后立刻重探状态——用户改完马上能看到「外部 v7.1」这类结果。

import type { SettingsData } from '../../../core/settings';
import { el } from '../../../ui/dom';
import { button, progressBar } from '../../../ui/primitives';
import type { SectionModule, SettingsCtx } from '../context';
import { downloadState, startFfmpegDownload, subscribeDownload } from '../download';
import { pathField } from '../fields';
import { describeTool } from '../model';
import { toolRow } from '../tool-row';

/** 按钮文案随「是否已装内置 + 下载状态」变化，动作名与后端报错里的「应用内下载」一致。 */
function downloadLabel(installed: boolean): string {
  const phase = downloadState().phase;
  if (phase === 'downloading') return '下载中…';
  if (phase === 'failed') return '重试下载';
  return installed ? '重新下载并校验' : '应用内下载';
}

export function createFfmpegSection(ctx: SettingsCtx): SectionModule {
  const settings = ctx.settings();
  const snapshot = ctx.tools.snapshot();

  const refreshBtn = button({
    label: '重新检测',
    icon: 'refresh',
    size: 'sm',
    variant: 'quiet',
    title: '重新探测 FFmpeg 路径与版本',
    onClick: () => ctx.tools.refresh(),
  });

  // 「重新检测」并进状态行（toolRow 的 actions），不再单独占一条左侧全空的行动行。
  const row = toolRow(
    describeTool('ffmpeg', snapshot.statuses?.get('ffmpeg'), snapshot.phase, snapshot.error),
    { actions: [refreshBtn] },
  );

  const path = pathField({
    id: 'settings-ffmpeg-path',
    label: 'FFmpeg 路径',
    value: settings.ffmpegPath,
    placeholder: '留空使用内置 FFmpeg',
    docTitle: '本机已有的 ffmpeg 可执行文件；留空则使用应用内下载的内置版本',
    browseTitle: '选择 ffmpeg 可执行文件',
    kind: 'file',
    hint: '留空使用内置版本；指定外部路径后优先使用（保存时会实测一次版本）',
    onCommit: async (value) => {
      const error = await ctx.save({ ffmpegPath: value });
      if (error === null) ctx.tools.refresh();
      return error;
    },
  });

  // ---- 应用内下载 ----
  const downloadBtn = button({
    label: downloadLabel(false),
    icon: 'importFile',
    size: 'sm',
    variant: 'secondary',
    onClick: () => startFfmpegDownload(),
  });
  const progress = progressBar();
  const status = el('p', { class: 'settings__notice', attrs: { role: 'status', 'aria-live': 'polite' } });
  const hint = el('p', {
    class: 'field__hint',
    text: '从锁定来源下载并校验完整性，存入应用数据目录，只需一次',
  });
  const downloadBox = el(
    'div',
    { class: 'settings__download' },
    el('div', { class: 'settings__row' }, downloadBtn),
    progress.node,
    status,
    hint,
  );

  const setDownloadLabel = (text: string): void => {
    const label = downloadBtn.querySelector('.btn__label');
    if (label) label.textContent = text;
  };

  const paintDownload = (): void => {
    const current = downloadState();
    const snap = ctx.tools.snapshot();
    const installed = snap.statuses?.get('ffmpeg')?.builtinInstalled === true;
    downloadBtn.disabled = current.phase === 'downloading';
    setDownloadLabel(downloadLabel(installed));

    if (current.phase === 'downloading') {
      progress.node.hidden = false;
      if (current.ratio === null) progress.setIndeterminate(current.text || '正在下载…');
      else progress.set(current.ratio * 100, 100, current.text);
      status.textContent = '';
      status.hidden = true;
    } else {
      progress.node.hidden = true;
      const failure = current.phase === 'failed';
      status.hidden = !failure;
      status.textContent = failure ? `下载失败：${current.error ?? '未知原因'}` : '';
      status.classList.toggle('is-error', failure);
    }
  };

  const paint = (): void => {
    const snap = ctx.tools.snapshot();
    row.update(describeTool('ffmpeg', snap.statuses?.get('ffmpeg'), snap.phase, snap.error));
    paintDownload();
  };

  const unsubTools = ctx.tools.subscribe(() => paint());
  let previousPhase = downloadState().phase;
  const unsubDownload = subscribeDownload((state) => {
    const finished = previousPhase === 'downloading' && state.phase !== 'downloading';
    previousPhase = state.phase;
    // 下载结束就重探：徽标与路径立刻反映新装好的内置 ffmpeg
    if (finished && state.phase === 'idle') ctx.tools.refresh();
    paintDownload();
  });

  const node = el('div', { class: 'settings__group' }, row.node, path.node, downloadBox);
  paintDownload();

  return {
    node,
    sync: (next: SettingsData) => {
      path.sync(next.ffmpegPath);
    },
    destroy: () => {
      unsubTools();
      unsubDownload();
    },
  };
}
