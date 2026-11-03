// 模式元数据与存储值归一化单测：
// localStorage 里的 viewerMode 可能来自旧版本或被手改，必须落到合法模式而不是让舞台空白。

import { describe, it, expect } from 'vitest';
import {
  BLINK_INTERVAL_MS,
  MODE_META,
  MODE_ORDER,
  defaultCompareUi,
  defaultViewerState,
  isSingleSlotMode,
  modeForKey,
  normalizeMode,
} from './types';

describe('模式集合', () => {
  it('键盘 1–6 的顺序是 分屏/多视图/滑动/叠加/差异/闪烁（多视图紧跟分屏）', () => {
    expect(MODE_ORDER).toEqual(['split', 'grid', 'slider', 'overlay', 'diff', 'blink']);
  });

  it('每个模式都有标签、图标与说明', () => {
    for (const mode of MODE_ORDER) {
      const meta = MODE_META[mode];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('单槽模式是滑动/叠加/差异/闪烁，分屏与网格不是', () => {
    expect(isSingleSlotMode('slider')).toBe(true);
    expect(isSingleSlotMode('overlay')).toBe(true);
    expect(isSingleSlotMode('diff')).toBe(true);
    expect(isSingleSlotMode('blink')).toBe(true);
    expect(isSingleSlotMode('split')).toBe(false);
    expect(isSingleSlotMode('grid')).toBe(false);
  });
});

describe('normalizeMode（外部值 → 合法模式）', () => {
  it('合法 id 原样返回', () => {
    for (const mode of MODE_ORDER) expect(normalizeMode(mode)).toBe(mode);
  });

  it('未知字符串/非字符串一律回落分屏（不让舞台空白）', () => {
    expect(normalizeMode('multiview2')).toBe('split');
    expect(normalizeMode('')).toBe('split');
    expect(normalizeMode(null)).toBe('split');
    expect(normalizeMode(undefined)).toBe('split');
    expect(normalizeMode(3)).toBe('split');
    expect(normalizeMode({})).toBe('split');
  });
});

describe('modeForKey（数字键 → 模式）', () => {
  it('1–6 映射到对应模式', () => {
    expect(modeForKey('1')).toBe('split');
    expect(modeForKey('2')).toBe('grid');
    expect(modeForKey('3')).toBe('slider');
    expect(modeForKey('4')).toBe('overlay');
    expect(modeForKey('5')).toBe('diff');
    expect(modeForKey('6')).toBe('blink');
  });

  it('越界与非数字键返回 null（不抢其它键）', () => {
    expect(modeForKey('0')).toBeNull();
    expect(modeForKey('7')).toBeNull();
    expect(modeForKey('a')).toBeNull();
    expect(modeForKey(' ')).toBeNull();
  });
});

describe('默认状态（新评测轮首次进入）', () => {
  it('叠加 50%、差异阈值 2、闪烁暂停且显示原图、分割线居中、视口待 fit', () => {
    const state = defaultViewerState();
    expect(state.compare).toEqual(defaultCompareUi());
    expect(state.compare.opacity).toBe(0.5);
    expect(state.compare.threshold).toBe(2);
    expect(state.compare.blinkPlaying).toBe(false);
    expect(state.compare.blinkShowingRef).toBe(true);
    expect(state.divider).toBe(0.5);
    expect(state.viewport).toBeNull();
    // 新轮从「自动适应」开始：第一次 fit 出来的比例不跨模式沿用
    expect(state.viewportTouched).toBe(false);
    expect(state.candidateChoices).toEqual({});
    expect(state.panePaths).toEqual([]);
    expect(state.cellPaths).toEqual([]);
  });

  it('网格模式的界面名是「多视图」（不是只有图标能猜的「网格」）', () => {
    expect(MODE_META.grid.label).toBe('多视图');
  });

  it('闪烁间隔 500ms（票面契约）', () => {
    expect(BLINK_INTERVAL_MS).toBe(500);
  });

  it('每次取默认值都是新对象（不会跨轮共享同一个可变态）', () => {
    const a = defaultViewerState();
    const b = defaultViewerState();
    a.compare.opacity = 0.1;
    a.cellPaths.push('/x.png');
    expect(b.compare.opacity).toBe(0.5);
    expect(b.cellPaths).toEqual([]);
  });
});
