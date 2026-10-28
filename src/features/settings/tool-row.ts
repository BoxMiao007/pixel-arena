// 工具状态行（FFmpeg 与每个编码器共用）：徽标 + 版本 + 实际生效路径 + 中文补全。
//
// 就地更新而非重建：探测结果回来、重新检测、下载完成都走 update()，徽标换色换字、
// 路径换文本，行内的节点身份不变（不会有闪烁，也不会丢焦点以外的状态）。
// 「实际生效路径」是本次重构补上的信息：后端一直有 effectivePath，旧面板从不显示，
// 用户因此无法确认自己到底在用哪个可执行文件。
//
// Windows 的扩展长度路径（反斜杠反斜杠问号反斜杠 开头）是后端合法输入，直接铺在
// 界面上只会让人以为是乱码——展示时剥掉前缀。判定用 charCode，避免源码里堆转义。

import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { badge } from '../../ui/primitives';
import type { ToolView } from './model';

export interface ToolRowOptions {
  /** 行首名称（可选；默认不显示——多数场景下方路径字段的标签已经说明了是哪个工具）。 */
  name?: string;
  /** 行尾操作入口（可选，按传入顺序排列；发布页图标固定排在这些入口之后）。 */
  actions?: readonly HTMLElement[];
}

export interface ToolRowHandle {
  node: HTMLElement;
  update(view: ToolView): void;
}

/**
 * 去掉 Windows 扩展长度前缀（反斜杠 反斜杠 问号 反斜杠，共四个字符）。
 *
 * 注：`\\?\UNC\server\share` 这种形式按本实现只会剩 `UNC\server\share`；编码器与
 * FFmpeg 的可执行路径不会跑到 UNC 前缀上，先不额外处理（改成 `\\server\share`
 * 需要重新拼两个反斜杠，收益为零）。
 */
export function displayPath(raw: string): string {
  const isExtended =
    raw.length > 4 &&
    raw.charCodeAt(0) === 92 &&
    raw.charCodeAt(1) === 92 &&
    raw[2] === '?' &&
    raw.charCodeAt(3) === 92;
  return isExtended ? raw.slice(4) : raw;
}

/** 一行的 DOM。首次 update 之前先按 loading 态建好骨架。 */
export function toolRow(initial: ToolView, options: ToolRowOptions = {}): ToolRowHandle {
  let badgeNode = badge(initial.badgeText, initial.badgeKind);
  let badgeKey = `${initial.badgeKind}|${initial.badgeText}`;

  const nameNode = options.name
    ? el('span', { class: 'settings__tool-name truncate', text: options.name, title: options.name })
    : null;

  const version = el('span', { class: 'settings__tool-version' });

  // 官方发布页：只有后端给了 https 地址才出现（白名单在 model 层过）。
  // 用 <a target=_blank> 而非 window.open：Tauri 的 opener 插件拦的就是这个，
  // 点击会交给系统浏览器，不会在应用窗口里导航。
  const release = el(
    'a',
    {
      class: 'icon-btn icon-btn--bordered',
      attrs: {
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': '打开官方发布页',
      },
      title: '从官方发布页下载可执行文件，再把路径填到下面的输入框',
    },
    icon('external'),
  );

  const pill = el('span', { class: 'settings__tool-pill' }, badgeNode, version);
  const head = el(
    'div',
    { class: 'settings__tool-head' },
    nameNode,
    pill,
    el('span', { class: 'settings__tool-spacer' }),
    ...(options.actions ?? []),
    release,
  );
  const path = el('div', { class: 'settings__tool-path mono truncate' });
  const note = el('div', { class: 'settings__tool-note' });
  const node = el('div', { class: 'settings__tool' }, head, path, note);

  const update = (view: ToolView): void => {
    const key = `${view.badgeKind}|${view.badgeText}`;
    if (key !== badgeKey) {
      const next = badge(view.badgeText, view.badgeKind);
      pill.replaceChild(next, badgeNode);
      badgeNode = next;
      badgeKey = key;
    }
    version.textContent = view.version;
    version.hidden = view.version === '';

    const shownPath = displayPath(view.effectivePath);
    path.textContent = shownPath === '' ? '无生效路径' : shownPath;
    path.title = shownPath;
    path.classList.toggle('is-empty', shownPath === '');

    note.textContent = view.note;
    note.hidden = view.note === '';

    if (view.releaseUrl === null) {
      release.removeAttribute('href');
      release.hidden = true;
    } else {
      release.href = view.releaseUrl;
      release.hidden = false;
    }
  };

  update(initial);
  return { node, update };
}
