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
import encoderCard from './encoder-card.ts?raw';
import css from './style.css?raw';

// 票 #75 起，单张编码器卡的 DOM（卡头 / 快速参数 / 高级参数行 / 命令行预览）住在
// src/encoder-card.ts 共享实现里，面板只剩列表容器与创建流程。守卫的语义是「机制
// 在位」，所以扫描范围 = 面板源码 + 共享卡片源码的并集：机制放哪个文件都行，但
// 任何一环被删掉这里必红。
const flat = [advancedUi, encoderCard].map((source) => source.replace(/\s+/g, '')).join('\n');
/** 未压平的合并源码：给需要断言带空格字面量（如 className）的守卫用。 */
const rawAll = `${advancedUi}\n${encoderCard}`;

describe('高级参数折叠态跨重建保留（票 #50）：按条目 id 读-重建-回写', () => {
  it('条目卡片根元素带 entryId，重建出口按 id 把折叠区 open 收集进 Map（读）', () => {
    expect(flat, '卡片要带条目 id，按序号对应在删除非末位条目时会错配（票 #50 review）').toContain(
      'card.dataset.entryId=entry.id',
    );
    expect(flat).toContain("querySelectorAll<HTMLElement>('.adv-entry')");
    // 票 #75：折叠区有两类（高级参数子区 / 命令行预览），收集粒度从
    // 「id → boolean」升级为「id → (region → open)」，读-回写机制不变
    expect(flat).toContain('constprevOpen=newMap<string,Map<string,boolean>>()');
    expect(flat, 'open 按 region 收进该条目的 Map').toContain(
      'openByRegion.set(details.dataset.advRegion??\'\',details.open)',
    );
  });

  it('收集先于清空重建（先读后 replaceChildren，读晚了抄到的是空盒子）', () => {
    const read = flat.indexOf('openByRegion.set(details.dataset.advRegion');
    const rebuild = flat.indexOf('entriesBox.replaceChildren()');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(rebuild);
  });

  it('重建后按条目 id 查 Map 回写 open（回写在重建之后；查不到的新条目保持默认）', () => {
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
      '新加条目查不到 id（Map.get 得 undefined）时不得误写，保持默认收合',
    ).toContain("if(!openByRegion)continue");
  });
});

