// 顶栏状态栏长文案优化的回归守卫。vitest 是 node 环境（无 DOM），布局类断言
// （「header 高度恒定」）无法直接测，改为守卫保证该结论的两端：
//   1) 样式端：.status 有宽度上限、.status-text 单行截断（nowrap + hidden +
//      ellipsis）——这三条在，无论错误多少字符 header 都不会被撑高；
//   2) 全文可达端（票 #58）：截断状态文本本身可点，点击弹模态全文卡片——
//      正文可选可滚、头部一键复制；Ⓘ 悬浮气泡已退场；
//   3) 挂载端：可点态只在真截断时出现（scrollWidth 比较）。
// 约束任何一条被后续改动删掉，这里变红。
// 样式与源码经 vite 的 ?raw 后缀以文本导入（vitest 走同一管线，无需 node 内建）。

import { describe, it, expect } from 'vitest';
import css from './style.css?raw';
import mainTs from './main.ts?raw';

const flatCss = (): string => css.replace(/\s+/g, '');
const flatMain = mainTs.replace(/\s+/g, '');

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

describe('全文可达端：状态全文卡片（票 #58）', () => {
  it('卡片限高、正文滚动可读（上千字符也能看全）', () => {
    expect(ruleBlock('.status-card')).toContain('max-height:min(30rem,80vh)');
    const body = ruleBlock('.status-card-body');
    expect(body).toContain('overflow-y:auto');
    expect(body, '选择复制：正文可手动选中部分内容').toContain('user-select:text');
    expect(body, '错误多为路径/命令/原始输出，等宽排版更可读').toContain('var(--mono');
  });

  it('遮罩复用设置面板同款（观感一致、点遮罩即关）', () => {
    expect(flatMain).toContain("overlay.className='settings-overlay'");
    expect(flatMain).toContain('if(e.target===overlay)close()');
  });

  it('可点态观感：手型 + 悬停下划线 + 键盘焦点环', () => {
    const more = ruleBlock('.status-more');
    expect(more).toContain('cursor:pointer');
    expect(flatCss()).toContain('.status-more:hover{text-decoration:underline');
    expect(flatCss()).toContain('.status-more:focus-visible{outline:2pxsolidvar(--accent)');
  });
});

describe('挂载端（main.ts）：截断才可点、ⓘ 退场、卡片三路关闭与一键复制', () => {

  it('截断检测走 scrollWidth 与 clientWidth 比较（未截断保持纯展示）', () => {
    expect(flatMain).toContain('if(probe.scrollWidth<=probe.clientWidth)return;');
  });

  it('Ⓘ 悬浮气泡彻底退场（status-detail / status-bubble / infoIconSvg）', () => {
    expect(flatMain, '状态栏不得再有 ⓘ 挂点').not.toContain('status-detail');
    expect(flatMain).not.toContain('status-bubble');
    expect(flatMain).not.toContain('infoIconSvg');
    expect(flatMain).not.toContain('wireBubbleFlip');
  });

  it('截断文本本身可点（button 语义 + 点击开卡片）', () => {
    expect(flatMain).toContain("more.className='status-textstatus-more'");
    expect(flatMain, 'button 键盘可达，无需 tabindex 手挂').toContain("more.type='button'");
    expect(flatMain).toContain('more.addEventListener(\'click\',()=>openStatusCard(title,isError))');
    expect(flatMain, '此处无气泡共存，原生 tooltip 不双弹').toContain("'点击查看完整内容'");
  });

  it('卡片三路关闭：× / 点遮罩 / Esc（与既有菜单口径一致）', () => {
    expect(flatMain).toContain("closeBtn.textContent='×'");
    expect(flatMain).toContain("if(e.key==='Escape')close()");
    expect(flatMain).toContain('document.removeEventListener(\'keydown\',onKey)');
  });

  it('一键复制全部 + 按钮瞬时反馈；标题按错误/普通区分', () => {
    expect(flatMain).toContain('copyText(title,');
    expect(flatMain).toContain("'复制全部'");
    expect(flatMain).toContain("'已复制'");
    expect(flatMain).toContain("isError?'错误详情':'完整状态内容'");
  });
});
