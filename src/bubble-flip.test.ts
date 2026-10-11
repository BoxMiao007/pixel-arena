// 票 #57 守卫：ⓘ 气泡出界约束机制（wireBubbleFlip 共享函数 + 挂点接线 + CSS 变体）。
// 沿用 ?raw 导入源码压平空白断言的接缝（先例 status-bar.test.ts）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsUi from './settings-ui.ts?raw';
import advancedUi from './advanced-ui.ts?raw';
import css from './style.css?raw';

const flat = settingsUi.replace(/\s+/g, '');
const flatAdv = advancedUi.replace(/\s+/g, '');
const flatCss = css.replace(/\s+/g, '');

describe('ⓘ 气泡出界约束（票 #57）', () => {
  it('共享翻转函数导出自 settings-ui：hover/聚焦展开时测量、清残留再重测', () => {
    expect(flat).toContain(
      'exportconstwireBubbleFlip=(wrap:HTMLElement,bubble:HTMLElement):void=>{',
    );
    expect(flat, '悬浮与键盘聚焦两个展开口都要重测').toContain("wrap.addEventListener('mouseover'");
    expect(flat).toContain("wrap.addEventListener('focusin'");
    expect(flat, '修正前先清上一次内联，残留偏移会污染测量').toContain("bubble.style.left=''");
    expect(flat, '允许区=裁剪祖先∩窗口可视区').toContain('window.innerWidth');
    expect(flat, '逐层爬 overflow 非 visible 的裁剪祖先').toContain("style.overflowX!=='visible'");
    expect(flat).toContain('getBoundingClientRect()');
  });

  it('修正矩阵：右越界右缘贴边、左越界左缘贴边、过窄收窄、翻上与压回兜底', () => {
    expect(flat, '右越界 → 内联贴边').toContain('bounds.right-rect.right');
    expect(flat, '左越界 → 左缘贴边界').toContain('bubble.style.left=`${bounds.left-wrapRect.left}px`');
    expect(flat, '允许区比气泡窄 → 收窄 maxWidth 兜底').toContain('bubble.style.maxWidth=');
    expect(flat, '下越界且上方放得下 → --up 翻转').toContain("classList.add('settings-bubble--up')");
    expect(flat, '翻转前先移除旧类').toContain("classList.remove('settings-bubble--up')");
    expect(flat, '上下都放不下 → 压回允许区顶 + 限高').toContain('bubble.style.maxHeight=');
  });

  it('挂点接线：设置页两处 + 高级面板 buildInfoBubble（状态栏已改错误卡片，票 #58）', () => {
    expect(flat).toContain('wireBubbleFlip(ffmpegWrap,ffmpegBubble)');
    expect(flat).toContain('wireBubbleFlip(infoWrap,infoBubble)');
    expect(flatAdv).toContain('wireBubbleFlip(info,bubble)');
  });

  it('CSS：--up 变体翻到上方且箭头移到下缘；气泡限高后可滚动读全', () => {
    const upStart = flatCss.indexOf('.settings-bubble--up{');
    expect(upStart, '样式表缺少 --up 变体').toBeGreaterThanOrEqual(0);
    const upBlock = flatCss.slice(upStart, flatCss.indexOf('}', upStart) + 1);
    expect(upBlock).toContain('top:auto');
    expect(upBlock).toContain('bottom:calc(100%+7px)');
    const arrowStart = flatCss.indexOf('.settings-bubble--up::after{');
    expect(arrowStart, '样式表缺少 --up 箭头翻转').toBeGreaterThanOrEqual(0);
    const arrowBlock = flatCss.slice(arrowStart, flatCss.indexOf('}', arrowStart) + 1);
    expect(arrowBlock, '箭头随气泡移到下缘').toContain('top:100%');
    expect(arrowBlock).toContain('border-top-color:var(--border)');
    const start = flatCss.indexOf('.settings-bubble{');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block, '压回兜底限高后内容可滚动').toContain('overflow-y:auto');
  });
});

// 行为验证：node 环境无 DOM，用最小 fake 元素真跑 wireBubbleFlip 的修正矩阵
// （GUI 无法摆出触发条件：WM 限窗口最小高 600，自然布局放得下气泡，见票 #57 验收）。
import { vi } from 'vitest';
import { wireBubbleFlip } from './settings-ui';

const fakeRect = (x: number, y: number, w: number, h: number): DOMRect =>
  ({
    left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y,
    toJSON: () => ({}),
  }) as unknown as DOMRect;

