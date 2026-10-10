// 票 #50 的回归守卫：「高级参数」折叠栏（summary + 参数行 + 添加栏）是无状态
// <details>，renderEntries 整卡重建（加参数行、行增删排序、条目增删、模式切换
// 都汇到这一个重建出口）会把它打回默认闭合。修复 = 重建前按序收集现有折叠区的
// open、重建后按序回写（读-重建-回写）；条目数变化时按序号对应，错位无害。
// 手动开合走 <details> 原生行为，不经重建，无需（也不应）在此钉死。
// vitest 是 node 环境（无 DOM），无法真实渲染面板观察折叠态，仿
// src/status-bar.test.ts 先例：?raw 导入源码当文本，压平空白后断言机制在位。
// 取舍：断言与源码字面量耦合，重构措辞可能误红——这是本批次约定的守卫接缝，
// 代价换来的是机制任何一环（读 / 顺序 / 回写）被删掉时这里必红。

import { describe, it, expect } from 'vitest';
import advancedUi from './advanced-ui.ts?raw';

const flat = advancedUi.replace(/\s+/g, '');

describe('高级参数折叠态跨重建保留（票 #50）：读-重建-回写', () => {
  it('重建出口按 details.adv-advanced 选择器收集 open 状态（读）', () => {
    expect(flat).toContain("querySelectorAll<HTMLDetailsElement>('details.adv-advanced')");
    expect(flat).toContain(')=>d.open');
  });

  it('收集先于清空重建（先读后 replaceChildren，读晚了抄到的是空盒子）', () => {
    const read = flat.indexOf("querySelectorAll<HTMLDetailsElement>('details.adv-advanced')");
    const rebuild = flat.indexOf('entriesBox.replaceChildren()');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(rebuild);
  });

  it('重建后按序回写 open（回写在重建之后，带越界守卫）', () => {
    const rebuild = flat.indexOf('entriesBox.replaceChildren()');
    const back = flat.indexOf('entriesBox.querySelectorAll<HTMLDetailsElement>', rebuild);
    const write = flat.indexOf('.open=open', rebuild);
    expect(back, '重建后应重查折叠区（而不是复用重建前的引用）').toBeGreaterThanOrEqual(0);
    expect(write, '重建后应把收集到的 open 状态写回').toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(back);
  });
});
