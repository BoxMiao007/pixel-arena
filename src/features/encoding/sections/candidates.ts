// 检视器分区「跑分图」：已选跑分图的清单 + 就地参数编辑。
//
// 一行 = 一张跑分图：文件名、大小、体积比、编码参数、状态（完成 / 跑分中 / 待跑分 / 失败）、
// 移除。由图片条目产出的图，点文件名就地展开它的编码器配置（与队列模态第 2 步同一份
// 实现）；人工导入 / 一站式生成的图没有可调参数，只说明为什么点不开（不给假交互）。

import { badge, button, iconButton, toolbar } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { isPathRunning } from '../../../core/store';
import { formatRatio, formatSize } from '../../../core/format';
import { fileName, truncateFileName } from '../../../core/util';
import { isBusy } from '../../../core/store';
import type { CandidateImage } from '../../../core/model';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import { entryForArtifact, type ImageEntry } from '../logic/entries';
import { candidatesStateFor } from '../session';
import {
  dropOnCandidates,
  entryEditorDeps,
  pickCandidates,
  queueEntries,
  removeCandidateAt,
} from '../actions';
import { renderEntryEditor, type EntryEditorView } from '../overlay/entry-editor';
import { dropTarget, mountSection, paintBody } from './common';

type StatusKind = 'ok' | 'danger' | 'info' | 'neutral';

/** 一张跑分图的行内状态（与结果坞同一口径：失败 > 跑分中 > 待跑分 > 完成）。 */
export function candidateStatus(
  candidate: CandidateImage,
  running: boolean,
): { text: string; kind: StatusKind; title?: string } {
  if (candidate.error !== null) {
    return { text: '失败', kind: 'danger', title: candidate.error };
  }
  if (running) return { text: '跑分中', kind: 'info' };
  if (candidate.metrics === null) return { text: '待跑分', kind: 'neutral' };
  return { text: '完成', kind: 'ok' };
}

export const candidatesSection: PanelSection = {
  id: 'candidates',
  title: '跑分图',
  order: 20,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const state = () => candidatesStateFor(ctx.round.id);
    const { body } = mountSection(host, { id: 'candidates', title: '跑分图' });
    const unregisterDrop = dropTarget(body, {
      id: 'encoding-candidates',
      accept: 'image',
      hint: '松开：添加为跑分图',
      onDrop: (paths) => void dropOnCandidates(ctx, paths),
      disabled: () => isBusy(),
    });

    /** 当前展开条目的编辑视图（重建时复用同一实例，避免输入焦点丢在点击瞬间）。 */
    let editor: EntryEditorView | null = null;
    let editorEntryId: string | null = null;

    const closeEditor = (): void => {
      editor = null;
      editorEntryId = null;
    };

    const buildEditor = (entry: ImageEntry): EntryEditorView => {
      if (editor !== null && editorEntryId === entry.id) return editor;
      const view = renderEntryEditor(
        ctx.group.id,
        entry,
        entryEditorDeps(ctx.group.id, () => {
          state().version += 1;
          render();
        }),
      );
      editor = view;
      editorEntryId = entry.id;
      return view;
    };

    const render = (): void => {
      const ui = state();
      const entries = queueEntries(ctx.group.id);
      const runningPaths = ctx.round.candidates
        .filter((candidate) => isPathRunning(candidate.path))
        .map((candidate) => candidate.path)
        .join('|');
      const key = [
        'candidates',
        ctx.round.id,
        ctx.round.candidates.length,
        ui.expanded ?? '',
        ui.version,
        runningPaths,
        ctx.round.referencePath === null ? 'noref' : 'ref',
      ].join(':');

      paintBody(body, key, () => {
        const candidates = ctx.round.candidates;
        if (candidates.length === 0) {
          return el(
            'div',
            { class: 'source' },
            el('div', { class: 'enc-empty' }, [
              el('span', { class: 'enc-empty__text', text: '还没有跑分图' }),
              button({
                label: '添加跑分图',
                variant: 'secondary',
                size: 'sm',
                onClick: () => void pickCandidates(ctx),
              }),
              el('span', { class: 'enc-empty__hint', text: '或把图片拖到这里' }),
            ]),
          );
        }

        const list = el('div', { class: 'cand-list' });
        for (const candidate of candidates) {
          const owner = entryForArtifact(entries, candidate.path);
          const running = isPathRunning(candidate.path);
          const status = candidateStatus(candidate, running);
          const nameNode =
            owner === null
              ? el('span', {
                  class: 'cand__name',
                  text: truncateFileName(fileName(candidate.path)),
                  title: `${candidate.path}\n人工导入或自动生成的跑分图：没有可调的编码器参数`,
                })
              : el('button', {
                  class: 'cand__name cand__name--action',
                  text: truncateFileName(fileName(candidate.path)),
                  title: `${candidate.path}\n点开调整这张图的编码器参数（改动即时生效）`,
                  attrs: { type: 'button', 'aria-expanded': String(ui.expanded === owner.id) },
                  on: {
                    click: () => {
                      ui.expanded = ui.expanded === owner.id ? null : owner.id;
                      ui.version += 1;
                      if (ui.expanded === null) closeEditor();
                      render();
                    },
                  },
                });

          // 元信息：大小 / 体积比 / 编码参数（两行式的第二行，空项不占位）
          const metaItems: string[] = [formatSize(candidate.fileSize)];
          if (candidate.sizeRatio !== null) metaItems.push(formatRatio(candidate.sizeRatio));
          if (candidate.encodingParams) metaItems.push(candidate.encodingParams);

          list.append(
            el(
              'div',
              {
                class: `cand${ui.expanded !== null && owner !== null && ui.expanded === owner.id ? ' cand--open' : ''}`,
              },
              el(
                'div',
                { class: 'cand__row' },
                // 第一行：文件名 + 右侧状态与移除
                el(
                  'div',
                  { class: 'cand__line' },
                  nameNode,
                  el('span', { class: 'cand__spacer' }),
                  badge(status.text, status.kind, status.title),
                  iconButton({
                    label: `移除 ${fileName(candidate.path)}`,
                    icon: 'close',
                    variant: 'quiet',
                    size: 'sm',
                    title: '从本轮移除这张跑分图（磁盘文件保留）',
                    onClick: () => void removeCandidateAt(ctx, candidate.path),
                  }),
                ),
                // 第二行：元信息，极细分隔线分项（不用中点）
                el(
                  'div',
                  { class: 'cand__metas' },
                  ...metaItems.map((text) => el('span', { class: 'cand__meta', text })),
                ),
              ),
              ui.expanded !== null && owner !== null && ui.expanded === owner.id
                ? el('div', { class: 'cand__editor' }, buildEditor(owner).node)
                : null,
            ),
          );
        }

        return el(
          'div',
          { class: 'source' },
          toolbar(
            button({
              label: '添加跑分图',
              variant: 'secondary',
              onClick: () => void pickCandidates(ctx),
            }),
            el('span', { class: 'source__count', text: `共 ${candidates.length} 张` }),
          ),
          list,
        );
      });
    };

    // 展开项指向已删除的条目时清掉，避免下次渲染找不到 owner
    const prune = (): void => {
      const ui = state();
      if (ui.expanded === null) return;
      if (!queueEntries(ctx.group.id).some((entry) => entry.id === ui.expanded)) {
        ui.expanded = null;
        closeEditor();
      }
    };

    render();
    return {
      update: () => {
        prune();
        render();
      },
      destroy: () => {
        closeEditor();
        unregisterDrop();
      },
    };
  },
};
