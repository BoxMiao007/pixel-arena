// 检视器分区「跑分图」：本轮参数变体与人工导入 / 一站式产物混在一张列表里。
//
// 一行 = 一张跑分图（已生成的文件），或一个还没生成的参数变体：
// - 普通图：文件名、大小、体积比、编码参数、状态（完成 / 跑分中 / 待跑分 / 失败）、移除；
// - 参数变体：摘要（如「JPEG q75」）+ 四态徽章；已生成的由它产出的那一行代表，
//   点名字就地展开编码器配置（与「高级选项」弹窗同一份实现），× 删除变体；
// - 右键已跑分的图 →「高级选项」：复制一份带参数副本的新变体并打开调参弹窗。
//
// 两类图不做分组隔离：排序、状态口径、移除交互一致；只有参数变体多一枚「高级」角标。

import { badge, button, iconButton, toolbar } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { formatRatio, formatSize } from '../../../core/format';
import { fileName, truncateFileName } from '../../../core/util';
import { isBusy, isPathRunning, touch } from '../../../core/store';
import { openMenu } from '../../../ui/overlay';
import type { CandidateImage } from '../../../core/model';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import {
  badgeText,
  entryForArtifact,
  judgeImageEntry,
  variantSummary,
  type ImageEntry,
} from '../logic/entries';
import { queueIdentityProbe } from '../logic/runtime';
import { candidatesStateFor } from '../session';
import {
  addParamVariant,
  dropOnCandidates,
  duplicateCandidateVariant,
  entryEditorDeps,
  pickCandidates,
  refreshRoundIdentity,
  removeCandidateAt,
  removeVariantAt,
  syncVariants,
  variantEntries,
} from '../actions';
import { openEntryEditorModal } from '../overlay/entry-editor-modal';
import { renderEntryEditor, type EntryEditorView } from '../overlay/entry-editor';
import { dropTarget, liveRoundOf, mountSection, paintBody } from './common';

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
  // 「完成」是最常见的状态（一轮几十张图就是几十个），给语义绿色会把失败与
  // 跑分中的信号淹没；完成态走中性色，颜色只留给需要动手看一眼的状态。
  return { text: '完成', kind: 'neutral' };
}

/** 四态 → 徽标语义色（与参数编辑区同一套）。scored 同「完成」，走中性。 */
const STATE_BADGE_KIND: Record<
  'unscored' | 'scored' | 'stale' | 'failed',
  'neutral' | 'ok' | 'info' | 'danger'
> = {
  unscored: 'neutral',
  scored: 'neutral',
  stale: 'info',
  failed: 'danger',
};

/** 一个参数变体的四态徽章文案与语义色（判定与编辑区同一份来源）。 */
function judgeOf(entry: ImageEntry): { text: string; kind: StatusKind } {
  const verdict = judgeImageEntry(entry, queueIdentityProbe());
  return { text: badgeText(verdict.state, verdict.reasons), kind: STATE_BADGE_KIND[verdict.state] };
}

