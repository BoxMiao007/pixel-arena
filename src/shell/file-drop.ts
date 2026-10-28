// 文件拖放：把系统文件（资源管理器）拖进窗口，路由到指针下的落区。
//
// Tauri 的窗口级拖放事件只给物理像素坐标，这里换算成 CSS 像素后用 elementFromPoint
// 找到最近的 [data-drop-id]，再交给注册的处理函数。没有命中落区时依次回退到
// 「舞台落区」（由 stage 注册）与默认处理（按扩展名判断该设原图还是加跑分图）。
//
// 落区在 mount 时注册、destroy 时注销；拖入/拖离时的全局提示由外壳统一渲染。

import { getCurrentWindow } from '@tauri-apps/api/window';
import { el } from '../ui/dom';
import { icon } from '../ui/icons';
import { getState } from '../core/store';
import { activeRound } from '../core/model';
import { addCandidates, setRoundReference } from '../core/actions';
import { toast } from '../ui/toast';

export type DropAccept = 'image' | 'video' | 'any';

/** 与文件对话框一致的扩展名白名单（供各域复用，避免两处口径不一致）。 */
export const DROP_EXTENSIONS: Record<'image' | 'video', readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'jxl'],
  video: ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'flv'],
};

export interface DropTargetOptions {
  id: string;
  accept: DropAccept;
  /** 拖到落区上时显示的一句话（如「设为原图」）。 */
  hint: string;
  onDrop: (paths: string[]) => void;
  disabled?: () => boolean;
}

const targets = new Map<string, { element: HTMLElement; options: DropTargetOptions }>();
let indicator: HTMLElement | null = null;
let listening = false;
let hoveredId: string | null = null;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'jxl']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'flv']);

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function accepts(accept: DropAccept, path: string): boolean {
  const ext = extensionOf(path);
  if (accept === 'image') return IMAGE_EXTENSIONS.has(ext);
  if (accept === 'video') return VIDEO_EXTENSIONS.has(ext);
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

/** 注册一个落区；返回注销函数（destroy 时调用）。 */
export function registerDropTarget(host: HTMLElement, options: DropTargetOptions): () => void {
  host.dataset.dropId = options.id;
  targets.set(options.id, { element: host, options });
  return () => {
    targets.delete(options.id);
    delete host.dataset.dropId;
  };
}

function targetAt(x: number, y: number): DropTargetOptions | null {
  const node = document.elementFromPoint(x, y);
  const zone = node?.closest<HTMLElement>('[data-drop-id]');
  const id = zone?.dataset.dropId;
  if (id) {
    const entry = targets.get(id);
    if (entry && !entry.options.disabled?.()) return entry.options;
  }
  return null;
}

function ensureIndicator(): HTMLElement {
  if (!indicator) {
    indicator = el(
      'div',
      { class: 'drop-indicator', attrs: { 'aria-live': 'polite' } },
      icon('importFile', 'icon icon--24'),
      el('span', { class: 'drop-indicator__text' }),
    );
    document.body.appendChild(indicator);
  }
  return indicator;
}

function showIndicator(text: string, over: boolean): void {
  const node = ensureIndicator();
  node.querySelector('.drop-indicator__text')!.textContent = text;
  node.classList.toggle('is-over', over);
  node.hidden = false;
}

function hideIndicator(): void {
  if (indicator) indicator.hidden = true;
  hoveredId = null;
  for (const { element } of targets.values()) element.classList.remove('is-drop-hover');
}

/** 默认落点：按扩展名判断是「设原图」还是「加跑分图」。 */
async function defaultDrop(paths: string[]): Promise<void> {
  const session = activeRound(getState().workspace);
  if (!session) {
    toast('先新建或选择一个跑分组，再拖入文件', 'danger');
    return;
  }
  const images = paths.filter((path) => accepts('image', path));
  const videos = paths.filter((path) => accepts('video', path));
  if (session.group.kind === 'video') {
    if (videos.length > 0) {
      const { chooseVideoReference, chooseVideoCandidates } = await import('../features/video/actions');
      if (!session.round.videoReferencePath && videos.length === 1) {
        await chooseVideoReference(session.group.id, session.round.id, videos[0]);
      } else if (!session.round.videoReferencePath) {
        await chooseVideoReference(session.group.id, session.round.id, videos[0]);
        await chooseVideoCandidates(session.group.id, session.round.id, videos.slice(1));
      } else {
        await chooseVideoCandidates(session.group.id, session.round.id, videos);
      }
    }
    if (images.length > 0) {
      toast('视频跑分组不接受图片；图片请拖到图片跑分组', 'danger');
    }
    return;
  }
  if (videos.length > 0) {
    toast('图片跑分组不接受视频；视频请拖到视频跑分组', 'danger');
  }
  if (images.length === 0) return;
  if (!session.round.referencePath) {
    await setRoundReference(session.group.id, session.round.id, images[0]);
    const rest = images.slice(1);
    if (rest.length > 0) {
      await addCandidates(session.group.id, session.round.id, rest);
    }
    return;
  }
  await addCandidates(session.group.id, session.round.id, images);
}

/** 启动窗口级拖放监听（boot 时调用一次）。 */
export function startFileDrop(): void {
  if (listening) return;
  // 浏览器预览（无 Tauri 运行时）不挂窗口级拖放
  if (!('__TAURI_INTERNALS__' in window)) return;
  listening = true;
  void getCurrentWindow()
    .onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        const position = 'position' in payload ? payload.position : null;
        if (!position) {
          showIndicator('松开以导入文件', false);
          return;
        }
        const scale = window.devicePixelRatio || 1;
        const target = targetAt(position.x / scale, position.y / scale);
        hoveredId = target?.id ?? null;
        for (const [id, entry] of targets) {
          entry.element.classList.toggle('is-drop-hover', id === hoveredId);
        }
        showIndicator(target?.hint ?? '松开以导入到当前评测轮', target !== null);
        return;
      }
      if (payload.type === 'leave') {
        hideIndicator();
        return;
      }
      // drop
      const paths = payload.paths ?? [];
      hideIndicator();
      if (paths.length === 0) return;
      const target = (() => {
        if (hoveredId) return targets.get(hoveredId)?.options ?? null;
        const scale = window.devicePixelRatio || 1;
        return targetAt(payload.position.x / scale, payload.position.y / scale);
      })();
      if (target) {
        const accepted = paths.filter((path) => accepts(target.accept, path));
        const rejected = paths.length - accepted.length;
        if (accepted.length > 0) target.onDrop(accepted);
        if (rejected > 0) {
          toast(
            target.accept === 'image'
              ? `已忽略 ${rejected} 个非图片文件`
              : target.accept === 'video'
                ? `已忽略 ${rejected} 个非视频文件`
                : `已忽略 ${rejected} 个不支持的文件`,
            'danger',
          );
        }
        return;
      }
      void defaultDrop(paths);
    });
}
