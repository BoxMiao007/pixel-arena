// 票 #77（T3 图片条目列表面板）/ 票 #79（T5 增量跑分）的前端测试，两类断言：
//
// 1. **行为**（node 环境可直接跑）：面板的纯逻辑——标识回包折成探针缓存、删条目是否
//    连带删轮、删除确认文案、编码成功但跑分失败的行折成失败。跑分编排本身（只跑计划内、
//    无待跑零调用、失败不阻断、汇总文案）在 src/image-queue-run.test.ts 用假执行器真跑。
// 2. **机制**（?raw 导入源码文本）：面板 DOM 无法在 node 环境渲染（本仓库约定不引
//    jsdom），沿用 advanced-ui.test.ts 的先例，压平空白后断言机制在位——添加不弹窗、
//    四态徽章文案、模态卡片三路关闭、无待跑提示卡片、汇总卡片、面板不关闭。
//
// 判定算法本身（四态 / 脏原因 / 计划拆分）已在 src/image-queue.test.ts 由 T2 覆盖，
// 这里只测「面板怎么用这些结论」。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachRound,
  clearImageQueues,
  imageQueueFor,
  IMAGE_ENTRY_STATE_LABELS,
  newImageEntry,
  type EncoderRunOutcome,
} from './image-queue';
import { mergeScoreFailures } from './image-queue-run';
import { identityReadingsOf, planDelete } from './image-queue-panel';
import panelSource from './image-queue-panel.ts?raw';
import runSource from './image-queue-run.ts?raw';
import queueSource from './image-queue.ts?raw';
import mainSource from './main.ts?raw';
import css from './style.css?raw';

beforeEach(() => {
  clearImageQueues();
});

describe('图片标识回包 → 探针缓存（接后端 image_identities）', () => {
  it('读到的行给出 ok 标识，读不到的行给出带后端原因的失败分支', () => {
    const readings = identityReadingsOf([
      { path: '/photos/a.png', sizeBytes: 1024, modifiedMs: 1_700_000_000_000, error: null },
      {
        path: '/photos/b.png',
        sizeBytes: null,
        modifiedMs: null,
        error: '读取图片信息失败：文件不存在',
      },
    ]);

    expect(readings.get('/photos/a.png')).toEqual({
      kind: 'ok',
      identity: { path: '/photos/a.png', sizeBytes: 1024, modifiedMs: 1_700_000_000_000 },
    });
    expect(readings.get('/photos/b.png')).toEqual({
      kind: 'failed',
      path: '/photos/b.png',
      reason: '读取图片信息失败：文件不存在',
    });
  });

  it('字段缺失或不是有限数按读取失败处理（判定保守重跑，不误跳过）', () => {
    const readings = identityReadingsOf([
      { path: 'a.png', sizeBytes: null, modifiedMs: 1, error: null },
      { path: 'b.png', sizeBytes: 1, modifiedMs: null, error: null },
      { path: 'c.png', sizeBytes: Number.NaN, modifiedMs: Number.NaN, error: null },
    ]);
    for (const path of ['a.png', 'b.png', 'c.png']) {
      expect(readings.get(path)?.kind, `${path} 应按读取失败`).toBe('failed');
    }
  });
});

describe('删条目：有轮就连带删轮，确认文案点名轮名与结果条数', () => {
  it('有评测轮：文案点名「评测轮『XXX』与它的 N 条跑分结果」并写明磁盘产物不删', () => {
    const entry = newImageEntry('/photos/photo.png');
    attachRound(entry, 'r-3');

    const plan = planDelete(entry, { name: '评测轮 3（photo.png）', candidateCount: 2 });

    expect(plan.roundId).toBe('r-3');
    expect(plan.fileName).toBe('photo.png');
    expect(plan.message).toContain('评测轮『评测轮 3（photo.png）』与它的 2 条跑分结果');
    expect(plan.message).toContain('磁盘上的产物文件不会被删除');
    expect(plan.message).toContain('不会删除');
  });

  it('还没有轮（只添加过、一次没跑）：不连带删轮，文案仍写明不会删除文件', () => {
    const entry = newImageEntry('/photos/never.png');

    const plan = planDelete(entry, null);

    expect(plan.roundId).toBeNull();
    expect(plan.fileName).toBe('never.png');
    expect(plan.message).toContain('never.png');
    expect(plan.message).toContain('不会删除');
  });

  it('roundId 指向的轮已不在工作区（外面删过）：不拿旧 id 去删', () => {
    const entry = newImageEntry('/photos/gone.png');
    attachRound(entry, 'r-7');

    expect(planDelete(entry, null).roundId).toBeNull();
  });
});

