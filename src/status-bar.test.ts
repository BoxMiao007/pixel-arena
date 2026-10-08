// 顶栏状态栏长文案优化的回归守卫。vitest 是 node 环境（无 DOM），布局类断言
// （「header 高度恒定」）无法直接测，改为守卫保证该结论的两端：
//   1) 样式端：.status 有宽度上限、.status-text 单行截断（nowrap + hidden +
//      ellipsis）——这三条在，无论错误多少字符 header 都不会被撑高；
//   2) 全文可达端：Ⓘ 气泡悬停/Tab 聚焦展开、限高 50vh 可滚；
//   3) 挂载端：Ⓘ 只在真截断时出现（scrollWidth 比较），且不再设原生 title
//      （全文进气泡，避免气泡与系统 tooltip 双弹）。
// 约束任何一条被后续改动删掉，这里变红。
// 样式与源码经 vite 的 ?raw 后缀以文本导入（vitest 走同一管线，无需 node 内建）。

import { describe, it, expect } from 'vitest';
import css from './style.css?raw';
import mainTs from './main.ts?raw';

/** 压平空白后按选择器取规则块（`选择器 { … }` 整块），便于无空格断言 */
function ruleBlock(selector: string): string {
  const flat = css.replace(/\s+/g, '');
  const start = flat.indexOf(selector.replace(/\s+/g, '') + '{');
  expect(start, `样式表缺少规则块：${selector}`).toBeGreaterThanOrEqual(0);
  const end = flat.indexOf('}', start);
  return flat.slice(start, end + 1);
}

describe('样式端：header 高度恒定的三条保证', () => {
  it('.status 有宽度上限（超长错误只能往省略号里去）', () => {
    const block = ruleBlock('.status');
    expect(block).toContain('max-width:');
    expect(block).toContain('min-width:0'); // flex 子项默认不肯收缩，必须显式放开
  });

  it('.status-text 单行截断：nowrap + hidden + ellipsis', () => {
    const block = ruleBlock('.status-text');
    expect(block).toContain('white-space:nowrap');
    expect(block).toContain('overflow:hidden');
    expect(block).toContain('text-overflow:ellipsis');
  });

  it('.status-error 的红色口径仍在（截断不吞错误配色）', () => {
    expect(ruleBlock('.status-error')).toContain('color:var(--red)');
  });
});

describe('全文可达端：Ⓘ 气泡的展开与滚动', () => {
  it('.status-bubble 限高可滚、指针事件开启（上千字符也能看）', () => {
    const block = ruleBlock('.status-bubble');
    expect(block).toContain('max-height:50vh');
    expect(block).toContain('overflow-y:auto');
    expect(block).toContain('pointer-events:auto');
  });

  it('悬停与键盘聚焦都能展开（:hover 与 :focus-within 双触发）', () => {
    const flat = css.replace(/\s+/g, '');
    expect(flat).toContain('.status-detail:hover.status-bubble');
    expect(flat).toContain('.status-detail:focus-within.status-bubble');
  });

  it('图标与气泡间有悬停桥（移向气泡途中不收起）', () => {
    const block = ruleBlock('.status-detail::after');
    expect(block).toContain('top:100%');
    expect(block).toMatch(/height:\d+px/);
  });
});

describe('挂载端（main.ts）：Ⓘ 仅截断时出现、原生 title 退场', () => {
  it('截断检测走 scrollWidth 与 clientWidth 比较', () => {
    expect(mainTs).toContain('scrollWidth > $text.clientWidth');
  });

  it('气泡复用 #45 基底类 + 状态栏修饰类', () => {
    expect(mainTs).toContain("'settings-bubble status-bubble'");
  });

  it('不再往状态栏设原生 title（避免与气泡双弹）', () => {
    expect(mainTs).not.toContain('$status.title');
  });

  it('Ⓘ 可聚焦（键盘可达，同 #45 口径）', () => {
    expect(mainTs).toContain("'tabindex', '0'");
  });
});
