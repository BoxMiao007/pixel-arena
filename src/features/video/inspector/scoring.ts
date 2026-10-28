// 检视器「视频跑分」分区：主按钮 + 真实进度 + 参数摘要 + 失败原因就地展开。
//
// - FFmpeg 未就绪时在分区顶部内联提示（原因 + 前往设置），按钮不灰死：点下去会把
//   后端中文原因亮在状态栏，避免「按钮灰着但不知道为什么」；
// - 整轮单 IPC，进度只有 N/M：确定进度用 store.busy 的 completed/total，没有时用
//   不确定态，绝不伪造百分比；
// - 单段失败不让整轮失败，原因写在候选行内，这里逐条可展开、可复制。

import { ffmpegReason, ffmpegStatus } from '../../../core/ffmpeg';
import { getState, busyEntry, isBusy, subscribe } from '../../../core/store';
import type { CandidateVideo } from '../../../core/model';
import { copyText, fileName, truncateFileName } from '../../../core/util';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { el, frag, paint } from '../../../ui/dom';
import { badge, button, metaRow, progressBar, section } from '../../../ui/primitives';
import { toast } from '../../../ui/toast';
import { runVideoScoring, VIDEO_BUSY_ID } from '../actions';
import { persistSectionOpen, sectionOpen, concurrencyLabel, openSettings, videoRound } from './shared';

const SECTION_ID = 'score-video';

export function mountScoringPanel(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;

  const body = el('div', { class: 'video-panel video-score' });
  const panel = section(
    {
      id: SECTION_ID,
      title: '视频跑分',
      collapsible: true,
      open: sectionOpen(SECTION_ID),
      onToggle: (open) => persistSectionOpen(SECTION_ID, open),
    },
    body,
  );
  host.replaceChildren(panel.node);

  const hintHost = el('div', { class: 'video-score__hint' });
  const startButton = button({
    label: '开始视频跑分',
    variant: 'primary',
    icon: 'gauge',
    onClick: () => void runVideoScoring(groupId, roundId),
  });
  const actionRow = el(
    'div',
    { class: 'video-score__action' },
    startButton,
    el('span', { class: 'video-hint video-hint--muted', text: 'Ctrl+Enter' }),
  );
  const progress = progressBar();
  const progressHost = el('div', { class: 'video-score__progress' }, progress.node);
  progressHost.hidden = true;
  const metaHost = el('div', { class: 'video-meta-list' });
  const failureHost = el('div', { class: 'video-failures' });
  const statusHost = el('div', { class: 'video-score__status' });

  body.append(hintHost, actionRow, progressHost, metaHost, failureHost, statusHost);

  const update = (): void => {
    const round = videoRound(groupId, roundId);
    const referencePath = round?.videoReferencePath ?? null;
    const candidates: CandidateVideo[] = round?.videoCandidates ?? [];
    const busy = isBusy();

    // 1) FFmpeg 就绪提示（就近错误，带去处）；探测未完成前不提前报警
    const ffmpeg = ffmpegStatus();
    const ffmpegKey = ffmpeg === null || ffmpeg.available ? 'ready' : `missing:${ffmpegReason()}`;
    paint(hintHost, ffmpegKey, () => {
      if (ffmpegKey === 'ready') return null;
      return el(
        'div',
        { class: 'video-hint video-hint--danger' },
        badge('FFmpeg 未就绪', 'danger'),
        el('span', { class: 'video-hint__text', text: ffmpegReason() }),
        button({
          label: '前往设置',
          size: 'sm',
          variant: 'secondary',
          onClick: openSettings,
        }),
      );
    });

    // 2) 主按钮：忙 / 缺来源时禁用；FFmpeg 未就绪不在此列（点下去看真实原因）
    const ready = referencePath !== null && candidates.length > 0;
    startButton.disabled = busy || !ready;
    startButton.title = !referencePath
      ? '先选一段原视频'
      : candidates.length === 0
        ? '先添加至少一段跑分视频'
        : busy
          ? '有任务正在运行'
          : '逐段经 ffmpeg 计算 VMAF / PSNR / SSIM；整轮并行，进度见结果坞';

    // 3) 真实进度：整轮 IPC 只有 completed/total
    const entry = busyEntry(VIDEO_BUSY_ID);
    progressHost.hidden = entry === undefined;
    if (entry) {
      if (typeof entry.completed === 'number' && typeof entry.total === 'number') {
        progress.set(entry.completed, entry.total, `${entry.completed}/${entry.total}`);
      } else {
        progress.setIndeterminate(entry.detail !== '' ? entry.detail : entry.label);
      }
    }

    // 4) 参数摘要（并发度跟随设置；只读）
    const settings = getState().settings;
    const metaKey = [
      referencePath ?? '',
      candidates.length,
      settings?.scoreConcurrency ?? '',
    ].join('|');
    paint(metaHost, metaKey, () =>
      frag(
        metaRow('原视频', referencePath ? truncateFileName(fileName(referencePath)) : '未选', {
          title: referencePath ?? '尚未选择原视频',
        }),
        metaRow('跑分视频', `${candidates.length} 段`),
        metaRow('并发度', concurrencyLabel(settings?.scoreConcurrency), {
          title: '同时运行的 ffmpeg 进程数，跟随「设置 → 跑分」的并发度档位',
        }),
      ),
    );

    // 5a) 整轮失败（如 FFmpeg 未配置）：后端没有返回工作区，行内看不到原因，
    //     这里把状态栏那条错误就近复述一遍，避免用户只看到行内「待跑分」。
    const status = getState().status;
    const lastError =
      status.isError && status.text.startsWith('视频跑分失败') ? status.text : null;
    paint(statusHost, lastError ?? 'none', () => {
      if (lastError === null) return null;
      return el(
        'p',
        { class: 'video-hint video-hint--danger', text: lastError, title: status.detail },
      );
    });

    // 5b) 失败原因：逐段展开、可复制
    const failed = candidates.filter((candidate) => candidate.error !== null);
    const failureKey = failed.map((candidate) => `${candidate.path}:${candidate.error}`).join('|');
    paint(failureHost, failureKey, () => {
      if (failed.length === 0) return null;
      const wrap = el('div', { class: 'video-failures__list' });
      for (const candidate of failed) {
        const reason = candidate.error ?? '';
        wrap.appendChild(
          el(
            'details',
            { class: 'video-failure' },
            el('summary', {
              class: 'video-failure__summary',
              text: `失败：${truncateFileName(fileName(candidate.path))}`,
              title: candidate.path,
            }),
            el('pre', { class: 'video-failure__reason', text: reason }),
            el(
              'div',
              { class: 'video-failure__actions' },
              button({
                label: '复制原因',
                size: 'sm',
                icon: 'copy',
                onClick: () => copyText(reason, () => toast('已复制失败原因', 'ok')),
              }),
            ),
          ),
        );
      }
      return wrap;
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
