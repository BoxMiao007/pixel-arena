// 失败说明卡片与「可点开的失败徽标」：把「上次失败」从一个只有颜色的死徽标变成入口。
//
// 为什么单独成文件：跑分图列表（sections/candidates.ts）与展开的编辑区
// （overlay/entry-editor.ts）都有同一枚失败徽标，两处必须弹同一张卡片、给同一份原因；
// 各自拼一遍文案，早晚会出现一处写了原因、另一处只剩「上次失败」。
//
// 数据口径全部来自 logic/entries.ts：entryFailures 已经过滤掉被删掉的卡，所以卡片里
// 不会出现「原因指向一张已经不存在的卡」这种对不上号的条目。

import { badge, type BadgeKind } from '../../../ui/primitives';
import { entryFailures, variantSummary, type ImageEntry } from '../logic/entries';
import { showNoticeCard } from './notice';

/** 失败说明卡片的标题（单一来源，测试与界面都从这里取）。 */
export const ENTRY_FAILURE_CARD_TITLE = '失败说明';

/**
 * 打开一个变体的失败说明：标题「失败说明」，首行点名是哪个变体，失败原因放进
 * 带底色的详情块（整块可选中、右上/底部可一键复制，也能只挑一段用浏览器菜单复制）。
 *
 * 没有有效失败记录时不弹：空卡片会让用户以为界面坏了（点开什么都没有），
 * 还不如什么都不发生。调用方（徽标）也只在有失败时才挂这个入口。
 */
export function showEntryFailureCard(entry: ImageEntry): void {
  const failures = entryFailures(entry);
  if (failures.length === 0) return;
  showNoticeCard(
    ENTRY_FAILURE_CARD_TITLE,
    [`参数变体：${variantSummary(entry)}`],
    { detail: { text: failures.map((failure) => `${failure.encoderId}：${failure.reason}`).join('\n') } },
  );
}

/** 可点开的失败徽标：外观沿用徽标，只把交互补成按钮。 */
export function failureBadge(
  entry: ImageEntry,
  text: string,
  kind: BadgeKind,
  detail?: string,
): HTMLElement {
  const title = detail === undefined || detail === '' ? '查看失败说明' : `查看失败说明：${detail}`;
  const node = badge(text, kind, title);
  node.classList.add('badge--action');
  // span 不是天然按钮：role / tabindex 与下面的 Enter、Space 处理缺一不可，
  // 否则键盘用户看得到徽标却打不开原因（鼠标用户与键盘用户的能力必须一致）。
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', `${text}：查看失败说明`);
  const open = (): void => showEntryFailureCard(entry);
  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Space 在页面上的默认动作是滚动：自绘按钮必须自己吃掉它，不然按一下页面就跳走
    event.preventDefault();
    open();
  });
  return node;
}
