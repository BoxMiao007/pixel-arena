// 图片右键菜单：另存为 / 打开图片 / 打开文件位置 / 复制路径。
//
// 三处入口共用同一份（查看器画布、检视器「跑分图」列表、结果表行），避免每个界面
// 各拼一套菜单项与错误提示。菜单本身只是动作列表，真实的文件操作在 Rust 侧：
// 打开/定位走 opener 插件，另存只是逐字节拷贝（不做格式转换，别让用户以为转码了）。
//
// 失败一律 toast 中文原因：这些动作发生在系统外壳层（资源管理器、默认看图程序），
// 失败就地无处可显示，不弹提示用户只会觉得「点了没反应」。

import { ipc } from '../core/ipc';
import { copyText, fileName } from '../core/util';
import { save } from '@tauri-apps/plugin-dialog';
import { openMenu, type MenuHandle, type MenuItem } from './overlay';
import { toast } from './toast';

/** 另存为对话框：默认落在源文件目录、同名同后缀，避免把 .png 存成 .jpg 的错觉。 */
async function pickSaveTarget(source: string): Promise<string | null> {
  const name = fileName(source);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const selected = await save({
    title: '图片另存为',
    defaultPath: source,
    filters: extension
      ? [{ name: `${extension.toUpperCase()} 图片`, extensions: [extension] }]
      : undefined,
  });
  return typeof selected === 'string' ? selected : null;
}

function failText(action: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${action}失败：${reason}`;
}

export interface ImageMenuOptions {
  /** 从鼠标位置弹出（画布右键）；省略时贴锚点元素下方。 */
  at?: { x: number; y: number };
  align?: 'start' | 'end';
  /** 追加在分隔线之后的界面特有动作（如结果表行的「在查看器中查看」）。 */
  extra?: readonly MenuItem[];
}

/** 在 anchor（或 at 坐标）弹出这张图的文件操作菜单。 */
export function openImageMenu(
  anchor: HTMLElement,
  path: string,
  options: ImageMenuOptions = {},
): MenuHandle {
  const items: MenuItem[] = [
    {
      label: '打开图片',
      hint: '系统默认程序',
      onSelect: () => {
        void ipc.imageOpenPath(path).catch((err: unknown) => toast(failText('打开图片', err), 'danger'));
      },
    },
    {
      label: '打开文件位置',
      hint: '在资源管理器中定位',
      onSelect: () => {
        void ipc
          .imageRevealPath(path)
          .catch((err: unknown) => toast(failText('定位文件', err), 'danger'));
      },
    },
    {
      label: '另存为…',
      onSelect: () => {
        void (async () => {
          try {
            const target = await pickSaveTarget(path);
            if (target === null) return;
            const saved = await ipc.imageSaveAs(path, target);
            toast(`已另存到 ${saved}`, 'ok');
          } catch (err) {
            toast(failText('另存', err), 'danger');
          }
        })();
      },
    },
    {
      label: '复制路径',
      onSelect: () => copyText(path, () => toast('已复制路径', 'ok')),
    },
    ...(options.extra ?? []),
  ];
  return openMenu(anchor, items, { at: options.at, align: options.align, label: '图片操作' });
}
