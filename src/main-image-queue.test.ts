// 票 #82（T10）主界面接线的机制守卫：src/main.ts 是 DOM/IPC 接线，node 环境跑不起来；
// 仓库约定不引 jsdom，DOM 侧一律用「?raw 源码文本 + 压平空白」钉机制（先例见
// src/main-scoring.test.ts / src/image-queue-panel.test.ts）。
//
// 这里钉票面的五件事：
// - 胶囊本体：**图片组 + 命中条目**才挂 onClick，点击时按会话态重新解析条目；
// - 胶囊的 × 仍只做移除（stopPropagation 在 buildPill 里，不在调用方抢）；
// - 「开始跑分」仍是整轮全量（scoreAllCandidates() 不带 paths）；
// - 「重跑改过的（N 张）」与 planScore 同源、0 张也不置灰；
// - 面板与主界面共用同一份编排（runQueuePlanOnce / buildQueueRunExecutor）。
//
// 行为断言不在这里：计划与零调用的真跑在 src/image-queue-runtime.test.ts，
// 反查条目的纯逻辑在 src/image-queue.test.ts。

import { describe, expect, it } from 'vitest';
import mainSource from './main.ts?raw';
import panelSource from './image-queue-panel.ts?raw';
import runtimeSource from './image-queue-runtime.ts?raw';
import pillsSource from './pills.ts?raw';

const flatMain = mainSource.replace(/\s+/g, '');
const flatPanel = panelSource.replace(/\s+/g, '');
const flatRuntime = runtimeSource.replace(/\s+/g, '');
const flatPills = pillsSource.replace(/\s+/g, '');

