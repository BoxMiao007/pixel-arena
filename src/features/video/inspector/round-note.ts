// 检视器分区「本轮备注」：把 round.note 显示出来（图片组与视频组共用）。
//
// 视频高级创建确认后会把「配置摘要 + 每项命令行」写进新轮的 round.note；这是这份
// 配置在界面上的唯一常驻出口（旧实现在 main.ts 的轮头部直接渲染）。图片组的轮备注
// 同样走这里展示。
//
// 规则（票面验收）：
// - 备注为空：分区整体不出现（不占一行标题），不是显示一个空分区；
// - 非空：等宽 / 预格式化文本；超过 6 行时默认只展示前 6 行，其余折叠进 <details>；
// - 可复制完整备注；折叠态按分区 id 持久化（界面偏好）。

import { getState, subscribe } from '../../../core/store';
import { copyText } from '../../../core/util';
import type { MountedView, ViewCtx } from '../../../shell/registry';
import { el } from '../../../ui/dom';
import { button, section } from '../../../ui/primitives';
import { toast } from '../../../ui/toast';
import { noteLayout, type NoteLayout } from '../advanced/note';
import { persistSectionOpen, sectionOpen } from './shared';

const SECTION_ID = 'round-note';

/** 读当前轮的最新备注（后端是唯一真源；分区只在 note 变化时重建）。 */
function roundNote(groupId: string, roundId: string): string | null {
  const workspace = getState().workspace;
  const group = workspace?.groups.find((item) => item.id === groupId);
  return group?.rounds.find((item) => item.id === roundId)?.note ?? null;
}

function noteSection(layout: NoteLayout): HTMLElement {
  const copyButton = button({
    label: '复制',
    variant: 'quiet',
    size: 'sm',
    icon: 'copy',
    title: '复制完整轮备注',
    onClick: () => copyText(layout.full, () => toast('已复制本轮备注', 'ok')),
  });

  const children: HTMLElement[] = [
    el('pre', { class: 'round-note__text', text: layout.head.join('\n') }),
  ];
  if (layout.folded) {
    children.push(
      el(
        'details',
        { class: 'round-note__details' },
        el('summary', {
          class: 'round-note__summary',
          text: `展开全部（共 ${layout.totalLines} 行）`,
        }),
        el('pre', {
          class: 'round-note__text round-note__text--rest',
          text: layout.rest.join('\n'),
        }),
      ),
    );
  }

  return section(
    {
      id: SECTION_ID,
      title: '本轮备注',
      collapsible: true,
      open: sectionOpen(SECTION_ID),
      onToggle: (open) => persistSectionOpen(SECTION_ID, open),
      actions: copyButton,
    },
    ...children,
  ).node;
}

export function mountRoundNoteSection(host: HTMLElement, ctx: ViewCtx): MountedView {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;
  const container = el('div');
  host.replaceChildren(container);

  /** 上一次渲染的备注原文；相同就跳过（保留折叠区与选择，不无谓重建）。 */
  let rendered: string | null | undefined;

  const update = (): void => {
    const note = roundNote(groupId, roundId);
    if (note === rendered) return;
    rendered = note;
    const layout = noteLayout(note);
    // 空备注：分区整体消失，不占一行标题
    if (!layout) {
      container.replaceChildren();
      return;
    }
    container.replaceChildren(noteSection(layout));
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