describe('编码成功但跑分失败的行不算已跑分（快照只收成功）', () => {
  it('产物行内有 error 的结果折成失败并带上后端原因', () => {
    const outcomes: EncoderRunOutcome[] = [
      { kind: 'success', cardId: 'c1', artifactPath: '/out/a.jpg', fingerprint: 'fp1' },
      { kind: 'success', cardId: 'c2', artifactPath: '/out/b.jpg', fingerprint: 'fp2' },
      { kind: 'failure', cardId: 'c3', reason: '编码器不可用' },
    ];
    const scored = [
      { path: '/out/a.jpg', error: '解码失败：文件损坏' },
      { path: '/out/b.jpg', error: null },
    ];

    expect(mergeScoreFailures(outcomes, scored)).toEqual([
      { kind: 'failure', cardId: 'c1', reason: '解码失败：文件损坏' },
      { kind: 'success', cardId: 'c2', artifactPath: '/out/b.jpg', fingerprint: 'fp2' },
      { kind: 'failure', cardId: 'c3', reason: '编码器不可用' },
    ]);
  });

  it('跑分结果里没出现该产物（例如还没进轮）时保持成功结论不动', () => {
    const outcomes: EncoderRunOutcome[] = [
      { kind: 'success', cardId: 'c1', artifactPath: '/out/missing.jpg', fingerprint: 'fp1' },
    ];
    expect(mergeScoreFailures(outcomes, [])).toEqual(outcomes);
  });
});

// 供后续用例复用的会话断言：队列与面板共享同一份会话态（按跑分组键控）
describe('会话态按跑分组键控（面板读写的就是 T2 的队列）', () => {
  it('同一组的队列是同一个对象，不同组互不影响', () => {
    expect(imageQueueFor('g-1')).toBe(imageQueueFor('g-1'));
    expect(imageQueueFor('g-1')).not.toBe(imageQueueFor('g-2'));
  });
});

// ---------- DOM 机制守卫（?raw 源码文本 + 压平空白，仓库约定不引 jsdom） ----------

const flat = panelSource.replace(/\s+/g, '');
const rawSource = panelSource;
const flatCss = css.replace(/\s+/g, '');
const flatQueue = queueSource.replace(/\s+/g, '');
const flatRun = runSource.replace(/\s+/g, '');
const flatMain = mainSource.replace(/\s+/g, '');

describe('添加图片不弹窗（票面验收：多选后直接入列）', () => {
  it('添加动作只调 pickImages + addImagePaths，不经任何编辑/确认面板', () => {
    const start = flat.indexOf('constaddImages=');
    expect(start, '应有添加图片的动作实现').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf("addBtn.addEventListener('click'", start);
    expect(end).toBeGreaterThan(start);
    const body = flat.slice(start, end);
    expect(body, '选图走注入的 pickImages（系统多选对话框）').toContain('awaitdeps.pickImages()');
    expect(body, '选中路径直接进队列').toContain('addImagePaths(session,paths)');
    // 添加流程里不得出现任何弹窗/确认：编辑弹窗属 T4，添加永不弹窗
    for (const banned of ['confirmCard(', 'openAdvancedPanel', 'askFileConflict']) {
      expect(body, `添加流程不得出现 ${banned}`).not.toContain(banned);
    }
  });

  it('多选对话框按 multiple:true 打开（宿主实现侧）：deps 契约写明多选', () => {
    expect(rawSource, 'deps 的 pickImages 契约注明多选').toContain('系统多选对话框选图片');
  });
});