/** 取一段源码原文（压平空白后按下标切片，避免为 DOM 代码引 jsdom）。 */
function sliceFlat(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `找不到起点标记 ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `找不到终点标记 ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const imageGroupBody = (): string =>
  sliceFlat(flatMain, 'functionrenderImageGroupContent(', 'functionrenderVideoGroupContent(');
const videoGroupBody = (): string =>
  sliceFlat(flatMain, 'functionrenderVideoGroupContent(', 'functionbuildResultTable(');

// ---------- 胶囊即参数入口 ----------

describe('主界面胶囊：由条目产出的跑分图点开参数弹窗（票 #82）', () => {
  it('胶囊构造时反查条目，命中才挂 onClick；点击时按会话态重新解析（不吃闭包旧对象）', () => {
    const body = imageGroupBody();
    expect(body, '构造胶囊时先反查产出它的条目').toContain(
      'constowner=entryForArtifact(queueEntries,c.path);',
    );
    expect(body, '命中条目才挂 onClick，未命中不挂（不给假交互）').toContain(
      'onClick:owner===null?undefined:()=>voidopenCandidateEntryEditor(session.group.id,c.path),',
    );

    const editor = sliceFlat(
      flatMain,
      'asyncfunctionopenCandidateEntryEditor(',
      'asyncfunctionrerunChangedImages(',
    );
    expect(editor, '点击时按当前会话态重新解析条目').toContain(
      'constentry=entryForArtifact(imageQueueFor(groupId).entries,candidatePath);',
    );
    expect(editor, '反查不到就不弹窗').toContain('if(entry===null){');
    expect(editor, '弹窗直接复用逐图编辑弹窗（不另写一套参数界面）').toContain(
      'openImageEntryEditor(groupId,entry,',
    );
    expect(editor, '弹窗依赖与面板同一份接线').toContain('queueEditorDeps(groupId,host,');
    expect(editor, '打开前把标识读新（徽章判定与面板同口径）').toContain('refreshQueueIdentities(');
    expect(editor, '关闭弹窗后刷新主界面（按钮计数随之变化）').toContain('render();');
  });

  it('× 仍只做移除：移除走 onRemove，stopPropagation 由 buildPill 负责', () => {
    const body = imageGroupBody();
    expect(body).toContain('onRemove:()=>removeCandidate(c.path),');
    expect(flatPills, '× 不能冒泡到胶囊本体的 onClick').toContain('e.stopPropagation()');
    // 点击本体不得被改成删除
    expect(body).not.toContain('onClick:()=>removeCandidate');
  });

  it('人工导入的跑分图不挂 onClick，但悬浮提示说明为什么点不开', () => {
    const body = imageGroupBody();
    expect(body).toContain('这张跑分图不是由图片条目产出的');
    // 命中与否的判断只有一处（onClick 的条件），不另造第二套猜测
    expect(body).not.toContain('entryForArtifact(queueEntries,c.path)!==null');
  });

  it('视频组不受影响：不接条目反查、参数入口与增量重跑', () => {
    const video = videoGroupBody();
    expect(video).not.toContain('entryForArtifact');
    expect(video).not.toContain('openCandidateEntryEditor');
    expect(video).not.toContain('rerunChangedImages');
    expect(video, '视频组仍只挂导出与视频区块').toContain('mountVideoBlock(videoBlock,{');
  });
});

// ---------- 主界面「重跑改过的（N 张）」 ----------

describe('主界面「重跑改过的（N 张）」按钮（票 #82）', () => {
  it('按钮文案与计划同源：rerunChangedButtonLabel(planScore(本组条目, 标识探针))', () => {
    const body = imageGroupBody();
    expect(body).toContain(
      'rerunChangedButtonLabel(planScore(queueEntries,queueIdentityProbe()))',
    );
    expect(body, '按钮进操作区').toContain('rerunBtn');
  });

  it('0 张时仍可点：置灰只看忙标志，不看计划张数', () => {
    const body = imageGroupBody();
    expect(body, '0 张不置灰（点开只弹「无需重跑」提示）').toContain('rerunBtn.disabled=scoring;');
    expect(body, '不得按待跑张数置灰').not.toContain('rerunBtn.disabled=scoring||');
  });

  it('点击走共享增量编排（与面板同一份），不是整轮全量', () => {
    const body = sliceFlat(
      flatMain,
      'asyncfunctionrerunChangedImages(',
      'asyncfunctionstartScoring(',
    );
    expect(body, '交给共享编排').toContain('awaitrunQueuePlanOnce({');
    expect(body, '传当前组的条目队列').toContain('entries:imageQueueFor(groupId).entries,');
    expect(body, '不得改走整轮全量入口').not.toContain('scoreAllCandidates');
    expect(body, '跑完主界面原地刷新').toContain('render();');
  });
});

// ---------- 「开始跑分」保持整轮全量 ----------

describe('「开始跑分」仍是整轮全量（票面必须保持）', () => {
  it('startScoring 仍不带 paths 调用 scoreAllCandidates()', () => {
    const body = sliceFlat(
      flatMain,
      'asyncfunctionstartScoring(',
      'asyncfunctionscoreAllCandidates(',
    );
    expect(body).toContain('awaitscoreAllCandidates();');
  });

  it('一站式入口的整轮调用点也没变', () => {
    const body = sliceFlat(flatMain, 'asyncfunctionrunOnestop(', 'functionbuildOnestopControls(');
    expect(body).toContain('awaitscoreAllCandidates();');
  });

  it('增量入口（面板 / 主界面按钮）只经共享编排传子集路径，不直连整轮 IPC', () => {
    // 整轮 IPC 只出现在 scoreAllCandidates 一处（由宿主的 scoreRound 复用）
    expect(flatPanel).not.toContain("invoke('round_score_candidates'");
    const body = sliceFlat(
      flatMain,
      'asyncfunctionrerunChangedImages(',
      'asyncfunctionstartScoring(',
    );
    expect(body).not.toContain("invoke('round_score_candidates'");
  });
});

// ---------- 编排只有一份 ----------

describe('编排只有一份：面板与主界面共用（票 #82 的抽取要求）', () => {
  it('两边都从 image-queue-runtime 导入并调用同一份 runQueuePlanOnce', () => {
    for (const [label, source] of [
      ['main.ts', flatMain],
      ['image-queue-panel.ts', flatPanel],
    ] as const) {
      expect(source, `${label} 应共用共享运行时`).toContain("from'./image-queue-runtime'");
      expect(source, `${label} 应调用共享编排`).toContain('runQueuePlanOnce({');
    }
    expect(flatRuntime).toContain('exportasyncfunctionrunQueuePlanOnce(');
    expect(flatRuntime).toContain('exportfunctionbuildQueueRunExecutor(');
  });

  it('没有第二份执行器：面板与主界面都不自己拼 QueueRunExecutor', () => {
    for (const source of [flatMain, flatPanel]) {
      expect(source).not.toContain('constbuildExecutor=');
      expect(source).not.toContain('scoreCandidates:(_entry');
    }
  });

  it('宿主依赖只有一份：高级创建入口只把共用 deps 交给面板', () => {
    const body = sliceFlat(
      flatMain,
      'functionopenImageQueueCreation(',
      'functionopenAdvancedCreation(',
    );
    expect(body).toContain('openImageQueuePanel(group.id,imageQueueHostDeps());');
    expect(body, 'deps 实现收进 imageQueueHostDeps（三条入口共用）').not.toContain(
      "invoke('advanced_encode'",
    );
  });
});
