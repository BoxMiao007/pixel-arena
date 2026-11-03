// 「判断徽标」的小胶囊：结果表、检视器列表、多视图格子角上共用一套视觉。
//
// 徽标判定（谁拿哪顶帽子）在 core/highlight.ts；这里只管怎么画，保证三处不各写一份
// 颜色/尺寸。颜色只用来区分种类（画质 / 体积 / 综合），文案本身已经写明结论，
// 不依赖颜色也能读懂。

import type { HighlightChip, HighlightKind } from '../core/highlight';
import { el } from './dom';
import { badge } from './primitives';

const KIND_TONE: Record<HighlightKind, 'accent' | 'ok' | 'info'> = {
  // 综合最优是最常被找的那顶帽子，给主强调色；画质 / 体积用两种次级语义色区分。
  balanced: 'accent',
  quality: 'ok',
  size: 'info',
};

export type HighlightChipSize = 'sm' | 'md';

/** 一枚判断徽标：短文案 + 悬浮说明（说明里带具体数值）。 */
export function highlightChip(chip: HighlightChip, size: HighlightChipSize = 'sm'): HTMLElement {
  const node = badge(chip.label, KIND_TONE[chip.kind], chip.detail);
  node.classList.add('pick-chip');
  if (size === 'md') node.classList.add('pick-chip--md');
  return node;
}

/** 一组判断徽标（没有时返回 null，调用处不用判空）。 */
export function highlightChipList(
  chips: readonly HighlightChip[] | undefined,
  size: HighlightChipSize = 'sm',
): HTMLElement | null {
  if (!chips || chips.length === 0) return null;
  return el(
    'span',
    { class: 'pick-chips' },
    ...chips.map((chip) => highlightChip(chip, size)),
  );
}