describe('四态徽章文案（单一来源 IMAGE_ENTRY_STATE_LABELS）', () => {
  it('四态中文名逐条对得上（真跑，不是只查字面量）', () => {
    expect(IMAGE_ENTRY_STATE_LABELS).toEqual({
      unscored: '未跑分',
      scored: '已跑分',
      stale: '将重跑',
      failed: '上次失败',
    });
  });

  it('徽章文案经 badgeText 生成，不自造第二套四态字面量', () => {
    expect(flat, '徽章文案取 T2 的单一来源').toContain(
      'badge.textContent=badgeText(verdict.state,verdict.reasons)',
    );
    // 四态中文名住在 image-queue.ts；面板若自带一份字面量就会两处漂移
    expect(flatQueue).toContain("unscored:'未跑分'");
    expect(flatQueue).toContain("scored:'已跑分'");
    expect(flatQueue).toContain("stale:'将重跑'");
    expect(flatQueue).toContain("failed:'上次失败'");
    expect(flat, '面板不得复制四态中文名').not.toContain("'未跑分'");
    expect(flat).not.toContain("'已跑分'");
    expect(flat).not.toContain("'将重跑'");
    expect(flat).not.toContain("'上次失败'");
  });

  it('徽章 class 按状态区分（CSS 才能按四态着色）', () => {
    expect(flat).toContain('badge.className=`queue-badgequeue-badge-${verdict.state}`');
  });
});

describe('模态卡片三路关闭（× / 点遮罩 / Esc + keydown 清理）', () => {
  it('删除确认卡片是 settings-overlay + status-card 的应用内模态（不抢系统焦点）', () => {
    expect(flat).toContain("overlay.className='settings-overlay'");
    expect(flat).toContain("panel.className='status-cardqueue-confirm-card'");
  });

  it('确认卡片三路关闭：× 按钮、点遮罩本身、Esc；关闭时摘掉 document 上的 keydown 监听', () => {
    const start = flat.indexOf('functionconfirmCard(');
    expect(start, '应有确认卡片实现').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('exportfunctionopenImageQueuePanel', start);
    expect(end).toBeGreaterThan(start);
    const body = flat.slice(start, end);
    // × 关闭
    expect(body).toContain("closeBtn.addEventListener('click',()=>finish(false))");
    // 点遮罩：只在点到遮罩本身时关（面板内部点击不冒到这一层）
    expect(body).toContain("overlay.addEventListener('click',(e)=>{if(e.target===overlay)finish(false)");
    // Esc
    expect(body, 'Esc 关闭').toContain("if(e.key==='Escape')finish(false)");
    expect(body, 'keydown 挂在 document 上').toContain("document.addEventListener('keydown',onKey)");
    // 清理：三路关闭共用 finish，先摘监听再移除遮罩
    expect(body, '关闭时必须摘掉 keydown 监听').toContain(
      "document.removeEventListener('keydown',onKey)",
    );
    const remove = body.indexOf("document.removeEventListener('keydown',onKey)");
    const detach = body.indexOf('overlay.remove()');
    expect(detach, '先摘监听再移除遮罩').toBeGreaterThan(remove);
  });

  it('删除确认按钮与取消按钮都在卡片内（确认才动手）', () => {
    expect(flat).toContain("confirmBtn.textContent='删除'");
    expect(flat).toContain("cancelBtn.textContent='取消'");
    const start = flat.indexOf('constdeleteEntry=');
    const body = flat.slice(start, start + 1200);
    expect(body, '确认结果决定是否继续').toContain('if(!confirmed)return');
    expect(body, '确认后先删轮再移除条目').toContain('awaitdeps.deleteRound(groupId,plan.roundId)');
    expect(body).toContain('removeImageEntry(session,plan.entryId)');
  });
});

describe('提示 / 汇总卡片（showQueueNotice）：三路关闭 + keydown 清理', () => {
  it('应用内模态：settings-overlay + status-card，正文按行渲染', () => {
    const start = flat.indexOf('exportfunctionshowQueueNotice(');
    expect(start, '应有 showQueueNotice 实现').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('exportfunctionopenImageQueuePanel', start);
    expect(end).toBeGreaterThan(start);
    const body = flat.slice(start, end);
    expect(body).toContain("overlay.className='settings-overlay'");
    expect(body).toContain("panel.className='status-cardqueue-notice-card'");
    expect(body, '正文按行拼接').toContain("body.textContent=lines.join('\\n')");
  });

  it('× / 点遮罩 / Esc 三路关闭，关闭时先摘 keydown 监听再移除遮罩', () => {
    const start = flat.indexOf('exportfunctionshowQueueNotice(');
    const end = flat.indexOf('exportfunctionopenImageQueuePanel', start);
    const body = flat.slice(start, end);
    expect(body).toContain("closeBtn.addEventListener('click',close)");
    expect(body).toContain("overlay.addEventListener('click',(e)=>{if(e.target===overlay)close()");
    expect(body).toContain("if(e.key==='Escape')close()");
    expect(body).toContain("document.addEventListener('keydown',onKey)");
    expect(body).toContain("document.removeEventListener('keydown',onKey)");
    const remove = body.indexOf("document.removeEventListener('keydown',onKey)");
    const detach = body.indexOf('overlay.remove()');
    expect(detach, '先摘监听再移除遮罩').toBeGreaterThan(remove);
  });
});