const fakeEl = (rect: DOMRect) => {
  const added: string[] = [];
  const removed: string[] = [];
  const el = {
    style: {} as Record<string, string>,
    added,
    removed,
    classList: {
      add: (...cs: string[]) => void added.push(...cs),
      remove: (...cs: string[]) => void removed.push(...cs),
    },
    offsetParent: {} as Element | null,
    getBoundingClientRect: () => rect,
    listeners: {} as Record<string, (e: Event) => void>,
    addEventListener(type: string, fn: (e: Event) => void) {
      el.listeners[type] = fn;
    },
    parentElement: null as unknown,
    dispatch(type: string) {
      el.listeners[type]?.(new Event(type));
    },
  };
  return el;
};

describe('wireBubbleFlip 修正矩阵（票 #57 行为验证）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });
    // 默认无裁剪祖先：允许区 = 窗口可视区
    vi.stubGlobal('getComputedStyle', () => ({ overflowX: 'visible', overflowY: 'visible' }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = (wrapRect: DOMRect, bubbleRect: DOMRect) => {
    const wrap = fakeEl(wrapRect) as unknown as HTMLElement;
    const bubble = fakeEl(bubbleRect) as unknown as HTMLElement;
    wireBubbleFlip(wrap, bubble);
    const onOver = (wrap as unknown as ReturnType<typeof fakeEl>).listeners['mouseover']!;
    return { wrap, bubble, fire: () => onOver(new Event('mouseover')) };
  };

  it('充裕位置不动：不翻上、不贴边、不收窄', () => {
    const { bubble, fire } = setup(fakeRect(100, 100, 60, 16), fakeRect(120, 123, 352, 60));
    fire();
    expect((bubble as unknown as ReturnType<typeof fakeEl>).added).not.toContain('settings-bubble--up');
    const style = (bubble as unknown as ReturnType<typeof fakeEl>).style;
    expect(style.maxWidth).toBe('');
    expect(style.left).toBe('');
  });

  it('下越界且上方放得下：挂 --up 翻到 ⓘ 上方', () => {
    // 气泡底 650 > 窗口底 600；wrap 顶 100，上方 100-7-60=33 >= 0 放得下
    const { bubble, fire } = setup(fakeRect(100, 100, 60, 16), fakeRect(120, 590, 352, 60));
    fire();
    expect((bubble as unknown as ReturnType<typeof fakeEl>).added).toContain('settings-bubble--up');
  });

  it('上下都放不下：压回允许区顶并限高滚动', () => {
    // wrap 顶 50：50-7-560 = -517 < 0 上方放不下 → 压回 bounds.top(0)
    const { bubble, fire } = setup(fakeRect(100, 50, 60, 16), fakeRect(120, 66, 352, 560));
    fire();
    const el = bubble as unknown as ReturnType<typeof fakeEl>;
    expect(el.added).not.toContain('settings-bubble--up');
    expect(el.style.top).toBe(`${0 - 50}px`);
    expect(el.style.maxHeight).toBe('600px');
  });

  it('右越界：气泡右缘贴窗口右缘（内联左移 + 去 transform）', () => {
    // 气泡右 952 > 窗口右 800 → left = (600-500) + (800-952) = -52
    const { bubble, fire } = setup(fakeRect(500, 100, 60, 16), fakeRect(600, 200, 352, 60));
    fire();
    const el = bubble as unknown as ReturnType<typeof fakeEl>;
    expect(el.style.left).toBe('-52px');
    expect(el.style.transform).toBe('none');
  });

  it('允许区比气泡窄：左缘贴边界 + maxWidth 收窄兜底', () => {
    // 裁剪祖先把允许区右缘收到 300 → 宽 300 < 气泡 352；祖先链从 wrap 爬
    vi.stubGlobal('getComputedStyle', () => ({ overflowX: 'auto', overflowY: 'auto' }));
    const ancestor = {
      getBoundingClientRect: () => fakeRect(0, 0, 300, 600),
      parentElement: null,
    };
    const { wrap, bubble, fire } = setup(fakeRect(100, 100, 60, 16), fakeRect(120, 200, 352, 60));
    (wrap as unknown as { parentElement: unknown }).parentElement = ancestor;
    fire();
    const el = bubble as unknown as ReturnType<typeof fakeEl>;
    expect(el.style.left).toBe(`${0 - 100}px`);
    expect(el.style.maxWidth).toBe('300px');
  });
});
