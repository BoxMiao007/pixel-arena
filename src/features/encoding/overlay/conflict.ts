// 产物文件名冲突询问（T30 的模态版）：覆盖 / 跳过，可「应用到本次全部」。
//
// 协议与后端一致：回 conflict 时**未写入任何文件**；选「覆盖」由调用方带
// conflictDecision:"overwrite" 重调，「跳过」不再重调、该产物不生成也不进轮。
// 「本次全部」的边界由 ConflictSession 保证（一次跑分一个会话）。

import { el } from '../../../ui/dom';
import { openModal } from '../../../ui/overlay';
import { button } from '../../../ui/primitives';
import type { ConflictAnswer } from '../logic/conflict';

/**
 * 弹冲突询问，resolve 用户的选择。
 *
 * 关闭路径（Esc / 点遮罩 / ×）一律按「跳过」处理：不覆盖任何磁盘文件是更安全的一侧。
 */
export function askConflictDialog(fileName: string): Promise<ConflictAnswer> {
  return new Promise<ConflictAnswer>((resolve) => {
    let answer: ConflictAnswer = 'skip';
    const take = (value: ConflictAnswer): void => {
      answer = value;
      handle.close();
    };
    const body = el(
      'div',
      { class: 'conflict' },
      el('p', { class: 'conflict__line', text: fileName }),
      el('p', {
        class: 'conflict__hint',
        text: '产物目录（原图旁的 Pixel Arena 文件夹）里已有同名文件。覆盖会替换磁盘上的这个文件；跳过则这一项不生成，也不计入本次结果。',
      }),
    );
    const footer = el(
      'div',
      { class: 'conflict__actions' },
      button({ label: '跳过', variant: 'secondary', onClick: () => take('skip') }),
      button({ label: '跳过全部', variant: 'quiet', onClick: () => take('skip-all') }),
      el('div', { class: 'conflict__spacer' }),
      button({ label: '覆盖', variant: 'primary', onClick: () => take('overwrite') }),
      button({ label: '覆盖全部', variant: 'danger', onClick: () => take('overwrite-all') }),
    );
    const handle = openModal({
      title: '文件名冲突',
      body,
      footer,
      width: 520,
      onClose: () => resolve(answer),
    });
  });
}
