// 应用内模态卡片的共享实现（review 修复 F9）。
//
// 为什么要有它：状态全文卡片（src/main.ts 的 openStatusCard）、删除确认卡片与跑分
// 提示 / 汇总卡片（src/image-queue-panel.ts）三处脚手架原本几乎逐行相同（源码注释里
// 自认「照抄」），任何一处改关闭逻辑（比如漏摘 keydown 监听）都得同步三遍。这里收成
// 一份最小接口，调用方只描述「标题 / 正文行 / 按钮 / 关闭后做什么」。
//
// 结构固定（**外观与类名是承诺，不许改**，截图比对依赖它）：
//   .settings-overlay 遮罩
//     └ .status-card（+ 调用方类名，如 queue-confirm-card / queue-notice-card）
//         ├ .status-card-head：<h2> 标题 + 头部附加按钮（如「复制全部」）+ ×
//         ├ .status-card-body：<pre>（等宽、可选中复制、限高滚动），正文按行拼接
//         └ .status-card-actions：调用方按钮（**空则不渲染这一行**，纯展示卡片保持原样）
//
// 关闭有三路：× 按钮 / 点遮罩本身 / Esc。三路都走同一个收口函数——先摘掉 document 上
// 的 keydown 监听，再移除遮罩，最后回调 onClose（防监听泄漏，且回调只触发一次）。

/** 卡片上的一个按钮。 */
export interface ModalCardButton {
  label: string;
  /** 按钮样式类，缺省 `settings-mini-btn`；主操作传 `settings-primary-btn`。 */
  className?: string;
  /**
   * 点击回调（拿到按钮本身，便于就地改文案，如「复制全部」→「已复制」）。
   *
   * 底部按钮的回调执行完卡片随即关闭；头部按钮只执行回调、不关卡片。
   */
  onClick?(button: HTMLButtonElement): void;
}

/** 打开一张应用内模态卡片所需的一切（调用方只描述语义，不碰脚手架）。 */
export interface ModalCardOptions {
  /** 卡片标题（头部 <h2>）。 */
  title: string;
  /** 正文行：按换行拼进 <pre>，保持可选中复制的等宽外观。 */
  lines: readonly string[];
  /** 底部按钮（缺省 / 空数组 = 不渲染底部按钮行）。 */
  actions?: readonly ModalCardButton[];
  /** 头部标题右侧、× 左侧的附加按钮（如「复制全部」）。 */
  headActions?: readonly ModalCardButton[];
  /** 面板附加类名（`status-card` 之后的第二段），保持既有外观不变。 */
  cardClassName?: string;
  /** 关闭后回调：三路关闭与主动 close 都走它，只调一次。 */
  onClose?(): void;
}

/** 打开后的句柄（需要程序化关闭时用；多数调用点靠三路关闭即可）。 */
export interface ModalCardHandle {
  /** 主动关闭（与 × / 点遮罩 / Esc 走同一条收口路径）。 */
  close(): void;
  /** 遮罩元素（调用方一般不直接用）。 */
  readonly overlay: HTMLDivElement;
}

function buildButton(spec: ModalCardButton): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = spec.className ?? 'settings-mini-btn';
  button.textContent = spec.label;
  return button;
}

/** 打开一张应用内模态卡片（DOM 挂到 body，关闭即销毁）。 */
export function openModalCard(options: ModalCardOptions): ModalCardHandle {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  const panel = document.createElement('div');
  panel.className = options.cardClassName
    ? `status-card ${options.cardClassName}`
    : 'status-card';

  let closed = false;
  /** 收口：先摘 keydown 监听再移除遮罩，最后回调（三路关闭共用，防监听泄漏）。 */
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    options.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  // ---------- 头部：标题 + 附加按钮 + × ----------
  const head = document.createElement('div');
  head.className = 'status-card-head';
  const heading = document.createElement('h2');
  heading.textContent = options.title;
  head.append(heading);
  for (const spec of options.headActions ?? []) {
    const button = buildButton(spec);
    button.addEventListener('click', () => spec.onClick?.(button));
    head.append(button);
  }
  const closeBtn = buildButton({ label: '×' });
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', close);
  head.append(closeBtn);

  // ---------- 正文：<pre> 等宽、可选中复制、限高滚动 ----------
  const body = document.createElement('pre');
  body.className = 'status-card-body';
  body.textContent = options.lines.join('\n');
  panel.append(head, body);

  // ---------- 底部按钮：空就不渲染这一行（纯展示卡片外观不变） ----------
  const actions = options.actions ?? [];
  if (actions.length > 0) {
    const actionsBox = document.createElement('div');
    actionsBox.className = 'status-card-actions';
    for (const spec of actions) {
      const button = buildButton(spec);
      // 底部按钮：先执行调用方语义，再由共享实现负责关闭（关闭不该每个调用点各写一遍）
      button.addEventListener('click', () => {
        spec.onClick?.(button);
        close();
      });
      actionsBox.append(button);
    }
    panel.append(actionsBox);
  }

  // 点遮罩本身才关：卡片内部的点击不冒到这里
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  overlay.append(panel);
  document.body.append(overlay);

  return { close, overlay };
}
