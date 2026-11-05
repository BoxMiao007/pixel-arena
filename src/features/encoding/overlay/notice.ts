// 提示 / 汇总卡片（票 #79 的复用版）：标题 + 正文行 + 可选的「详情块」，一个「知道了」。
//
// 走 ui/overlay 的模态（焦点捕获 / Esc / 点遮罩关闭、焦点还原都是它的事），
// 本模块只决定正文结构——列表逐行可读，不再把 N 条塞进一句。
//
// 详情块（detail）用于失败原因这类「原文」内容：给一块带底色的可选中区域，
// 配一个复制按钮。原文往往几十行、还带路径与换行，塞进列表既难读也没法只挑一段。

import { copyText } from '../../../core/util';
import { el } from '../../../ui/dom';
import { openModal } from '../../../ui/overlay';
import { button } from '../../../ui/primitives';
import { toast } from '../../../ui/toast';

/** 卡片正文里的原文详情块（失败原因等）。 */
export interface NoticeDetail {
  /** 原文（保留换行，整块可选中复制）。 */
  text: string;
  /** 复制按钮文案，缺省「复制」。 */
  copyLabel?: string;
}

export interface NoticeOptions {
  detail?: NoticeDetail;
}

/** 打开提示卡片：title + 正文行（第一行为摘要，其余逐条列出）。 */
export function showNoticeCard(
  title: string,
  lines: readonly string[],
  options: NoticeOptions = {},
): void {
  const [headline, ...rest] = lines;
  const detail = options.detail;
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
    detail
      ? el(
          'div',
          { class: 'notice__detail-wrap' },
          el('pre', {
            class: 'notice__detail',
            text: detail.text,
            // 可聚焦：键盘用户也能选中并用浏览器菜单复制；pre 本身保留原文换行。
            attrs: { tabindex: '0', 'aria-label': '失败原因（可选中复制）' },
          }),
        )
      : null,
  );
  const footer = el(
    'div',
    { class: 'notice__footer' },
    detail
      ? button({
          // 与「知道了」同为默认尺寸（同高同内边距）：两个按钮并排时不能一大一小。
          label: detail.copyLabel ?? '复制',
          variant: 'secondary',
          title: '把这段原因的完整原文复制到剪贴板',
          onClick: () => copyText(detail.text, () => toast('已复制失败原因', 'ok')),
        })
      : null,
    button({ label: '知道了', variant: 'primary', onClick: () => handle.close() }),
  );
  const handle = openModal({ title, body, footer, width: 560 });
}
