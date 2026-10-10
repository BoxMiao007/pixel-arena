// 票 #49 回归守卫：顶栏「＋ 新建跑分组」与「＋ 新建评测轮」两个下拉菜单互斥
// （点开其一自动收起另一个；再点已展开按钮照常收起；点外部 / Esc 关闭不变）。
// 取舍：vitest 是 node 环境（无 DOM），菜单开合是纯 DOM 行为无法直接断言，
// 仿 status-bar.test.ts 先例改守卫源码字面量：只要互斥调用仍以
// 「if (open) 关对方」的形态留在两个 toggle 内、且各只出现一次
// （收起分支不牵连对方），双向互斥与 toggle 手感就都成立；
// 该机制任何一条被后续改动删掉，这里变红。
// main.ts 经 vite 的 ?raw 后缀以文本导入（vitest 走同一管线，无需 node 内建）。

import { describe, it, expect } from 'vitest';
import mainTs from './main.ts?raw';

/** 压平空白后按函数名取完整函数块（花括号配对到收尾大括号），便于无空格断言 */
function functionBlock(name: string): string {
  const flat = mainTs.replace(/\s+/g, '');
  const start = flat.indexOf(`function${name}(`);
  expect(start, `main.ts 缺少函数：${name}`).toBeGreaterThanOrEqual(0);
  const body = flat.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = body; i < flat.length; i++) {
    if (flat[i] === '{') depth++;
    else if (flat[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `函数 ${name} 花括号不配对`).toBeGreaterThan(body);
  return flat.slice(start, end + 1);
}

describe('票 #49：顶栏两下拉互斥', () => {
  it('toggleGroupMenu 在「开」分支先收起评测轮菜单（正向互斥）', () => {
    const block = functionBlock('toggleGroupMenu');
    expect(block).toMatch(/if\(open\)\{?closeRoundMenu\(/);
    // 只此一处：收起分支不得牵连对方（点已开按钮收起时，评测轮菜单保持原状）
    expect(block.match(/closeRoundMenu\(/g)).toHaveLength(1);
  });

  it('toggleRoundMenu 在「开」分支先收起跑分组菜单（反向互斥）', () => {
    const block = functionBlock('toggleRoundMenu');
    expect(block).toMatch(/if\(open\)\{?closeGroupMenu\(/);
    expect(block.match(/closeGroupMenu\(/g)).toHaveLength(1);
  });
});
