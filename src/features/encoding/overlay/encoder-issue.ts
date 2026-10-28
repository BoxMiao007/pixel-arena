// 编码器未就绪卡片（决策 0025）：缺失时给「打开设置」与发布页链接，不让 N 项各自失败一遍。
//
// 文案里的逐条原因来自后端 ToolStatus.hint（中文，含官方发布页 URL），这里只做排版与
// 动作，不改写原因——单一数据源在核心库。

import { el } from '../../../ui/dom';
import { openModal } from '../../../ui/overlay';
import { button } from '../../../ui/primitives';
import { copyText } from '../../../core/util';

export interface EncoderIssueInfo {
  keys: string[];
  message: string;
  releasePages: string[];
}

/** 弹「编码器未就绪」：正文逐条列出原因，底部给设置入口与复制链接。 */
export function showEncoderIssueCard(issue: EncoderIssueInfo, onOpenSettings: () => void): void {
  const [first, ...rest] = issue.message.split('\n');
  const body = el(
    'div',
    { class: 'issue' },
    el('p', { class: 'issue__lead', text: first }),
    rest.length > 0
      ? el(
          'ul',
          { class: 'issue__list' },
          ...rest.map((line) => el('li', { class: 'issue__item', text: line })),
        )
      : null,
    issue.releasePages.length > 0
      ? el('p', { class: 'issue__pages', text: issue.releasePages.join('\n') })
      : null,
  );
  const footer = el(
    'div',
    { class: 'issue__actions' },
    issue.releasePages.length > 0
      ? button({
          label: '复制发布页链接',
          variant: 'quiet',
          onClick: () => copyText(issue.releasePages.join('\n'), () => undefined),
        })
      : null,
    button({ label: '稍后再说', variant: 'secondary', onClick: () => handle.close() }),
    button({
      label: '打开设置',
      variant: 'primary',
      onClick: () => {
        handle.close();
        onOpenSettings();
      },
    }),
  );
  const handle = openModal({ title: '编码器未就绪', body, footer, width: 560 });
}