/** 一个参数变体是否已经由本轮里的某张跑分图代表（快照里的产物还在列表里）。 */
function artifactOf(entry: ImageEntry, paths: ReadonlySet<string>): string | null {
  for (const record of entry.snapshot?.encoders ?? []) {
    if (paths.has(record.artifactPath)) return record.artifactPath;
  }
  return null;
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

    /** 当前展开变体的编辑视图（重建时复用同一实例，避免输入焦点丢在点击瞬间）。 */
    let editor: EntryEditorView | null = null;
    let editorEntryId: string | null = null;

    const closeEditor = (): void => {
      editor = null;
      editorEntryId = null;
    };

    const buildEditor = (entry: ImageEntry): EntryEditorView => {
      if (editor !== null && editorEntryId === entry.id) return editor;
      const view = renderEntryEditor(
        entry,
        entryEditorDeps(ctx.group.id, ctx.round.id, () => {
          state().version += 1;
          touch();
          render();
        }),
      );
      editor = view;
      editorEntryId = entry.id;
      return view;
    };

    const toggleEditor = (entry: ImageEntry): void => {
      const ui = state();
      ui.expanded = ui.expanded === entry.id ? null : entry.id;
      ui.version += 1;
      if (ui.expanded === null) closeEditor();
      render();
    };

    /** 右键已跑分的图：唯一菜单项「高级选项」（复制 + 调参）。 */
    const openAdvancedMenu = (anchor: HTMLElement, candidate: CandidateImage): void => {
      if (candidate.metrics === null || candidate.error !== null) return;
      openMenu(
        anchor,
        [
          {
            label: '高级选项',
            hint: '复制并调参',
            disabled: isBusy(),
            onSelect: () => {
              void duplicateCandidateVariant(ctx, candidate).then((entry) => {
                if (entry === null) return;
                openEntryEditorModal(
                  entry,
                  entryEditorDeps(ctx.group.id, ctx.round.id, () => {
                    state().version += 1;
                    touch();
                    render();
                  }),
                );
                state().version += 1;
                render();
              });
            },
          },
        ],
        { label: `${fileName(candidate.path)} 的操作` },
      );
    };

    /** 标识自举只做一次：读完重绘，避免变体因「还没读到标识」被误报「将重跑」。 */
    let identityReady = false;
    const ensureIdentity = (referencePath: string): void => {
      if (identityReady || referencePath === '') return;
      identityReady = true;
      void refreshRoundIdentity(referencePath).then(() => render());
    };

    const render = (): void => {
      const ui = state();
      // 同轮内增删跑分图只走 update()：ctx 是挂载快照，必须重取活数据（见 common.ts）
      const round = liveRoundOf(ctx);
      // 变体的原图永远跟随本轮（原图换了旧结果整体作废）
      syncVariants(ctx);
      const entries = variantEntries(ctx.group.id, round.id);
      if (entries.length > 0 && round.referencePath !== null) ensureIdentity(round.referencePath);
      const paths = new Set(round.candidates.map((candidate) => candidate.path));
      const pending = entries.filter((entry) => artifactOf(entry, paths) === null);
      const runningPaths = round.candidates
        .filter((candidate) => isPathRunning(candidate.path))
        .map((candidate) => candidate.path)
        .join('|');
      const entryKey = entries
        .map((entry) => `${entry.id}:${entry.encoders.length}:${variantSummary(entry)}`)
        .join('|');
      if (ui.expanded !== null && !entries.some((entry) => entry.id === ui.expanded)) {
        ui.expanded = null;
        closeEditor();
      }
      const key = [
        'candidates',
        ctx.round.id,
        round.candidates.length,
        ui.expanded ?? '',
        ui.version,
        runningPaths,
        round.referencePath === null ? 'noref' : 'ref',
        entryKey,
      ].join(':');

      paintBody(body, key, () => {
        const candidates = round.candidates;
        if (candidates.length === 0 && pending.length === 0) {
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
          // 变体产物用变体四态（参数改了 → 将重跑），普通图用候选行状态；
          // 正在跑分时以「跑分中」优先，别让用户以为可以再点一次。
          const own = owner === null ? null : judgeOf(owner);
          const status = candidateStatus(candidate, running);
          const label = running || own === null ? status.text : own.text;
          const kind = running || own === null ? status.kind : own.kind;
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
                  title: `${candidate.path}\n参数变体产物：点开调整编码器参数（改动即时生效）`,
                  attrs: { type: 'button', 'aria-expanded': String(ui.expanded === owner.id) },
                  on: {
                    click: () => toggleEditor(owner),
                  },
                });

          // 元信息：大小 / 体积比 / 编码参数（两行式的第二行，空项不占位）
          const metaItems: string[] = [formatSize(candidate.fileSize)];
          if (candidate.sizeRatio !== null) metaItems.push(formatRatio(candidate.sizeRatio));
          if (candidate.encodingParams) metaItems.push(candidate.encodingParams);
          // 只有已跑分且未失败的图才有「高级选项」；行尾给一个键盘可达的入口，
          // 右键菜单保留（鼠标用户顺手，但右键不是唯一路径）。
          const canOpenAdvanced = candidate.metrics !== null && candidate.error === null;

          const row = el(
            'div',
            { class: 'cand__row' },
            // 第一行：文件名 + 高级角标 + 右侧状态与移除
            el(
              'div',
              { class: 'cand__line' },
              nameNode,
              owner === null
                ? null
                : badge('高级', 'neutral', '这张图由参数变体生成：右键「高级选项」可复制一份再调参'),
              el('span', { class: 'cand__spacer' }),
              badge(label, kind, candidate.error ?? undefined),
              canOpenAdvanced
                ? iconButton({
                    label: `高级选项：${fileName(candidate.path)}`,
                    icon: 'more',
                    variant: 'quiet',
                    size: 'sm',
                    title: '高级选项（复制一份并调参）',
                    onClick: () => openAdvancedMenu(row, candidate),
                  })
                : null,
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
          );

          if (canOpenAdvanced) {
            row.addEventListener('contextmenu', (event) => {
              event.preventDefault();
              openAdvancedMenu(row, candidate);
            });
            row.title = '右键或点「更多」：高级选项（复制一份并调参）';
          }

          list.append(
            el(
              'div',
              {
                class: `cand${ui.expanded !== null && owner !== null && ui.expanded === owner.id ? ' cand--open' : ''}`,
              },
              row,
              ui.expanded !== null && owner !== null && ui.expanded === owner.id
                ? el('div', { class: 'cand__editor' }, buildEditor(owner).node)
                : null,
            ),
          );
        }

        // 还没生成的参数变体：混在列表尾部，同样可点开调参、可删除
        for (const entry of pending) {
          const { text, kind } = judgeOf(entry);
          const row = el(
            'div',
            { class: 'cand cand--variant' },
            el(
              'div',
              { class: 'cand__row' },
              el(
                'div',
                { class: 'cand__line' },
                el('button', {
                  class: 'cand__name cand__name--action',
                  text: `参数变体：${variantSummary(entry)}`,
                  title: '还没生成：点开调参数，点「生成并跑分」产出新图（永远编码本轮原图）',
                  attrs: { type: 'button', 'aria-expanded': String(ui.expanded === entry.id) },
                  on: { click: () => toggleEditor(entry) },
                }),
                badge('高级', 'neutral', '参数变体：图片 + 独立参数副本，不改变原条目'),
                el('span', { class: 'cand__spacer' }),
                badge(text, kind),
                iconButton({
                  label: `删除参数变体 ${variantSummary(entry)}`,
                  icon: 'trash',
                  variant: 'quiet',
                  size: 'sm',
                  disabled: isBusy(),
                  title: '删除这个参数变体（磁盘上的产物文件保留）',
                  onClick: () => {
                    if (removeVariantAt(ctx, entry.id)) {
                      state().version += 1;
                      render();
                    }
                  },
                }),
              ),
              el('div', { class: 'cand__metas' }, [
                el('span', { class: 'cand__meta', text: '待生成' }),
                el('span', { class: 'cand__meta', text: '基于本轮原图' }),
              ]),
            ),
            ui.expanded !== null && ui.expanded === entry.id
              ? el('div', { class: 'cand__editor' }, buildEditor(entry).node)
              : null,
          );
          list.append(row);
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
            button({
              label: '＋ 新建参数变体',
              variant: 'secondary',
              title: '基于本轮原图新建一个带独立参数的变体（右键已跑分的图也能复制一份）',
              disabled: isBusy() || round.referencePath === null,
              onClick: () => {
                void addParamVariant(ctx).then((entry) => {
                  if (entry === null) return;
                  openEntryEditorModal(
                    entry,
                    entryEditorDeps(ctx.group.id, ctx.round.id, () => {
                      state().version += 1;
                      touch();
                      render();
                    }),
                  );
                  state().version += 1;
                  render();
                });
              },
            }),
            el('span', {
              class: 'source__count',
              text:
                pending.length === 0
                  ? `共 ${candidates.length} 张`
                  : `共 ${candidates.length} 张，另有 ${pending.length} 个变体待生成`,
            }),
          ),
          list,
        );
      });
    };

    render();
    return {
      update: render,
      destroy: () => {
        closeEditor();
        unregisterDrop();
      },
    };
  },
};
