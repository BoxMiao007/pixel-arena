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

  it('弹出菜单不得设 overflow/max-height（选项级 ⓘ 气泡要伸出菜单盒，任何裁剪值都会把它裁没——GUI 验收发现）', () => {
    const flatCss = css.replace(/\s+/g, '');
    const start = flatCss.indexOf('.adv-known-menu{');
    expect(start, '样式表缺少 .adv-known-menu 规则块').toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block).not.toContain('overflow');
    expect(block).not.toContain('max-height');
  });
});

describe('行内原生 title 退场与添加栏文案（票 #51）', () => {
  it('值控件（开关/下拉/数值/文本）一律不设原生 title（说明统一走 ⓘ 气泡）', () => {
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
    expect(advancedUi, '票 #54：添加栏按钮原生 title 移除，说明统一走 ⓘ 气泡').not.toContain(
      '从该编码器的推荐目录中选择要添加的参数',
    );
    expect(advancedUi).toContain("'添加一行自由参数（标志自由填写，参数名自动带出）'");
  });
});

describe('高级参数面板四条 UI 修正（票 #53）', () => {
  it('折叠触发区收窄：summary 按文字宽度自适应，行内空白不再触发展开/折叠', () => {
    const flatCss = css.replace(/\s+/g, '');
    const start = flatCss.indexOf('.adv-advancedsummary{');
    expect(start, '样式表缺少 .adv-advanced summary 规则块').toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block).toContain('width:fit-content');
    expect(block).toContain('max-width:100%');
  });

  it('布尔行裸 checkbox 退场：换 开/关 双态按钮（复用 adv-mode 分段样式，语义不变）', () => {
    const start = flat.indexOf('constbuildValueWidget=');
    const end = flat.indexOf('constrowFromKnown=');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const widget = flat.slice(start, end);
    expect(widget, '布尔行不得再创建勾选框控件（无样式、与 ↑↓× 重叠）').not.toContain(
      "type='checkbox'",
    );
    expect(widget, '开/关 双态按钮复用分段样式').toContain("wrap.className='adv-mode'");
    expect(widget).toContain("btn.textContent=on?'开':'关'");
    expect(widget, '点击开/关写回 row.enabled（= 命令行是否带此标志，语义不变）').toContain(
      'row.enabled=on',
    );
    expect(widget, '状态未变时不得触发重建').toContain('if(row.enabled!==on)');
  });

  it('收起态 ⓘ 在命令按钮内部：点 ⓘ 同按钮展开下拉，悬浮仍出气泡', () => {
    expect(flat, 'ⓘ 应作为按钮子节点（排在文字 span 之后）').toContain(
      'toggle.append(toggleText,buildInfoBubble(row.note))',
    );
    expect(flat, 'wrap 只剩 toggle + menu，ⓘ 不再悬在 flex 行中间').toContain(
      'wrap.append(toggle,menu)',
    );
  });

  it('命令按钮不得 overflow:hidden（ⓘ 气泡要从按钮盒外弹出），省略号职责移给内层文字 span', () => {
    const flatCss = css.replace(/\s+/g, '');
    const start = flatCss.indexOf('.adv-known-toggle{');
    expect(start, '样式表缺少 .adv-known-toggle 规则块').toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block, '按钮 overflow:hidden 会把 ⓘ 气泡裁没（#52 弹出菜单同款教训）').not.toContain(
      'overflow',
    );
    const textStart = flatCss.indexOf('.adv-known-toggle-text{');
    expect(textStart, '样式表缺少内层文字 span 规则块').toBeGreaterThanOrEqual(0);
    const textBlock = flatCss.slice(textStart, flatCss.indexOf('}', textStart) + 1);
    expect(textBlock).toContain('overflow:hidden');
    expect(textBlock).toContain('text-overflow:ellipsis');
  });

  it('添加栏置顶：DOM 里 addRow 先于参数行容器挂进 details', () => {
    const addPos = flat.indexOf('details.append(addRow)');
    const rowsPos = flat.indexOf('details.append(rowsBox)');
    expect(addPos, '应有 addRow 挂载点').toBeGreaterThanOrEqual(0);
    expect(rowsPos, '应有 rowsBox 挂载点').toBeGreaterThanOrEqual(0);
    expect(rowsPos, '添加栏要在参数行容器之前').toBeGreaterThan(addPos);
  });
});

describe('添加栏下拉换自制：条目带 ⓘ 说明气泡（票 #54）', () => {
  it('原生 select 退场（放不进选项内图标，#51 结论；编码器/单位选择器不受影响）', () => {
    const start = flat.indexOf("constaddRow=document.createElement('div')");
    const end = flat.indexOf('addRow.append(addDropdown,');
    expect(start, '应有添加栏构建区').toBeGreaterThanOrEqual(0);
    expect(end, '应有添加栏挂载点').toBeGreaterThan(start);
    const addBar = flat.slice(start, end);
    expect(addBar, '添加栏不应再创建 <select>').not.toContain("createElement('select')");
    expect(flat).not.toContain("'adv-known-select'");
    const flatCss = css.replace(/\s+/g, '');
    expect(flatCss, '死样式一并清掉').not.toContain('.adv-known-select');
  });

  it('复用推荐行下拉结构与弹出机制：toggle + menu 挂同一 wrap', () => {
    expect(flat).toContain("addToggle.className='adv-known-toggle'");
    expect(flat).toContain("addMenu.className='adv-known-menu'");
    expect(flat, 'toggle 与 menu 挂同一 position:relative 包裹').toContain(
      'addDropdown.append(addToggle,addMenu)',
    );
  });

  it('按钮收起态显示所选参数 + ⓘ（悬浮出该参数说明）；无可用时禁用且 ⓘ 退场', () => {
    expect(flat, '按钮 ⓘ 说明 = 当前选中项').toContain('buildInfoBubble(chosen.note)');
    expect(flat).toContain('addToggle.disabled=!chosen');
    expect(flat).toContain("'无可用推荐参数'");
  });

  it('菜单条目末尾 ⓘ 挂该条目说明；点条目仅选中不添加（添加仍走添加推荐参数按钮）', () => {
    expect(flat, '选中 = 更新按钮 + 收起菜单，不 push 行').toContain(
      'chosen=item;paintAddToggle();addMenu.hidden=true',
    );
    expect(flat, '添加按钮用当前选中项').toContain('entry.rows.push(rowFromKnown(chosen))');
  });

  it('添加栏里下拉占比与原 select 时代一致（flex:1，覆盖行内 flex:2.2）', () => {
    const flatCss = css.replace(/\s+/g, '');
    expect(flatCss).toContain('.adv-add-row.adv-known{flex:1');
  });
});

describe('下拉命令框 ⓘ 紧跟文字（票 #55）', () => {
  it('文字 span 不得设 flex:1（会把 ⓘ 推到框末尾），省略号机制保留', () => {
    const flatCss = css.replace(/\s+/g, '');
    const start = flatCss.indexOf('.adv-known-toggle-text{');
    expect(start, '样式表缺少 .adv-known-toggle-text 规则块').toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block, 'flex:1 会把 ⓘ 推到框末尾，ⓘ 须紧跟文字').not.toContain('flex:1');
    expect(block).toContain('overflow:hidden');
    expect(block).toContain('text-overflow:ellipsis');
  });
});
