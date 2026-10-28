// 图片条目队列（模态）：完整工作流分两步，不再一屏塞满。
//
// 第 1 步「条目列表」：添加图片（多选直接入列）/ 四态徽章 / 重复提示 / 删除（确认）/
//                     底部「跑分（N 张）」——只跑改过的，已跑分且无变更的整张跳过。
// 第 2 步「编辑这张图」：逐图参数编辑（与候选分区的就地编辑同一份实现）。
//
// 模态只承担「需要聚焦的完整流程」；日常的单张调参在检视器的候选分区就地完成。
// 关掉模态 = 没跑过就工作区零变更（条目与参数只存在会话态）。

import { el } from '../../../ui/dom';
import { openModal } from '../../../ui/overlay';
import { badge, button, emptyState, iconButton } from '../../../ui/primitives';
import { confirm } from '../../../ui/overlay';
import {
  badgeText,
  duplicateEntryIds,
  imageQueueFor,
  judgeEntries,
  planScore,
  type ImageEntry,
  type ImageEntryState,
  type RoundSummary,
} from '../logic/entries';
import { scoreButtonLabel } from '../logic/run';
import { queueIdentityProbe } from '../logic/runtime';
import { planDelete } from '../logic/queue-plan';
import type { ImageEntryEditorDeps } from '../logic/runtime';
import { renderEntryEditor, type EntryEditorView } from './entry-editor';

/** 四态 → 徽标语义色（与就地面板同一套）。 */
export const STATE_BADGE_KIND: Record<ImageEntryState, 'neutral' | 'ok' | 'info' | 'danger'> = {
  unscored: 'neutral',
  scored: 'ok',
  stale: 'info',
  failed: 'danger',
};

/** 模态对宿主的需求（全部由 actions 注入，模态自己不碰 IPC）。 */
export interface QueueModalActions {
  /** 多选添加图片，返回实际加入的张数。 */
  pickImages(): Promise<number>;
  /** 跑一次增量计划（只跑改过的）。 */
  runPlan(): Promise<void>;
  /** 删除条目（连带删轮），调用方落库。 */
  deleteEntry(entry: ImageEntry): Promise<void>;
  /** 逐图编辑依赖（与候选分区同一份接线）。 */
  editorDeps(entry: ImageEntry, onChanged: () => void): ImageEntryEditorDeps;
  describeRound(roundId: string): RoundSummary | null;
  isBusy(): boolean;
  setStatus(text: string, isError?: boolean, detail?: string): void;
}

/** 模态实例标记：同一时间只允许一个队列模态（重复调用直接返回 false）。 */
let queueModalOpen = false;

