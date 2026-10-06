// 胶囊组件（T18）：已选文件以胶囊标签展示——原图/原视频为单选胶囊（点击替换，
// 走既有覆盖语义）、跑分图/跑分视频为多选胶囊（每颗带 × 单独移除）。
// 只管 DOM 构建与交互接线，不含状态：移除/替换都由调用方回调（经 IPC 回工作区）。
// T22 的编码格式/质量点胶囊复用同一套 API：onClick 做切换、onRemove 做移除。

export interface PillOptions {
  /** 胶囊可见文本（调用方先用 truncateFileName 截好，悬浮全名走 title） */
  label: string;
  /** 悬浮完整内容（全路径等）；缺省不设 title */
  title?: string;
  /** 点击胶囊本体的动作（单选胶囊=替换）。缺省则本体不可点。 */
  onClick?: () => void;
  /** × 移除动作；缺省不渲染 ×（原图/原视频胶囊点击即替换，不带 ×）。 */
  onRemove?: () => void;
  /** 置灰（跑分中等忙态），点击与移除都不响应 */
  disabled?: boolean;
  /** 追加样式类（如标记原图胶囊的 'pill-reference'） */
  extraClass?: string;
}

/** 建一颗胶囊。结构：.pill > .pill-label + 可选 .pill-remove(×)。 */
export function buildPill(options: PillOptions): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.className = `pill${options.extraClass ? ` ${options.extraClass}` : ''}`;
  if (options.title) pill.title = options.title;

  const label = document.createElement('span');
  label.className = 'pill-label';
  label.textContent = options.label;
  pill.append(label);

  if (options.onClick) {
    pill.classList.add('clickable');
    // 可点击胶囊对辅助技术暴露为按钮（at-spi/读屏可触发；× 是内嵌的真按钮元素）
    pill.role = 'button';
    pill.addEventListener('click', () => {
      if (!options.disabled) options.onClick!();
    });
  }
  if (options.disabled) pill.classList.add('pill-disabled');

  if (options.onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pill-remove';
    remove.textContent = '×';
    remove.title = '移除';
    remove.ariaLabel = `移除 ${options.label}`;
    remove.disabled = options.disabled === true;
    remove.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发胶囊本体的 onClick
      options.onRemove!();
    });
    pill.append(remove);
  }
  return pill;
}

/** 建一行胶囊容器（flex 自动换行），可选前置说明与批量填充。 */
export function buildPillList(
  pills: PillOptions[] = [],
  lead?: string,
  ariaLabel?: string,
): HTMLDivElement {
  const list = document.createElement('div');
  list.className = 'pill-list';
  if (ariaLabel) list.ariaLabel = ariaLabel;
  if (lead) {
    const leadEl = document.createElement('span');
    leadEl.className = 'pill-lead muted';
    leadEl.textContent = lead;
    list.append(leadEl);
  }
  for (const options of pills) list.append(buildPill(options));
  return list;
}
