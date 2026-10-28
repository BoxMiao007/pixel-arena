// 检视器「跑分视频」分区：多选胶囊（× 单独移除）+ 行内状态 + 体积比 + 拖放落区。
//
// 与图片组的「跑分图」分区同一套交互语言；点击某一行把它设为舞台当前对比源，
// 与结果坞的行点击共用 core/ui-state 的 activeCandidate。

import { isBusy, isPathRunning, subscribe } from '../../../core/store';
import type { CandidateVideo } from '../../../core/model';
import { formatRatio, formatSize } from '../../../core/format';
import { getActiveCandidate, setActiveCandidate } from '../../../core/ui-state';
import { fileName, truncateFileName } from '../../../core/util';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { registerDropTarget } from '../../../shell/file-drop';
import { requestRender } from '../../../shell/controller';
import { el, paint } from '../../../ui/dom';
import { badge, button, chip, iconButton, section } from '../../../ui/primitives';
import { chooseVideoCandidates, pickVideoCandidates, removeVideoCandidate } from '../actions';
import { persistSectionOpen, sectionOpen, videoRound } from './shared';

const SECTION_ID = 'candidates-video';

type BadgeKind = 'neutral' | 'info' | 'ok' | 'danger';

function statusOf(candidate: CandidateVideo, running: boolean): {
  text: string;
  kind: BadgeKind;
} {
  if (candidate.error !== null) return { text: '失败', kind: 'danger' };
  if (running) return { text: '跑分中', kind: 'info' };
  if (candidate.metrics === null) return { text: '待跑分', kind: 'neutral' };
  return { text: '完成', kind: 'ok' };
}

export function mountCandidatesPanel(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;

  const body = el('div', { class: 'video-panel' });
  const addButton = iconButton({
    label: '添加跑分视频',
    icon: 'plus',
    variant: 'bordered',
    size: 'sm',
    onClick: () => void pickVideoCandidates(groupId, roundId),
  });
  const panel = section(
    {
      id: SECTION_ID,
      title: '跑分视频',
      collapsible: true,
      open: sectionOpen(SECTION_ID),
      onToggle: (open) => persistSectionOpen(SECTION_ID, open),
      actions: addButton,
    },
    body,
  );
  host.replaceChildren(panel.node);

  const unregisterDrop = registerDropTarget(body, {
    id: 'drop-candidates-video',
    accept: 'video',
    hint: '松开：追加为跑分视频',
    onDrop: (paths) => {
      if (paths.length > 0) void chooseVideoCandidates(groupId, roundId, paths);
    },
    disabled: () => isBusy(),
  });

  const update = (): void => {
    const round = videoRound(groupId, roundId);
    const candidates = round?.videoCandidates ?? [];
    const busy = isBusy();
    addButton.disabled = busy;
    const active = getActiveCandidate(roundId);

    const key = [
      busy ? 1 : 0,
      active ?? '',
      ...candidates.map((candidate) => {
        const status = statusOf(candidate, isPathRunning(candidate.path));
        return `${candidate.path}~${status.text}~${candidate.sizeRatio ?? ''}~${candidate.error ?? ''}`;
      }),
    ].join('|');

    paint(body, key, () => {
      if (candidates.length === 0) {
        return el(
          'div',
          { class: 'video-empty-row' },
          el('span', { class: 'video-empty-row__text', text: '还没有跑分视频' }),
          button({
            label: '添加跑分视频',
            size: 'sm',
            variant: 'secondary',
            icon: 'plus',
            disabled: busy,
            onClick: () => void pickVideoCandidates(groupId, roundId),
          }),
          el('span', { class: 'video-empty-row__hint', text: '或把视频拖到这里' }),
        );
      }

      const list = el('div', { class: 'video-source-list' });
      for (const candidate of candidates) {
        const status = statusOf(candidate, isPathRunning(candidate.path));
        const selected = active === candidate.path;
        const meta = [
          formatSize(candidate.fileSize),
          candidate.sizeRatio === null ? null : `体积比 ${formatRatio(candidate.sizeRatio)}`,
        ]
          .filter((part): part is string => part !== null)
          .join('  ');

        const statusBadge = badge(status.text, status.kind, candidate.error ?? status.text);
        statusBadge.classList.add('video-source-row__status');

        const row = el(
          'div',
          {
            class: `video-source-row${selected ? ' is-selected' : ''}`,
            dataset: { path: candidate.path },
            on: {
              click: (event) => {
                const target = event.target;
                if (target instanceof HTMLElement && target.closest('button')) return;
                setActiveCandidate(roundId, candidate.path);
                requestRender();
              },
            },
          },
          chip({
            label: truncateFileName(fileName(candidate.path)),
            title: candidate.path,
            disabled: busy,
            onRemove: busy
              ? undefined
              : () => void removeVideoCandidate(groupId, roundId, candidate.path),
          }),
          el('span', {
            class: 'video-source-row__meta',
            text: meta,
            title: candidate.path,
          }),
          statusBadge,
        );
        list.appendChild(row);
      }
      return list;
    });
  };

  const unsubscribe = subscribe(update);
  update();
  return {
    update,
    destroy(): void {
      unsubscribe();
      unregisterDrop();
    },
  };
}