/** 打开条目队列（同一时间只允许一个实例；重复调用返回 false）。 */
export function openQueueModal(groupId: string, actions: QueueModalActions): boolean {
  if (queueModalOpen) return false;
  queueModalOpen = true;
  const session = imageQueueFor(groupId);
  let running = false;
  let stopEditor: (() => void) | null = null;

  const body = el('div', { class: 'queue' });
  const footer = el('div', { class: 'queue__footer' });

  const handle = openModal({
    title: '图片条目',
    body,
    footer,
    width: 760,
    onClose: () => {
      queueModalOpen = false;
      stopEditor?.();
      stopEditor = null;
    },
  });

  void handle;

  const currentPlan = () => planScore(session.entries, queueIdentityProbe());

  // ---------- 第 1 步：列表 ----------
  const renderList = (): void => {
    stopEditor?.();
    stopEditor = null;
    body.replaceChildren();
    const entries = session.entries;

    body.append(
      el(
        'div',
        { class: 'queue__toolbar' },
        button({
          label: '＋ 添加图片',
          variant: 'primary',
          onClick: () => void addImages(),
          disabled: running || actions.isBusy(),
        }),
        el('span', {
          class: 'queue__count',
          text: entries.length === 0 ? '还没有条目' : `共 ${entries.length} 张`,
        }),
      ),
    );

    if (entries.length === 0) {
      body.append(
        emptyState({
          title: '还没有图片条目',
          hint: '一张图片 = 一张原图 + 一套编码器配置，对应一个评测轮。添加后可直接跑分。',
          icon: 'image',
        }),
      );
    } else {
      const duplicates = duplicateEntryIds(entries);
      const verdicts = judgeEntries(entries, queueIdentityProbe());
      const list = el('div', { class: 'queue__list' });
      entries.forEach((entry, index) => {
        const verdict = verdicts[index];
        const name = el('button', {
          class: 'queue__name',
          text: entry.path.split(/[\\/]/).pop() ?? entry.path,
          title: `${entry.path}\n点开编辑这张图的编码器参数`,
          attrs: { type: 'button' },
          on: { click: () => openEditor(entry) },
        });
        const row = el(
          'div',
          { class: 'queue__row' },
          name,
          badge(badgeText(verdict.state, verdict.reasons), STATE_BADGE_KIND[verdict.state]),
          duplicates.has(entry.id)
            ? badge('重复图片', 'neutral', '同一路径在列表里出现了多次（允许：可对比两套参数）')
            : null,
          el('span', { class: 'queue__row-spacer' }),
          el('span', {
            class: 'queue__row-cards',
            text: `${entry.encoders.length} 条配置`,
          }),
          iconButton({
            label: `删除条目 ${entry.path}`,
            icon: 'trash',
            variant: 'quiet',
            size: 'sm',
            disabled: running || actions.isBusy(),
            onClick: () => void deleteEntry(entry),
          }),
        );
        list.append(row);
      });
      body.append(list);
    }
    renderFooter();
  };

  // ---------- 第 2 步：逐图编辑 ----------
  const openEditor = (entry: ImageEntry): void => {
    if (running || actions.isBusy()) return;
    stopEditor?.();
    body.replaceChildren();
    const view: EntryEditorView = renderEntryEditor(
      groupId,
      entry,
      actions.editorDeps(entry, () => renderListSoon()),
    );
    stopEditor = () => view.node.remove();
    body.append(
      el(
        'div',
        { class: 'queue__step-head' },
        button({ label: '← 返回列表', variant: 'quiet', size: 'sm', onClick: () => renderList() }),
        el('span', { class: 'queue__step-title', text: '编辑这张图' }),
      ),
      view.node,
    );
    renderFooter();
  };

  /** 在编辑器里改完参数：只刷列表与按钮计数，不跳步。 */
  let refreshTimer: number | null = null;
  const renderListSoon = (): void => {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      renderFooter();
    }, 0);
  };

  // ---------- 底部：跑分 ----------
  const renderFooter = (): void => {
    const plan = currentPlan();
    footer.replaceChildren(
      el('span', {
        class: 'queue__hint',
        text:
          plan.runImageCount === 0
            ? '没有改过的条目：跑分会跳过全部已跑分的图'
            : `本次跑分 ${plan.runImageCount} 张，跳过 ${plan.skippedImageCount} 张`,
      }),
      el('div', { class: 'queue__spacer' }),
      button({
        label: running ? '跑分中…' : scoreButtonLabel(plan, session.entries),
        variant: 'primary',
        disabled: running || actions.isBusy() || session.entries.length === 0,
        title: '只跑改过的：已跑分且无变更的图跳过并沿用上一轮结果',
        onClick: () => void runPlan(),
      }),
    );
  };

  // ---------- 动作 ----------
  const addImages = async (): Promise<void> => {
    if (running || actions.isBusy()) return;
    try {
      const added = await actions.pickImages();
      if (added === 0) return;
    } catch (err) {
      actions.setStatus(`选择图片失败：${String(err)}`, true);
      return;
    }
    renderList();
  };

  const deleteEntry = async (entry: ImageEntry): Promise<void> => {
    if (running || actions.isBusy()) return;
    const info = entry.roundId === null ? null : actions.describeRound(entry.roundId);
    const plan = planDelete(entry, info);
    if (!(await confirm({ title: '删除图片条目', message: plan.message, confirmLabel: '删除', danger: true }))) {
      return;
    }
    await actions.deleteEntry(entry);
    renderList();
  };

  const runPlan = async (): Promise<void> => {
    if (running || actions.isBusy()) return;
    running = true;
    renderList();
    try {
      await actions.runPlan();
    } finally {
      running = false;
      renderList();
    }
  };

  renderList();
  return true;
}
