// 工具栏布局回归（纯文本读 CSS，不依赖 DOM）：
// 真实窗口 1233×745 CSS 扣掉左右栏后舞台只有约 670px，曾经因为「窄舞台隐藏模式文字」
// 让六个模式退化成纯图标，分屏与滑动根本分不出来。这里守住两条硬约束：
// 1) 模式条在任何舞台宽度都显示「图标 + 12px 文字」，任何规则都不许 display:none 掉标签；
// 2) 让位顺序固定：模式条与缩放组不被隐藏，探针读数先收成图标，上下文文案后收。

import { describe, it, expect } from 'vitest';
import css from '../../styles/viewer.css?raw';

/** 取出所有选择器里含 needle 的规则块（简易匹配，够用于常量表形式的样式表）。 */
function rulesFor(needle: string): string[] {
  const blocks = css.match(/[^{}]+\{[^}]*\}/g) ?? [];
  return blocks.filter((block) => block.slice(0, block.indexOf('{')).includes(needle));
}

describe('模式条：图标 + 文字（任何宽度）', () => {
  it('存在模式标签的显示规则', () => {
    const rules = rulesFor('.viewer__modes .segmented__label');
    expect(rules.length).toBeGreaterThan(0);
  });

  it('没有任何规则把模式标签隐藏（窄舞台也不例外）', () => {
    for (const rule of rulesFor('segmented__label')) {
      expect(rule).not.toMatch(/display:\s*none/);
    }
  });

  it('模式条与缩放组本身不被容器查询隐藏（它们是最先保留的）', () => {
    for (const needle of ['.viewer__modes', '.viewer__zoom ']) {
      for (const rule of rulesFor(needle)) {
        expect(rule).not.toMatch(/display:\s*none/);
      }
    }
  });
});

describe('让位顺序：探针读数先收，上下文文案后收', () => {
  const containerRules = (css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? []).join('\n');

  it('窄舞台把探针收成图标按钮（读数改为锁定后浮层展示），而不是整体隐藏', () => {
    expect(containerRules).toMatch(/\.viewer__probe\s*\{[^}]*width:\s*var\(--control-h-sm\)/);
    expect(containerRules).toMatch(/\.viewer__probe-text\s*\{\s*display:\s*none/);
    expect(containerRules).toMatch(/\.viewer__probe-icon\s*\{\s*display:\s*inline/);
    // 探针按钮本身永远不该被 display:none
    for (const rule of rulesFor('.viewer__probe ')) {
      expect(rule).not.toMatch(/display:\s*none/);
    }
  });

  it('上下文文案有隐藏规则（在探针之后让位）', () => {
    expect(containerRules).toMatch(/\.viewer__context\s*\{\s*display:\s*none/);
  });

  it('极窄舞台允许工具栏换行，而不是退回纯图标', () => {
    expect(containerRules).toMatch(/\.viewer__toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
