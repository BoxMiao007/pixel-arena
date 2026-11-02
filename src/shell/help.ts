// 快捷键帮助：一屏可扫读的分组表，不写成说明书。

import { el } from '../ui/dom';
import { openModal } from '../ui/overlay';
import { registerCommand } from './registry';

interface ShortcutRow {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: '全局',
    rows: [
      { keys: ['Ctrl', 'N'], label: '新建评测轮' },
      { keys: ['Ctrl', 'Shift', 'N'], label: '新建跑分组' },
      { keys: ['Ctrl', 'O'], label: '选择原图 / 原视频' },
      { keys: ['Ctrl', 'Shift', 'O'], label: '添加跑分图 / 跑分视频' },
      { keys: ['Ctrl', 'Enter'], label: '开始跑分' },
      { keys: ['Ctrl', 'E'], label: '导出报告' },
      { keys: ['Ctrl', ','], label: '设置' },
      { keys: ['Ctrl', 'B'], label: '折叠或展开跑分组栏' },
      { keys: ['Ctrl', 'I'], label: '折叠或展开检视器' },
      { keys: ['Ctrl', 'J'], label: '折叠或展开结果坞' },
      { keys: ['Ctrl', '1…9'], label: '切换到第 N 个跑分组' },
      { keys: ['F'], label: '沉浸模式（只看画面）' },
      { keys: ['Esc'], label: '关闭浮层 / 退出沉浸模式' },
      { keys: ['?'], label: '打开这份帮助' },
    ],
  },
  {
    title: '对比查看器',
    rows: [
      { keys: ['1…6'], label: '分屏 / 滑动 / 叠加 / 差异 / 闪烁 / 多视图' },
      { keys: ['空格'], label: '闪烁对比开关' },
      { keys: ['+', '−'], label: '放大 / 缩小' },
      { keys: ['0'], label: '适应窗口' },
      { keys: ['Shift', '0'], label: '原始像素（100%）' },
      { keys: ['方向键'], label: '平移画面' },
      { keys: ['双击'], label: '复位到适应窗口' },
    ],
  },
  {
    title: '视频对比',
    rows: [
      { keys: ['←', '→'], label: '逐帧步进' },
      { keys: ['Shift', '←/→'], label: '步进 10 帧' },
      { keys: ['Home', 'End'], label: '跳到首帧 / 末帧' },
      { keys: ['空格'], label: '播放 / 暂停' },
      { keys: ['1', '2', '3'], label: '分屏 / 滑动 / 网格' },
      { keys: ['+', '−'], label: '放大 / 缩小' },
      { keys: ['0'], label: '适应窗口' },
    ],
  },
];

let open = false;

/** 打开快捷键帮助（同名命令供顶栏按钮与 ? 键调用）。 */
export function openShortcutsHelp(): void {
  if (open) return;
  open = true;
  const body = el('div', { class: 'shortcuts' });
  for (const group of GROUPS) {
    const rows = el(
      'div',
      { class: 'shortcuts__rows' },
      ...group.rows.map((row) =>
        el(
          'div',
          { class: 'shortcuts__row' },
          el(
            'span',
            { class: 'shortcuts__keys' },
            ...row.keys.flatMap((key, index) => [
              index > 0
                ? el('span', {
                    class: 'shortcuts__plus',
                    text: '+',
                    attrs: { 'aria-hidden': 'true' },
                  })
                : null,
              el('kbd', { class: 'kbd', text: key }),
            ]),
          ),
          el('span', { class: 'shortcuts__label', text: row.label }),
        ),
      ),
    );
    body.append(el('h3', { class: 'shortcuts__title', text: group.title }), rows);
  }

  openModal({
    title: '快捷键',
    body,
    width: 560,
    onClose: () => {
      open = false;
    },
  });
}

registerCommand({ id: 'open-help', run: openShortcutsHelp });
