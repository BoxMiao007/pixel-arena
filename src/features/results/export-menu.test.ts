// 导出菜单的动作清单：菜单里到底有哪几项属于用户可见契约，直接断言函数的返回。
// 每项的内部行为由 exportBlockedReason / exportFileName / serialize 的既有测试覆盖，
// 这里不重复（也不读源码文本）。

import { describe, expect, it } from 'vitest';
import { exportMenuActions } from './export-menu';

describe('导出菜单动作', () => {
  it('四个动作齐全：导出 CSV/HTML 与复制 CSV/Markdown', () => {
    expect(exportMenuActions().map((action) => action.label)).toEqual([
      '导出 CSV…',
      '导出 HTML…',
      '复制为 CSV',
      '复制为 Markdown',
    ]);
  });

  it('每个动作都可点击（都有 onSelect）', () => {
    for (const action of exportMenuActions()) {
      expect(typeof action.onSelect, action.label).toBe('function');
    }
  });
});
