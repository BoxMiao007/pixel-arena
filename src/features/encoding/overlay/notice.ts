// 提示 / 汇总卡片（票 #79 的复用版）：正文按行渲染，一个「知道了」。
//
// 走 ui/overlay 的模态（焦点捕获 / Esc / 点遮罩关闭、焦点还原都是它的事），
// 本模块只决定正文结构——列表逐行可读，不再把 N 条塞进一句。

import { el } from '../../../ui/dom';
import { openModal } from '../../../ui/overlay';
import { button } from '../../../ui/primitives';

/** 打开提示卡片：title + 正文行（第一行为摘要，其余逐条列出）。 */
export function showNoticeCard(title: string, lines: readonly string[]): void {
  const [headline, ...rest] = lines;
  const body = el(
    'div',
    { class: 'notice' },
    headline ? el('p', { class: 'notice__headline', text: headline }) : null,
    rest.length > 0
      ? el(
          'ul',
          { class: 'notice__list' },
          ...rest.map((line) => el('li', { class: 'notice__item', text: line })),
        )
      : null,
  );
  const footer = el(
    'div',
    { class: 'notice__footer' },
    button({ label: '知道了', variant: 'primary', onClick: () => handle.close() }),
  );
  const handle = openModal({ title, body, footer, width: 520 });
}
