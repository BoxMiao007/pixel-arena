// 「从原图新建编码」的编辑弹窗：只从本轮原图出发配编码器参数，
// 「完成」只关窗，改动早已落在会话态变体上（与就地编辑同一套即时生效语义）。
// 不再有「复制某张已跑分图的参数」这条路径：复制来源本身就是猜的，入口只留原图。
//
// 同一时间只允许一个编辑弹窗（按变体 id 去重）：重复触发（双击 / 连点菜单）不叠浮层。

import { el } from '../../../ui/dom';
import { button } from '../../../ui/primitives';
import { openModal } from '../../../ui/overlay';
import type { ImageEntry } from '../logic/entries';
import type { ImageEntryEditorDeps } from '../logic/runtime';
import { renderEntryEditor } from './entry-editor';

/** 当前打开的编辑弹窗对应的变体 id（null = 没开）。 */
let openFor: string | null = null;

/**
 * 打开某个参数变体的编辑弹窗。返回 false 表示同一个变体已经开着（不重复叠窗）。
 *
 * deps 与就地编辑同一份接线（entryEditorDeps），所以「改参数 → 徽章/按钮计数更新」
 * 在两个入口完全一致。
 */
export function openEntryEditorModal(entry: ImageEntry, deps: ImageEntryEditorDeps): boolean {
  if (openFor === entry.id) return false;
  openFor = entry.id;
  const view = renderEntryEditor(entry, deps);
  const footer = el(
    'div',
    { class: 'entry-modal__footer' },
    el('span', {
      class: 'entry-modal__hint',
      text: '改动即时生效：点「完成」关窗，点「生成并跑分」才会产出新图。',
    }),
    button({
      label: '完成',
      variant: 'primary',
      onClick: () => handle.close(),
    }),
  );
  const handle = openModal({
    title: '从原图新建编码',
    body: view.node,
    footer,
    width: 720,
    onClose: () => {
      if (openFor === entry.id) openFor = null;
    },
  });
  return true;
}
