// 票 #50 的回归守卫：「高级参数」折叠栏（summary + 参数行 + 添加栏）是无状态
// <details>，renderEntries 整卡重建（加参数行、行增删排序、条目增删、模式切换
// 都汇到这一个重建出口）会把它打回默认闭合。修复 = 重建前按条目 id 收集现有折叠
// 区的 open 成 Map、重建后按 id 回写（读-重建-回写）。code-review 修复（#50）：
// 不能按序号对应——删除非末位条目时其余条目序号前移，会把开合错配给相邻条目，
// 按 id 键控才与「折叠区保持原状」相符；新加条目查不到 id，保持默认闭合。
// 手动开合走 <details> 原生行为，不经重建，无需（也不应）在此钉死。
// 票 #51 追加：参数行分样式的守卫（行分叉 / ⓘ 挂载 / 行内 title 移除 /
// 气泡机制复用 / 参数名派生），接缝同上。
// vitest 是 node 环境（无 DOM），无法真实渲染面板观察折叠态，仿
// src/status-bar.test.ts 先例：?raw 导入源码当文本，压平空白后断言机制在位。
// 取舍：断言与源码字面量耦合，重构措辞可能误红——这是本批次约定的守卫接缝，
// 代价换来的是机制任何一环（读 / 顺序 / 回写）被删掉时这里必红。

import { describe, it, expect } from 'vitest';
import advancedUi from './advanced-ui.ts?raw';
import css from './style.css?raw';

const flat = advancedUi.replace(/\s+/g, '');

describe('高级参数折叠态跨重建保留（票 #50）：按条目 id 读-重建-回写', () => {
  it('条目卡片根元素带 entryId，重建出口按 id 把折叠区 open 收集进 Map（读）', () => {
    expect(flat, '卡片要带条目 id，按序号对应在删除非末位条目时会错配（票 #50 review）').toContain(
      'card.dataset.entryId=entry.id',
    );
    expect(flat).toContain("querySelectorAll<HTMLElement>('.adv-entry')");
    expect(flat).toContain('constprevOpen=newMap<string,boolean>()');
    expect(flat, '键 = 卡片 dataset 里的条目 id').toContain('prevOpen.set(id,details.open)');
  });

  it('收集先于清空重建（先读后 replaceChildren，读晚了抄到的是空盒子）', () => {
    const read = flat.indexOf('prevOpen.set(id,details.open)');
    const rebuild = flat.indexOf('entriesBox.replaceChildren()');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(rebuild);
  });

  it('重建后按条目 id 查 Map 回写 open（回写在重建之后；查不到的新条目保持默认闭合）', () => {
    const rebuild = flat.indexOf('entriesBox.replaceChildren()');
    const back = flat.indexOf("querySelectorAll<HTMLElement>('.adv-entry')", rebuild);
    const lookup = flat.indexOf("prevOpen.get(card.dataset.entryId??'')", rebuild);
    const write = flat.indexOf('details.open=open', rebuild);
    expect(back, '重建后应重查卡片（而不是复用重建前的引用）').toBeGreaterThanOrEqual(0);
    expect(lookup, '应按条目 id 查回开合状态').toBeGreaterThanOrEqual(0);
    expect(write, '重建后应把查到的 open 状态写回').toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(back);
    expect(write).toBeGreaterThan(lookup);
    expect(
      flat,
      '新加条目查不到 id（Map.get 得 undefined）时不得误写，保持默认闭合',
    ).toContain('if(details&&open!==undefined)details.open=open');
  });
});

describe('参数行分样式（票 #51）：行分叉与参数名派生', () => {
  it('按「标志是否命中当前条目编码器的推荐目录」二分行样式', () => {
    expect(
      flat,
      '参数行应先查推荐目录（命中 = 推荐行，未命中 = 自定义行）',
    ).toContain('knownParamsOf(entry).find((k)=>k.flag===row.flag.trim())');
    // class 名带空格，用未压平原文断言
    expect(advancedUi).toContain("'adv-param-row adv-param-row-known'");
    expect(advancedUi).toContain("'adv-param-row adv-param-row-custom'");
  });

  it('自定义行参数名从标志自动派生（去前导 -；核心库 mergeArgs 要求 name 非空）', () => {
    expect(flat).toContain("row.name=row.flag.trim().replace(/^-+/,'')");
  });
});