describe('参数行分样式（票 #51）：行分叉与参数名派生', () => {
  it('按「标志是否命中当前条目编码器的推荐目录」二分行样式', () => {
    expect(
      flat,
      '参数行应先查推荐目录（命中 = 推荐行，未命中 = 自定义行）',
    ).toContain('knownParamsOf(catalog,entry).find((item)=>item.flag===row.flag.trim())');
    // class 名带空格，用未压平原文断言
    expect(rawAll).toContain("'adv-param-row adv-param-row-known'");
    expect(rawAll).toContain("'adv-param-row adv-param-row-custom'");
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
    // 票 #57 后导入行加了 wireBubbleFlip，断言放宽为「从 settings-ui 导入 infoIconSvg」
    expect(flat).toMatch(/import\{[^}]*infoIconSvg[^}]*\}from'\.\/settings-ui'/);
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
    expect(flat.indexOf('callbacks.onChange()', replace), '替换后须经重建出口刷新整卡').toBeGreaterThan(replace);
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
    // 票 #75：值控件构建区搬进 encoder-card；rowFromKnown 现在位于它之前，用
    // 下一个函数（buildKnownDropdown）当右边界
    const start = flat.indexOf('constbuildValueWidget=');
    const end = flat.indexOf('constbuildKnownDropdown=');
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
    expect(rawAll).toContain("'上移该参数行'");
    expect(rawAll).toContain("'下移该参数行'");
    expect(rawAll).toContain("'删除该参数行'");
  });

  it('添加栏「先选后加」行为不变，指向旧行为的过时提示清理', () => {
    expect(flat, '旧提示声称悬浮参数行可见说明，已不成立').not.toContain(
      '该编码器的推荐参数（带说明与推荐值/范围，悬浮参数行可见）',
    );
    expect(flat, '旧提示列举的参数名/说明框已不存在').not.toContain('添加一行自由参数（参数名/标志/值/说明）');
    expect(rawAll, '票 #54：添加栏按钮原生 title 移除，说明统一走 ⓘ 气泡').not.toContain(
      '从该编码器的推荐目录中选择要添加的参数',
    );
    expect(rawAll).toContain("'添加一行自由参数（标志自由填写，参数名自动带出）'");
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
    const end = flat.indexOf('constbuildKnownDropdown=');
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

describe('弹出菜单条目 ⓘ 紧跟文字（票 #56）', () => {
  it('条目按钮不拉伸：ⓘ 跟随各条目文字，不再统一贴菜单右缘', () => {
    const flatCss = css.replace(/\s+/g, '');
    const start = flatCss.indexOf('.adv-known-option-btn{');
    expect(start, '样式表缺少 .adv-known-option-btn 规则块').toBeGreaterThanOrEqual(0);
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block, '条目按钮 flex 拉伸会把 ⓘ 推到菜单右缘（与票 #55 同根源）').not.toContain(
      'flex:1',
    );
  });
});

describe('复制出口共享（票 #58）', () => {
  it('命令行复制走 util.copyText 共享出口，私有 fallbackCopy 退场', () => {
    expect(flat, 'copyLine 复用共享出口').toContain("copyText(text,()=>deps.setStatus('已复制命令行'))");
    expect(flat, '兜底逻辑只在 util 一份，避免拷贝').not.toContain('functionfallbackCopy');
  });
});

// 票 #75：卡片渲染抽成共享实现 + 卡内分组布局。node 环境无 DOM，沿用 ?raw 文本
// 机制守卫（先例 status-bar.test.ts / advanced-ui.test.ts 全篇）。
import encoderCardSource from './encoder-card.ts?raw';

const flatCard = encoderCardSource.replace(/\s+/g, '');
const flatPanel = advancedUi.replace(/\s+/g, '');
const flatCss75 = css.replace(/\s+/g, '');

describe('编码器卡共享渲染（票 #75）', () => {
  it('卡片渲染是不依赖面板生命周期的导出函数；面板经它渲染，不再自己造卡', () => {
    expect(flatCard, '共享实现导出单卡渲染函数').toContain(
      'exportfunctionrenderEncoderCard(',
    );
    expect(flatCard, '入参 = 条目 + 序号 + 目录 + 回调 + 可选环境，不引用面板闭包').toContain(
      'entry:AdvancedEntry,index:number,catalog:EncoderCardCatalog,callbacks:EncoderCardCallbacks,options:EncoderCardOptions={},',
    );
    expect(flatPanel, '面板改为调用共享渲染').toContain('renderEncoderCard(entry,index,catalog,');
    expect(
      flatPanel,
      '面板不得再自己创建 adv-entry 卡片（卡片 DOM 只应有一份实现）',
    ).not.toContain("card.className='adv-entry'");
    // 卡片模块不得反向 import 面板（否则又绑回面板生命周期）
    expect(flatCard, '共享卡片不得依赖高级创建面板').not.toContain("from'./advanced-ui'");
  });

  it('卡头 = 序号 + 编码器选择 + 恢复默认 + ↑↓×', () => {
    expect(flatCard).toContain('`第${index+1}项`');
    expect(flatCard).toContain("select.className='adv-encoder-select'");
    expect(flatCard).toContain("resetBtn.textContent='恢复默认'");
    // 卡头挂载顺序：序号、选择器、恢复默认、上移、下移、删除
    const headAppend = flatCard.slice(flatCard.indexOf('headRow.append('));
    expect(headAppend.indexOf('label,select,resetBtn,upBtn,downBtn,delBtn')).toBeGreaterThanOrEqual(0);
  });

  it('卡内两区划分：快速参数子区（两列网格）与高级参数行子区各自带标题/容器', () => {
    expect(flatCard, '快速参数子区容器').toContain("quickZone.className='adv-quick-zone'");
    expect(flatCard, '两列网格容器').toContain("quickGrid.className='adv-quick-grid'");
    expect(flatCard, '子区标题「快速参数」').toContain("quickTitle.textContent='快速参数'");
    expect(flatCard, '高级参数子区容器').toContain("details.className='adv-advanced'");
    expect(flatCard, '高级参数子区标题').toContain('`高级参数行（${active}项生效/共${entry.rows.length}行）`');
    // DOM 顺序：快速参数子区先挂，高级参数子区后挂
    const quickPos = flatCard.indexOf('card.append(quickZone)');
    const advancedPos = flatCard.indexOf('card.append(details)');
    expect(quickPos, '应挂载快速参数子区').toBeGreaterThanOrEqual(0);
    expect(advancedPos, '应挂载高级参数子区').toBeGreaterThanOrEqual(0);
    expect(advancedPos).toBeGreaterThan(quickPos);
    // CSS：两列网格 + 子区分隔线
    const gridStart = flatCss75.indexOf('.adv-quick-grid{');
    expect(gridStart, '样式表缺少两列网格规则').toBeGreaterThanOrEqual(0);
    const gridBlock = flatCss75.slice(gridStart, flatCss75.indexOf('}', gridStart) + 1);
    expect(gridBlock, '快速参数须两列网格').toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    const advStart = flatCss75.indexOf('.adv-advanced{');
    expect(advStart, '高级参数子区应有独立样式块').toBeGreaterThanOrEqual(0);
    const advBlock = flatCss75.slice(advStart, flatCss75.indexOf('}', advStart) + 1);
    expect(advBlock, '高级参数子区带分隔线').toContain('border-top:1pxsolidvar(--border)');
  });

  it('高级参数行子区默认展开', () => {
    const start = flatCard.indexOf("details.className='adv-advanced'");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = flatCard.slice(start, start + 200);
    expect(next, '高级参数子区渲染时须置 open = true').toContain('details.open=true');
  });

  it('卡级「恢复默认」重置质量/模式/目标大小/无损/全部参数行（含自定义行）', () => {
    const start = flatCard.indexOf('exportfunctionresetEntryToDefault(');
    expect(start, '应有恢复默认的纯函数出口').toBeGreaterThanOrEqual(0);
    const body = flatCard.slice(start, flatCard.indexOf('renderEncoderCard(', start));
    expect(body).toContain('entry.lossless=false');
    expect(body).toContain("entry.mode='quality'");
    expect(body).toContain('entry.targetBytes=200*1024');
    expect(body, '参数行整组清空（自定义行一并删除）').toContain('entry.rows=[]');
    expect(body, '质量回到该编码器规格默认值（表外编码器退回 75）').toContain(
      'entry.quality=spec?.qualityDefault??75',
    );
  });

  it('命令行预览默认收起：<details> 不设 open，标题「命令行预览」，展开后可复制', () => {
    const start = flatCard.indexOf("previewDetails.className='adv-preview'");
    expect(start, '应有命令行预览折叠容器').toBeGreaterThanOrEqual(0);
    const block = flatCard.slice(start, flatCard.indexOf('card.append(previewDetails)', start));
    expect(block, '预览默认收起：不得设置 open').not.toContain('previewDetails.open=true');
    expect(block, '折叠标题').toContain("previewSummary.textContent='命令行预览'");
    expect(block, '展开后「复制」照旧可用').toContain("copyBtn.textContent='复制'");
    // CSS：预览子区带分隔线，summary 可点
    const cssStart = flatCss75.indexOf('.adv-preview{');
    expect(cssStart, '样式表缺少预览折叠区规则').toBeGreaterThanOrEqual(0);
    const cssBlock = flatCss75.slice(cssStart, flatCss75.indexOf('}', cssStart) + 1);
    expect(cssBlock).toContain('border-top:1pxsolidvar(--border)');
  });

  it('预览内容随参数改动即时刷新（liveCallback 挂 refreshPreview，不重建保焦点）', () => {
    expect(flatCard, '快速参数改动走 live 回调').toContain(
      'liveCallbacks.push(()=>{refreshPreview();syncSummary();})',
    );
    expect(flatCard).toContain('slider.addEventListener(\'input\',()=>{');
    const sliderBlock = flatCard.slice(flatCard.indexOf("slider.addEventListener('input'"));
    expect(sliderBlock.slice(0, 200), '滑杆输入即刷新预览').toContain('onChangeLive()');
  });
});

// 「恢复默认」口径的行为验证：纯逻辑无 DOM 依赖，可在 node 环境直接真跑（比
// 文本守卫强）。断言「恢复后与刚添加时逐字段一致」——即票面「回到刚添加时的状态」。
import { newEntry } from './advanced';
import { resetEntryToDefault } from './encoder-card';

describe('恢复默认 = 回到刚添加时（票 #75 行为验证）', () => {
  const jpegSpec = {
    id: 'jpeg',
    toolKey: 'cjpeg',
    displayName: 'JPEG',
    baseArgs: ['-quality'],
    losslessSupported: false,
    losslessNote: 'JPEG 不支持无损',
    losslessArgs: [],
    qualityFlag: '-quality',
    qualityMin: 0,
    qualityMax: 100,
    qualityDefault: 60,
    qualityStep: 1,
    inputPng: false,
    outputExt: 'jpg',
    knownParams: [],
  };

  it('质量 / 模式 / 目标大小 / 单位 / 无损开关 / 参数行全部回退，id 与编码器保留', () => {
    const entry = newEntry('image', 'jpeg', jpegSpec);
    const idBefore = entry.id;
    // 调乱：无损 + 大小优先 + 质量 5 + 目标 3 MB + 两条参数行（含一条自定义行）
    entry.lossless = true;
    entry.mode = 'size';
    entry.quality = 5;
    entry.targetBytes = 3 * 1024 * 1024;
    entry.unit = 'MB';
    entry.rows.push(
      {
        name: '优化',
        flag: '-optimize',
        value: '',
        note: '',
        kind: 'bool',
        options: [],
        enabled: true,
      },
      { name: '自定义', flag: '-custom', value: '1', note: '', kind: 'text', options: [], enabled: true },
    );

    resetEntryToDefault(entry, jpegSpec);

    expect(entry.lossless).toBe(false);
    expect(entry.mode).toBe('quality');
    expect(entry.quality).toBe(60);
    expect(entry.targetBytes).toBe(200 * 1024);
    expect(entry.unit).toBe('KB');
    expect(entry.rows, '全部参数行清空（自定义行一并删除）').toEqual([]);
    expect(entry.id, '条目 id 保留（折叠态按 id 回写）').toBe(idBefore);
    expect(entry.encoderId, '编码器选择保留').toBe('jpeg');

    // 与「刚添加时」逐字段一致（除 id/encoderId 外）
    const fresh = newEntry('image', 'jpeg', jpegSpec);
    const shape = (e: typeof entry) => ({
      lossless: e.lossless,
      mode: e.mode,
      quality: e.quality,
      targetBytes: e.targetBytes,
      unit: e.unit,
      rows: e.rows,
    });
    expect(shape(entry)).toEqual(shape(fresh));
  });

  it('表外视频编码器（无规格）也回到默认质量 75，参数行清空', () => {
    const entry = newEntry('video', 'libx264', {
      displayName: 'libx264',
      baseArgs: [],
      losslessSupported: false,
      losslessNote: '',
      losslessArgs: [],
      qualityFlag: '-crf',
      qualityMin: 0,
      qualityMax: 51,
    });
    entry.quality = 51;
    entry.rows.push({ name: '', flag: '-x', value: '', note: '', kind: 'text', options: [], enabled: true });
    resetEntryToDefault(entry, null);
    expect(entry.quality).toBe(75);
    expect(entry.rows).toEqual([]);
  });
});

// ---------- 票 T6：旧面板收缩为视频专用 ----------
// 图片组的高级创建已改为条目列表面板 + 逐图编辑弹窗（#74），图片侧只应剩一套界面。
// 这里的守卫钉两件事：①旧面板源码里不再有图片分支（删干净，不留死路径）；
// ②视频侧结构（原视频预填 / 编码器目录 / 可用性校验 / 建轮写备注 / 命令行）在位。

describe('旧面板收缩为视频专用（T6）：图片分支整块删除', () => {
  it('面板不再拉图片编码器目录，也不再自己选原图', () => {
    expect(flatPanel, '图片规格表只应留给条目队列与编辑弹窗').not.toContain(
      'advanced_image_catalog',
    );
    expect(flatPanel, '图片原图对话框的接线整块退场').not.toContain('pickReference');
    expect(flatPanel, '图片原图行（+ 重选按钮）整块退场').not.toContain('adv-reference');
    expect(flatPanel, '图片卡的命令行预览不再是本面板的依赖').not.toContain(
      'previewImageCommand',
    );
    expect(flatPanel, '图片规格查询不再是本面板的依赖').not.toContain('imageSpecOf');
  });

  it('创建流程只剩「建轮 + 写轮备注」，图片的产物生成与跑分接线退场', () => {
    for (const gone of [
      "kind==='image'",
      '创建并生成',
      'addCandidates',
      'setReference',
      'scoreRound',
      'askConflict',
      '正在生成',
    ]) {
      expect(flatPanel, `旧图片分支残留：${gone}`).not.toContain(gone);
    }
  });

  it('图片组误入旧面板立即抛错（防御性断言，不留半条路）', () => {
    expect(flatPanel, '编译期的 kind 联合类型之外，运行期也要挡').toContain(
      "if(String(deps.kind)!=='video')",
    );
    expect(flatPanel, '报错文案要指明该走条目列表面板').toContain(
      '高级创建面板仅供视频跑分组使用',
    );
    expect(flatPanel, '抛错而不是静默返回（静默 = 半条路）').toContain('thrownewError(');
  });
});

describe('视频侧高级创建完整保留（T6 回归）', () => {
  it('原视频预填 + 视频编码器目录（静态规格 + ffmpeg 枚举）+ ffmpeg 就绪提示', () => {
    expect(flatPanel, '会话态按视频口径取').toContain("sessionFor(groupId,'video')");
    expect(flatPanel, '本轮已选原视频时预填（命令行预览用）').toContain(
      'session.referencePath=deps.initialReference()',
    );
    expect(flatPanel).toContain("invoke<AdvancedVideoCatalog>('advanced_video_catalog')");
    expect(flatPanel, 'ffmpeg 就绪/不可用都要给出提示').toContain('ffmpegStatus.textContent');
    expect(flatPanel, '卡片目录按视频口径传参（图片规格表为空）').toContain(
      "constcatalog:EncoderCardCatalog={kind:'video',imageSpecs:[],videoCatalog}",
    );
  });

  it('默认条目与目录拉取失败时的表外条目都保留', () => {
    expect(flatPanel, '首次打开铺一条视频规格表首条').toContain(
      'constfirst=videoCatalog.specs[0]',
    );
    expect(flatPanel, '目录不可用时退到表外 libx264（只支持参数行）').toContain(
      "addEntry(session,'libx264',{",
    );
  });

  it('建轮前仍做 ffmpeg 可用性校验（unavailable 拦下并红标）', () => {
    expect(flatPanel, '视频条目统一按 ffmpeg 查可用性（表外编码器同此）').toContain(
      "consttoolKeyOf=(_entry:AdvancedEntry):string|null=>'ffmpeg'",
    );
    expect(flatPanel).toContain("invoke<ToolStatusLite[]>('advanced_encoder_status',{keys})");
    expect(flatPanel).toContain('availabilityErrors(session.entries,toolKeyOf,statuses)');
    expect(flatPanel, '不可用条目在卡上红标').toContain(
      'unavailableError:unavailableEntries.get(entry.id)??null',
    );
  });

  it('创建评测轮：校验 → 建轮 → 写轮备注（编码器 + 参数摘要 + 命令行）', () => {
    expect(flatPanel).toContain("createBtn.textContent='创建评测轮'");
    expect(flatPanel, '坏参数不建轮').toContain('consterrors=validateAll()');
    expect(flatPanel).toContain('created=awaitdeps.createRound()');
    expect(flatPanel, '备注内容由 buildVideoNote 生成').toContain('buildVideoNote()');
    expect(flatPanel).toContain(
      'awaitdeps.setRoundNote(created.groupId,created.roundId,buildVideoNote())',
    );
    expect(flatPanel, '参数摘要走宽松合并（与预览同口径）').toContain(
      'buildEntryArgsLenient(spec,entry)',
    );
    expect(flatPanel, '命令行预览逐条写进轮备注').toContain(
      'previewVideoCommand(spec,entry,session.referencePath)',
    );
    // 建轮成功后丢弃会话态、关闭面板并刷新主界面（与 T29-3 行为一致）
    expect(flatPanel).toContain('dropSession(groupId)');
    expect(flatPanel).toContain('deps.rerender()');
  });
});
