// 注册契约守卫：页签 id / order / kinds 与命令 id 必须和外壳一致。
//
// 仓库测试是 node 环境（无 DOM），index.ts 会连带 core/ui-state 的 localStorage
// 读取，不能直接 import；这里按既有约定用 ?raw 读源码文本做机制断言。

import { describe, expect, it } from 'vitest';
import bdrateSource from './bdrate-tab.ts?raw';
import exportSource from './export-menu.ts?raw';
import indexSource from './index.ts?raw';
import resultsSource from './results-tab.ts?raw';
import tableSource from './table.ts?raw';
import resultsCss from '../../styles/results.css?raw';

const flat = (source: string): string => source.replace(/\s+/g, '');

describe('页签注册', () => {
  const source = flat(indexSource);

  it('两个页签都注册，id 与外壳一致', () => {
    expect(source).toContain('registerDockTab(resultsTab)');
    expect(source).toContain('registerDockTab(bdrateTab)');
  });

  it('导出命令 id 为 export-menu（快捷键由外壳派发）', () => {
    expect(source).toContain("registerCommand({id:'export-menu'");
  });

  it('评分表页签：id results / order 10 / 图片与视频组都挂', () => {
    const results = flat(resultsSource);
    expect(results).toContain("id:'results'");
    expect(results).toContain('order:10');
    expect(results).toContain("kinds:['image','video']");
  });

  it('BD-rate 页签：id bdrate / order 20 / 图片与视频组都挂', () => {
    const bdrate = flat(bdrateSource);
    expect(bdrate).toContain("id:'bdrate'");
    expect(bdrate).toContain('order:20');
    expect(bdrate).toContain("kinds:['image','video']");
  });
});

describe('交互机制', () => {
  it('排序状态按轮保存（roundScoped 的 results.sort）', () => {
    expect(flat(resultsSource)).toContain("roundScoped<SortHolder>('results.sort'");
  });

  it('展开态按轮保存', () => {
    expect(flat(resultsSource)).toContain("roundScoped<ExpandedHolder>('results.expanded'");
  });

  it('表头写真实 aria-sort（不是只画箭头）', () => {
    expect(flat(tableSource)).toContain("setAttribute('aria-sort'");
  });

  it('排序键挂在 [data-sort-key] 上，便于重排后还原焦点', () => {
    expect(flat(tableSource)).toContain('dataset:{sortKey:column.key}');
    expect(flat(tableSource)).toContain('dataset.sortKey');
  });

  it('导出菜单含四个动作：导出 CSV/HTML + 复制 CSV/Markdown', () => {
    const source = flat(exportSource);
    expect(source).toContain("label:'导出CSV…'");
    expect(source).toContain("label:'导出HTML…'");
    expect(source).toContain("label:'复制为CSV'");
    expect(source).toContain("label:'复制为Markdown'");
  });

  it('BD-rate 失败给重试按钮，而不是一行红字', () => {
    const bdrate = flat(bdrateSource);
    expect(bdrate).toContain("label:'重试'");
    expect(bdrate).toContain('results-inline-error');
  });

  it('跑分行内状态来自 store 的 isPathRunning', () => {
    expect(flat(resultsSource)).toContain('isPathRunning(candidate.path)');
  });

  it('最佳值用视觉隐藏文本兜底（不只靠底色）', () => {
    expect(flat(resultsSource)).toContain("srText:isTop?'最佳'");
  });

  it('无结果空态是一行说明，不用大空态组件占满结果坞', () => {
    expect(flat(resultsSource)).toContain("'跑分后这里出现指标表'");
    expect(flat(resultsSource)).not.toContain('emptyState(');
    expect(flat(bdrateSource)).toContain("'跑分后这里出现BD-rate汇总'");
    expect(flat(bdrateSource)).not.toContain('emptyState(');
  });

  it('空态说明用 12px 令牌字号，容器不再垂直居中占满', () => {
    expect(flat(resultsCss)).toContain(
      '.results-empty-note{margin:0;color:var(--text-subtle);font-size:var(--fs-meta)',
    );
    expect(flat(resultsCss)).toContain('.results-tab__empty{flex:00auto;');
  });
});
