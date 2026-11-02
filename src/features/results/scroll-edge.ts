// 结果表横向滚动的「右缘还有内容」状态。
//
// 列多时最右一列会被容器边缘裁掉，看不出还能横向滚。表格层只用 CSS 画渐隐
// （见 results.css 的 .results-table-host.has-more-right），本模块负责判断「右边
// 还有没有内容」：判定是纯函数（可脱离 DOM 单测），滚动监听与 ResizeObserver
// 收在 createEdgeFade 里，挂载方销毁时必须调 destroy()，避免留下悬挂监听。

export type EdgeState = 'none' | 'start' | 'middle' | 'end';

/**
 * 横向滚动的四种位置：没有溢出（none）、贴左（start）、中间（middle）、贴右（end）。
 * 容差 1px：亚像素布局下 clientWidth 取整，贴边时 scrollLeft 常差 0.x。
 */
export function edgeState(scrollLeft: number, scrollWidth: number, clientWidth: number): EdgeState {
  const max = scrollWidth - clientWidth;
  if (clientWidth <= 0 || max <= 1) return 'none';
  if (scrollLeft >= max - 1) return 'end';
  return scrollLeft <= 1 ? 'start' : 'middle';
}

/** 右缘还有内容时才提示（贴右与不溢出都不提示）。 */
export function hasMoreRight(state: EdgeState): boolean {
  return state === 'start' || state === 'middle';
}

export interface EdgeFade {
  /** 绑定（或换绑）真正的横向滚动容器；传 null 解除。 */
  track(scroll: HTMLElement | null): void;
  /** 内容变化（列增删、行数变化、重建表格）后重算；宿主没绑定滚动容器时是空操作。 */
  sync(): void;
  /** 解除所有监听；页签销毁时必须调用。 */
  destroy(): void;
}

const MORE_RIGHT_CLASS = 'has-more-right';

/**
 * 在宿主上维护 has-more-right 类。宿主是带 position: relative 的表格容器，
 * 渐隐层是它的伪元素，所以只需要切这一个类。
 */
export function createEdgeFade(host: HTMLElement): EdgeFade {
  let scroll: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;

  const apply = (): void => {
    if (scroll === null) {
      host.classList.remove(MORE_RIGHT_CLASS);
      return;
    }
    const state = edgeState(scroll.scrollLeft, scroll.scrollWidth, scroll.clientWidth);
    host.classList.toggle(MORE_RIGHT_CLASS, hasMoreRight(state));
  };

  const onScroll = (): void => apply();

  const track = (next: HTMLElement | null): void => {
    if (next === scroll) {
      apply();
      return;
    }
    if (scroll !== null) scroll.removeEventListener('scroll', onScroll);
    observer?.disconnect();
    observer = null;
    scroll = next;
    if (scroll === null) {
      host.classList.remove(MORE_RIGHT_CLASS);
      return;
    }
    scroll.addEventListener('scroll', onScroll, { passive: true });
    // 窗口缩放 / 折叠左右栏会改容器宽度，但不一定有人调 update()；
    // 用 ResizeObserver 兜住「尺寸变了没人通知」这一类。内容变宽仍由 sync() 负责
    // （改列集合会重建表格，size 不变所以 observer 不会触发）。
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => apply());
      observer.observe(scroll);
    }
    apply();
  };

  return {
    track,
    sync: apply,
    destroy: () => track(null),
  };
}
