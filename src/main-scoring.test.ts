// 主界面整轮跑分入口的机制守卫（src/main.ts 是 DOM/IPC 接线，node 环境跑不起来；
// 本仓库约定不引 jsdom，DOM 侧一律用「?raw 源码文本 + 压平空白」钉机制，先例见
// src/image-queue-panel.test.ts / src/image-entry-editor.test.ts）。
//
// 这里钉两条 review 修复：
// - F1：跑分行内状态（scoringPaths）由 scoreAllCandidates 自己收口清空。条目列表面板
//   的增量跑分经 scoreRound 复用本函数，它不清就没有第二个清空点，主界面结果表里
//   这些行会永久停在「跑分中…」。
// - F8：`paths` 传参口径——无子集时不带这个键（与后端「不传 = 整轮全量」的注释、
//   主界面「开始跑分」/ 一站式入口的实际调用一致）。

import { describe, expect, it } from 'vitest';
import mainSource from './main.ts?raw';

const flat = mainSource.replace(/\s+/g, '');

/** 取一段函数体原文（压平空白后按下标切片，避免为 DOM 代码引 jsdom）。 */
function sliceFlat(startMarker: string, endMarker: string): string {
  const start = flat.indexOf(startMarker);
  expect(start, `找不到起点标记 ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = flat.indexOf(endMarker, start);
  expect(end, `找不到终点标记 ${endMarker}`).toBeGreaterThan(start);
  return flat.slice(start, end);
}

describe('scoreAllCandidates：行内「跑分中…」状态自己收口（F1）', () => {
  const body = sliceFlat('asyncfunctionscoreAllCandidates(', 'asyncfunctionrunOnestop(');

  it('待跑清单设进 scoringPaths（行内状态的数据源）', () => {
    expect(body).toContain('scoringPaths=newSet(targetPaths)');
  });

  it('清空写在函数自己的 finally 里，且在 finally 内先清空再 render', () => {
    const finallyAt = body.indexOf('finally{');
    expect(finallyAt, 'scoreAllCandidates 必须有自己的 try/finally').toBeGreaterThanOrEqual(0);
    const tail = body.slice(finallyAt);
    const clearAt = tail.indexOf('scoringPaths=newSet()');
    expect(clearAt, 'finally 里必须清空 scoringPaths').toBeGreaterThanOrEqual(0);
    const renderAt = tail.indexOf('render()');
    expect(renderAt, '清空后要 render 让行内状态立刻刷新').toBeGreaterThan(clearAt);
  });

  it('整轮 invoke 在 try 里（异常也要走到 finally 清空）', () => {
    const tryAt = body.indexOf('try{');
    const invokeAt = body.indexOf("invoke('round_score_candidates'");
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(invokeAt, '跑分 IPC 必须在 try 内').toBeGreaterThan(tryAt);
  });
});

describe('scoreAllCandidates：paths 传参口径（F8）', () => {
  const body = sliceFlat('asyncfunctionscoreAllCandidates(', 'asyncfunctionrunOnestop(');

  it('无子集时不带 paths 键，而不是传 null', () => {
    expect(body, '不得再显式传 null 冒充「不传」').not.toContain('paths===undefined?null');
    expect(body, '按有无子集决定是否写这个键').toContain('if(paths!==undefined)invokeArgs.paths=');
    expect(body, '传参对象统一成变量后 submit').toContain("invoke('round_score_candidates',invokeArgs)");
  });

  it('有子集时只传这些路径（增量跑分的子集口径不变）', () => {
    expect(body).toContain('[...paths]');
  });
});