describe('推荐行自制下拉 + ⓘ 气泡（票 #51）', () => {
  it('收起态 ⓘ 挂当前参数说明（气泡内容 = 行说明原文）', () => {
    expect(flat).toContain('buildInfoBubble(row.note)');
  });

  it('选项级 ⓘ 挂该选项自己的说明（与点击选中分离，悬浮不触发选中）', () => {
    expect(flat).toContain('buildInfoBubble(item.note)');
  });

  it('气泡机制复用 #45：settings-status-info 包裹 + settings-bubble + 导出的 infoIconSvg', () => {
    expect(flat).toContain("info.className='settings-status-info'");
    expect(flat).toContain("bubble.className='settings-bubble'");
    expect(flat).toContain('icon.append(infoIconSvg())');
    expect(flat).toContain("import{infoIconSvg}from'./settings-ui'");
  });

  it('CSS 机制全局可用：展开规则挂在共享包裹类上、不限定设置页容器', () => {
    const flatCss = css.replace(/\s+/g, '');
    expect(flatCss).toContain('.settings-status-info:hover.settings-bubble');
    expect(flatCss).toContain('.settings-status-info:focus-within.settings-bubble');
  });

  it('已被其他行占用的选项禁用（本行自身除外），点击选项 = 整行替换为 rowFromKnown', () => {
    expect(flat, '占用判定要排除本行自身').toContain('i!==rowIndex');
    expect(flat).toContain('optionBtn.disabled=usedFlags.has(item.flag)');
    expect(flat).toContain('entry.rows[rowIndex]=rowFromKnown(item)');
    const replace = flat.indexOf('entry.rows[rowIndex]=rowFromKnown(item)');
    expect(flat.indexOf('renderEntries()', replace), '替换后须经重建出口刷新整卡').toBeGreaterThan(replace);
  });

  it('下拉同一时间至多展开一个（开新的先收旧的；点外部统一收起）', () => {
    expect(flat, '应有收起全部下拉的出口').toContain('closeKnownMenus()');
    expect(flat).toContain("querySelectorAll<HTMLElement>('.adv-known-menu')");
  });
});

describe('行内原生 title 退场与添加栏文案（票 #51）', () => {
  it('值控件（勾选/下拉/数值/文本）一律不设原生 title（说明统一走 ⓘ 气泡）', () => {
    const start = flat.indexOf('constbuildValueWidget=');
    const end = flat.indexOf('constrowFromKnown=');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(flat.slice(start, end), '值控件区域不应再出现 .title= 赋值').not.toContain('.title=');
  });

  it('参数名/说明输入框整体移除，命令框（自定义行）也不设 title', () => {
    expect(flat).not.toContain('nameInput');
    expect(flat).not.toContain('noteInput');
    expect(flat).not.toContain('flagInput.title');
  });

  it('↑↓× 操作提示 title 保留', () => {
    expect(advancedUi).toContain("'上移该参数行'");
    expect(advancedUi).toContain("'下移该参数行'");
    expect(advancedUi).toContain("'删除该参数行'");
  });

  it('添加栏「先选后加」行为不变，指向旧行为的过时提示清理', () => {
    expect(flat, '旧提示声称悬浮参数行可见说明，已不成立').not.toContain(
      '该编码器的推荐参数（带说明与推荐值/范围，悬浮参数行可见）',
    );
    expect(flat, '旧提示列举的参数名/说明框已不存在').not.toContain('添加一行自由参数（参数名/标志/值/说明）');
    expect(advancedUi).toContain("'从该编码器的推荐目录中选择要添加的参数'");
    expect(advancedUi).toContain("'添加一行自由参数（标志自由填写，参数名自动带出）'");
  });
});
