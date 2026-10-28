// 检视器「原视频」分区：单选胶囊 + 元信息 + 拖放落区。
//
// 与图片组的「原图」分区同一套交互语言：胶囊点击即替换（后端覆盖语义：
// 旧跑分结果作废、体积比重算），拖一段视频到分区上同样设为原视频。

import { isBusy, subscribe } from '../../../core/store';
import { fileName, truncateFileName } from '../../../core/util';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { registerDropTarget } from '../../../shell/file-drop';
import { el, paint } from '../../../ui/dom';
import { button, chip, metaRow, section } from '../../../ui/primitives';
import { chooseVideoReference, pickVideoReference } from '../actions';
import { probeFailureHint } from '../errors';
import { peekVideo } from '../media';
import { formatFps, formatTimestamp } from '../timeline';
import { persistSectionOpen, sectionOpen, videoRound } from './shared';

const SECTION_ID = 'reference-video';

export function mountReferencePanel(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;
  const body = el('div', { class: 'video-panel' });
  const panel = section(
    {
      id: SECTION_ID,
      title: '原视频',
      collapsible: true,
      open: sectionOpen(SECTION_ID),
      onToggle: (open) => persistSectionOpen(SECTION_ID, open),
    },
    body,
  );
  host.replaceChildren(panel.node);

  const unregisterDrop = registerDropTarget(body, {
    id: 'drop-reference-video',
    accept: 'video',
    hint: '松开：设为原视频',
    onDrop: (paths) => {
      const first = paths[0];
      if (first) void chooseVideoReference(groupId, roundId, first);
    },
    disabled: () => isBusy(),
  });

  const update = (): void => {
    const round = videoRound(groupId, roundId);
    const path = round?.videoReferencePath ?? null;
    const snapshot = path ? peekVideo(path) : null;
    const busy = isBusy();
    const key = [
      path ?? '',
      snapshot?.status ?? '',
      snapshot?.width ?? 0,
      snapshot?.height ?? 0,
      snapshot?.fps ?? '',
      snapshot?.duration ?? 0,
      snapshot?.probeError ?? '',
      busy ? 1 : 0,
    ].join('|');

    paint(body, key, () => {
      if (!path) {
        return el(
          'div',
          { class: 'video-empty-row' },
          el('span', { class: 'video-empty-row__text', text: '还没有原视频' }),
          button({
            label: '选择原视频',
            size: 'sm',
            variant: 'secondary',
            icon: 'folder',
            disabled: busy,
            onClick: () => void pickVideoReference(groupId, roundId),
          }),
          el('span', { class: 'video-empty-row__hint', text: '或把视频拖到这里' }),
        );
      }

      const pick = (): void => {
        void pickVideoReference(groupId, roundId);
      };

      const meta = el('div', { class: 'video-meta-list' });
      meta.append(
        metaRow(
          '分辨率',
          snapshot && snapshot.width > 0 ? `${snapshot.width} × ${snapshot.height}` : '—',
        ),
        metaRow(
          '帧率',
          snapshot?.fps
            ? `${formatFps(snapshot.fps)} fps`
            : snapshot?.probeError
              ? '未知（探测失败）'
              : '探测中…',
          {
            title: snapshot?.probeError
              ? probeFailureHint(snapshot.probeError)
              : 'ffprobe 读取的帧率与时长',
          },
        ),
        metaRow(
          '时长',
          snapshot && snapshot.duration > 0 ? formatTimestamp(snapshot.duration) : '—',
          { title: '时间轴以最短一段为准' },
        ),
      );

      return el(
        'div',
        { class: 'video-ref' },
        el(
          'div',
          { class: 'video-chip-row' },
          chip({
            label: truncateFileName(fileName(path)),
            title: path,
            icon: 'film',
            disabled: busy,
            onClick: pick,
          }),
          button({
            label: '重选',
            size: 'sm',
            variant: 'quiet',
            disabled: busy,
            onClick: pick,
          }),
        ),
        meta,
        snapshot?.probeError
          ? el('p', { class: 'video-hint', text: probeFailureHint(snapshot.probeError) })
          : null,
      );
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
