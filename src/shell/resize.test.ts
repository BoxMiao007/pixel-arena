// 栏宽纯计算的回归测试（node 环境，不引 jsdom）。
//
// 覆盖四类容易写错的口径：上下限夹取、窄窗口的 50% 上限、
// 非法输入回落默认（而不是落到最小值）、以及拖拽与按键的方向。

import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  dragSidebarWidth,
  keyboardSidebarWidth,
  RAIL_DEFAULT_WIDTH,
  sidebarRange,
  SIDEBAR_KEY_STEP,
  SIDEBAR_KEY_STEP_LARGE,
} from './resize';

/** 足够宽的窗口：只考验栏自身的上下限。 */
const WIDE = 1920;

describe('clampSidebarWidth：上下限', () => {
  it('左栏夹在 160–360', () => {
    expect(clampSidebarWidth('rail', 100, WIDE)).toBe(160);
    expect(clampSidebarWidth('rail', 200, WIDE)).toBe(200);
    expect(clampSidebarWidth('rail', 999, WIDE)).toBe(360);
  });

  it('检视器夹在 240–560', () => {
    expect(clampSidebarWidth('inspector', 100, WIDE)).toBe(240);
    expect(clampSidebarWidth('inspector', 400, WIDE)).toBe(400);
    expect(clampSidebarWidth('inspector', 999, WIDE)).toBe(560);
  });

  it('小数宽度取整', () => {
    expect(clampSidebarWidth('rail', 200.6, WIDE)).toBe(201);
  });
});

describe('clampSidebarWidth：窄窗口 50% 上限', () => {
  it('检视器不超过窗口宽一半', () => {
    expect(clampSidebarWidth('inspector', 560, 900)).toBe(450);
    expect(clampSidebarWidth('inspector', 400, 700)).toBe(350);
  });

  it('上限不高于 560 时仍以 560 为限', () => {
    expect(clampSidebarWidth('inspector', 999, 1600)).toBe(560);
  });

  it('左栏不受 50% 限制', () => {
    expect(clampSidebarWidth('rail', 360, 600)).toBe(360);
  });

  it('窗口窄到放不下最小宽度时，50% 优先且区间仍合法', () => {
    const range = sidebarRange('inspector', 400);
    expect(range).toEqual({ min: 200, max: 200 });
    expect(clampSidebarWidth('inspector', 328, 400)).toBe(200);
    expect(clampSidebarWidth('inspector', 240, 400)).toBe(200);
  });

  it('窗口宽不可信时不施加比例上限', () => {
    expect(clampSidebarWidth('inspector', 560, Number.NaN)).toBe(560);
    expect(clampSidebarWidth('inspector', 560, 0)).toBe(560);
  });
});

describe('clampSidebarWidth：非法输入回落默认', () => {
  it('NaN / 0 / 负数 / 无穷大一律回落到默认宽度', () => {
    for (const bad of [Number.NaN, 0, -1, -1000, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampSidebarWidth('rail', bad, WIDE)).toBe(208);
      expect(clampSidebarWidth('inspector', bad, WIDE)).toBe(328);
    }
  });

  it('回落到默认后仍受窄窗口上限约束', () => {
    expect(clampSidebarWidth('inspector', Number.NaN, 900)).toBe(328);
    expect(clampSidebarWidth('inspector', Number.NaN, 500)).toBe(250);
  });

  it('正数但小于下限时落到最小值（不是默认）', () => {
    expect(clampSidebarWidth('rail', 1, WIDE)).toBe(160);
    expect(clampSidebarWidth('inspector', 1, WIDE)).toBe(240);
  });
});

describe('defaultSidebarWidth：双击恢复的默认值', () => {
  it('宽窗口下就是 208 / 328', () => {
    expect(defaultSidebarWidth('rail', WIDE)).toBe(208);
    expect(defaultSidebarWidth('inspector', WIDE)).toBe(328);
  });

  it('窄窗口下检视器默认值同样收进 50%', () => {
    expect(defaultSidebarWidth('inspector', 500)).toBe(250);
  });
});

describe('dragSidebarWidth：拖拽方向', () => {
  it('左栏向右拖变宽', () => {
    expect(dragSidebarWidth('rail', 200, 40, WIDE)).toBe(240);
    expect(dragSidebarWidth('rail', 200, -40, WIDE)).toBe(160);
  });

  it('检视器向左拖变宽', () => {
    expect(dragSidebarWidth('inspector', 300, -40, WIDE)).toBe(340);
    expect(dragSidebarWidth('inspector', 300, 40, WIDE)).toBe(260);
  });

  it('拖出边界时夹住', () => {
    expect(dragSidebarWidth('rail', 340, 100, WIDE)).toBe(360);
    expect(dragSidebarWidth('inspector', 260, 100, WIDE)).toBe(240);
  });
});

describe('keyboardSidebarWidth：按键步进', () => {
  it('方向键让分隔条跟着箭头走（左右栏的宽度变化相反）', () => {
    // 左栏的分隔条在它右缘：左移变窄、右移变宽
    expect(keyboardSidebarWidth('rail', 200, 'ArrowLeft', false, WIDE)).toBe(200 - SIDEBAR_KEY_STEP);
    expect(keyboardSidebarWidth('rail', 200, 'ArrowRight', false, WIDE)).toBe(200 + SIDEBAR_KEY_STEP);
    // 检视器的分隔条在它左缘：左移变宽、右移变窄
    expect(keyboardSidebarWidth('inspector', 300, 'ArrowLeft', false, WIDE)).toBe(
      300 + SIDEBAR_KEY_STEP,
    );
    expect(keyboardSidebarWidth('inspector', 300, 'ArrowRight', false, WIDE)).toBe(
      300 - SIDEBAR_KEY_STEP,
    );
  });

  it('按住 Shift 走粗调步长', () => {
    expect(keyboardSidebarWidth('rail', 200, 'ArrowRight', true, WIDE)).toBe(
      200 + SIDEBAR_KEY_STEP_LARGE,
    );
    expect(keyboardSidebarWidth('inspector', 300, 'ArrowRight', true, WIDE)).toBe(
      300 - SIDEBAR_KEY_STEP_LARGE,
    );
  });

  it('Home / End 到区间两端', () => {
    expect(keyboardSidebarWidth('rail', 200, 'Home', false, WIDE)).toBe(160);
    expect(keyboardSidebarWidth('rail', 200, 'End', false, WIDE)).toBe(360);
    expect(keyboardSidebarWidth('inspector', 300, 'Home', false, WIDE)).toBe(240);
    expect(keyboardSidebarWidth('inspector', 300, 'End', false, WIDE)).toBe(560);
    // 窄窗口下 End 只能到 50%
    expect(keyboardSidebarWidth('inspector', 300, 'End', false, 800)).toBe(400);
  });

  it('已在边界时再按不越界', () => {
    expect(keyboardSidebarWidth('rail', 160, 'ArrowLeft', false, WIDE)).toBe(160);
    expect(keyboardSidebarWidth('rail', 360, 'ArrowRight', true, WIDE)).toBe(360);
  });

  it('当前宽度不可信时从默认值起步', () => {
    expect(keyboardSidebarWidth('rail', Number.NaN, 'ArrowRight', false, WIDE)).toBe(
      RAIL_DEFAULT_WIDTH + SIDEBAR_KEY_STEP,
    );
  });

  it('未处理的按键返回 null', () => {
    expect(keyboardSidebarWidth('rail', 200, 'Enter', false, WIDE)).toBeNull();
    expect(keyboardSidebarWidth('inspector', 300, 'a', false, WIDE)).toBeNull();
  });
});