describe('删除文案包含「不会删除」（票面验收）', () => {
  it('删除确认文案点名轮名与结果条数，并写明不删磁盘产物', () => {
    const start = flat.indexOf('exportfunctionplanDelete(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('//----------面板DOM', start);
    const body = flat.slice(start, end);
    expect(body).toContain('评测轮『${round.name}』与它的${round.candidateCount}条跑分结果');
    expect(body, '文案必须写明不会删除磁盘文件').toContain('磁盘上的产物文件不会被删除');
    expect(body, '删除文案须包含「不会删除」').toContain('不会删除');
  });

  it('面板代码里确实把 planDelete 的文案交给确认卡片', () => {
    expect(flat).toContain('confirmCard({title:');
    expect(flat).toContain('message:plan.message');
  });
});

describe('列表行与徽章（中间截断文件名 / 删除按钮 / 重复提示）', () => {
  it('文件名中间截断（复用 util.truncateFileName），悬浮给全路径', () => {
    expect(flat).toContain('truncateFileName(fileName(entry.path))');
    expect(flat).toContain('name.title=entry.path');
  });

  it('同一路径重复添加显示「重复图片」提示（只提示、不禁止）', () => {
    expect(flat, '重复识别复用 T2 的 duplicateEntryIds').toContain(
      'duplicateEntryIds(entries)',
    );
    expect(flat).toContain("dup.textContent='重复图片'");
    expect(flat).toContain('cells.push(dup)');
  });

  it('每行都有删除按钮（×）', () => {
    expect(flat).toContain("del.className='queue-delete'");
    expect(flat).toContain("del.textContent='×'");
  });
});

describe('增量跑分接线（T5：按钮待跑数量 / 只跑计划内 / 无待跑提示 / 汇总卡片）', () => {
  it('按钮文案按当前计划算 N = plan.runImageCount（编辑弹窗改参数后同一路径重算）', () => {
    expect(flat, '按钮文案取 scoreButtonLabel(计划, 条目)').toContain(
      "scoreBtn.textContent=running?'跑分中…':scoreButtonLabel(currentPlan(),session.entries)",
    );
    // 编辑弹窗关闭回调里 renderList → syncChrome → 重算按钮
    expect(flat).toContain('editorOpen=false;renderList();})');
  });

  it('跑分流程走 runScorePlan（只跑计划内的编码器卡），计划为空只弹提示卡片', () => {
    const start = flat.indexOf('construnScoring=');
    expect(start, '应有跑分动作').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf("scoreBtn.addEventListener('click'", start);
    const body = flat.slice(start, end);
    expect(body, '跑分交给增量编排层').toContain(
      'runScorePlan(session.entries,probe,buildExecutor()',
    );
    expect(body, '无待跑时只弹提示卡片').toContain(
      'showQueueNotice([NOTHING_TO_RUN_MESSAGE],{title:',
    );
    expect(body, '有待跑时弹汇总卡片').toContain('showQueueNotice(summaryLines(report.plan),{title:');
    // 面板不得自行按全量重建任务清单：计划与跳过全部来自 planScore/runScorePlan
    expect(body).not.toContain('planQueueRun');
  });

  it('无待跑提示文案是单一来源，且编排层在计划为空时不碰执行器', () => {
    expect(flatRun, '提示文案住在 image-queue-run.ts').toContain(
      "NOTHING_TO_RUN_MESSAGE='所有图片已跑分且无变更，无需重跑'",
    );
    const start = flatRun.indexOf('exportasyncfunctionrunScorePlan(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flatRun.indexOf('constbyId=newMap', start);
    const body = flatRun.slice(start, end);
    expect(body, '先算计划').toContain('constplan=planScore(');
    expect(body, '计划为空直接返回、不调用执行器').toContain('if(isPlanEmpty(plan)){');
    expect(body).toContain('onNothingToRun?.(plan)');
    expect(body).toContain('return{plan,ran:false,images:[]}');
  });

  it('跑完面板不关闭：跑分流程里没有 close() 调用，跑完原地重渲染列表', () => {
    const start = flat.indexOf('construnScoring=');
    const body = flat.slice(start, flat.indexOf("scoreBtn.addEventListener('click'", start));
    expect(body).not.toContain('close()');
    expect(body, '每张跑完原地刷新').toContain('onImageDone:()=>renderList()');
    expect(body, '跑完 finally 重渲染').toContain('renderList()');
  });

  it('执行器把本次新增产物路径传给 scoreRound（子集跑分，不重跑整轮）', () => {
    const start = flat.indexOf('constbuildExecutor=');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('construnScoring=', start);
    const body = flat.slice(start, end);
    expect(body, '只传本次产物路径').toContain(
      'scoreCandidates:(_entry,roundId,paths)=>deps.scoreRound(groupId,roundId,[...paths])',
    );
  });
});

describe('CSS 复用既有 settings 视觉语言（不新造设计体系）', () => {
  it('面板与遮罩沿用 settings-overlay / settings-panel，条目样式挂在 queue-* 命名空间', () => {
    expect(flatCss).toContain('.queue-panel{');
    expect(flatCss).toContain('.queue-row{');
    expect(flatCss).toContain('.queue-badge{');
    // 徽章四态：每个状态一个修饰类，颜色取主题变量
    for (const state of ['unscored', 'scored', 'stale', 'failed']) {
      expect(flatCss, `缺少 .queue-badge-${state} 规则`).toContain(`.queue-badge-${state}{`);
    }
    expect(flatCss).toContain('.queue-delete{');
    expect(flatCss).toContain('.queue-confirm-card.status-card-body{');
  });
});

// ---------- 主界面接线（main.ts 分派）：图片组走新面板、视频组走旧面板 ----------

describe('主界面分派（票面：图片组第一次进的就是新界面）', () => {
  it('openAdvancedCreation 按组类型分派：image → 新列表面板，video → 旧面板', () => {
    const start = flatMain.indexOf('functionopenAdvancedCreation(');
    expect(start, '应有高级创建入口').toBeGreaterThanOrEqual(0);
    const body = flatMain.slice(start, start + 400);
    expect(body, '图片组走条目列表面板').toContain("if(group.kind==='image'){openImageQueueCreation(group);return;}");
    // 旧面板只在视频分支被打开：kind 传的是 group.kind，图片分支提前 return 不会走到
    const rest = flatMain.slice(start);
    expect(rest, '视频组仍走旧的 openAdvancedPanel').toContain('openAdvancedPanel(group.id,{kind:group.kind,');
  });

  it('deps 实现齐全：多选对话框、标识读取、惰性建轮用 roundName、跑分复用主界面入口', () => {
    const start = flatMain.indexOf('functionopenImageQueueCreation(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flatMain.indexOf('functionopenAdvancedCreation(', start);
    const body = flatMain.slice(start, end);
    expect(body, '多选系统对话框').toContain('multiple:true');
    expect(body, '标识读取走 image_identities').toContain("invoke('image_identities',{paths})");
    expect(body, '轮名带文件名').toContain('roundName(before.rounds.length+1,sourcePath)');
    expect(body, '跑分复用主界面整轮入口（只传本次产物路径子集）').toContain(
      'awaitscoreAllCandidates(groupId,roundId,paths)',
    );
    expect(body, '跑分期间置主界面忙标志').toContain('scoring=true');
  });

  it('主界面「开始跑分」按钮行为不变：仍整轮全量（不传 paths）', () => {
    const start = flatMain.indexOf('asyncfunctionstartScoring(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flatMain.indexOf('asyncfunctionscoreAllCandidates(', start);
    const body = flatMain.slice(start, end);
    expect(body, '主界面入口仍整轮全量').toContain('awaitscoreAllCandidates();');
  });

  it('关跑分组时丢弃它的条目队列会话态（组没了队列不该留着）', () => {
    expect(flatMain).toContain('dropImageQueue(group.id)');
  });
});
