// 增量跑分编排的纯逻辑测试（票 #79 / T5；票「变体并入当前轮」后不再建轮）。
//
// 断言口径：只锁「给定变体状态与注入的执行依赖 → 调用了什么、回写了什么、总结说了什么」，
// 不锁私有函数名。判定算法本身（四态 / 脏原因 / 计划拆分）由 entries.test.ts 覆盖，
// 本文件只测「编排层怎么用计划」：
// - 只 encode 计划内的编码器卡；
// - round_score_candidates 只收本次新增产物的路径子集；
// - 单条编码失败不阻断该变体其余卡片；
// - 计划为空时零编码 / 零跑分调用（只弹提示）；
// - 系统级错误落成计划内每张卡的失败；
// - 汇总标题与逐个跳过原因。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearImageQueues,
  judgeImageEntry,
  newImageEntry,
  paramFingerprint,
  planScore,
  planSummary,
  type EncoderCard,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageIdentity,
  type ImageIdentityReading,
  type PlannedEncoder,
  type ScorePlan,
} from './entries';
import {
  NOTHING_TO_RUN_MESSAGE,
  candidatesNeedingScore,
  nothingToRunNotice,
  planRunBatches,
  rerunChangedButtonLabel,
  runScorePlan,
  runSummaryHeadline,
  runSummaryLines,
  runSummarySections,
  summaryLines,
  type QueueRunExecutor,
  type ScoredCandidate,
} from './run';
import type { CandidateImage } from '../../../core/model';

// ---------- 夹具 ----------

function card(partial: Partial<EncoderCard> = {}): EncoderCard {
  return {
    id: 'card-1',
    kind: 'image',
    encoderId: 'jpeg',
    lossless: false,
    mode: 'quality',
    quality: 75,
    targetBytes: 200 * 1024,
    unit: 'KB',
    rows: [],
    ...partial,
  };
}

function entry(partial: Partial<ImageEntry> = {}): ImageEntry {
  return {
    id: 'img-1',
    path: '/photos/a.png',
    encoders: [card()],
    snapshot: null,
    failures: [],
    replaced: false,
    ...partial,
  };
}

function identityOf(path: string): ImageIdentity {
  return { path, sizeBytes: 1024, modifiedMs: 1_000 };
}

function okIdentity(path: string): ImageIdentityReading {
  return { kind: 'ok', identity: identityOf(path) };
}

/** 同步探针：所有路径都可读、大小/修改时间固定（测试不关心真实文件）。 */
const probe: ImageIdentityProbe = (path) => okIdentity(path);

/** 已成功跑分一次的变体：快照与当前卡 / 原图完全一致。 */
function scoredEntry(overrides: Partial<ImageEntry> = {}, cardOverrides: Partial<EncoderCard> = {}): ImageEntry {
  const encoder = card(cardOverrides);
  const path = overrides.path ?? '/photos/a.png';
  return entry({
    encoders: [encoder],
    snapshot: {
      identity: identityOf(path),
      encoders: [{ cardId: encoder.id, fingerprint: paramFingerprint(encoder), artifactPath: '/out/a.jpg' }],
    },
    ...overrides,
  });
}

interface MockOptions {
  /** 编码结果：第 index 次调用返回产物，或返回 Error 模拟编码失败。 */
  encode?: (
    planned: PlannedEncoder,
    index: number,
  ) => { path: string; encodingParams: string } | Error;
  /** 跑分回包行；缺省 = 本次路径全部成功。 */
  scored?: (paths: string[]) => ScoredCandidate[];
  /** 让某个执行步骤抛错（模拟系统级 IPC 错误）。 */
  fail?: Partial<Record<'addCandidates' | 'scoreCandidates', string>>;
}

/** 记录所有调用的假执行器（动作层真实实现注入 IPC 的地方）。 */
function createMockExecutor(options: MockOptions = {}): {
  executor: QueueRunExecutor;
  calls: { encode: string[]; addCandidates: string[][]; scoreCandidates: string[][] };
} {
  const calls = {
    encode: [] as string[],
    addCandidates: [] as string[][],
    scoreCandidates: [] as string[][],
  };
  const executor: QueueRunExecutor = {
    async encode(_target, planned) {
      calls.encode.push(planned.encoder.id);
      const result = options.encode?.(planned, calls.encode.length - 1);
      if (result instanceof Error) throw result;
      return result ?? { path: `/out/${planned.encoder.id}.jpg`, encodingParams: `参数-${planned.encoder.id}` };
    },
    async addCandidates(_target, products) {
      if (options.fail?.addCandidates) throw new Error(options.fail.addCandidates);
      calls.addCandidates.push(products.map((product) => product.path));
    },
    async scoreCandidates(_target, paths) {
      if (options.fail?.scoreCandidates) throw new Error(options.fail.scoreCandidates);
      calls.scoreCandidates.push([...paths]);
      return options.scored ? options.scored([...paths]) : paths.map((path) => ({ path, error: null }));
    },
  };
  return { executor, calls };
}

beforeEach(() => {
  clearImageQueues();
});

// ---------- 计划 → 执行批次 ----------

describe('planRunBatches：把计划按变体分组，只带计划内的编码器卡', () => {
  it('一变体两卡只有一张脏：批次里只有脏卡，计划时指纹原样带出', () => {
    const cleanCard = card({ id: 'c1' });
    const dirtyCard = card({ id: 'c2', encoderId: 'webp' });
    const target = entry({ id: 'img-x', path: '/photos/x.png', encoders: [cleanCard, dirtyCard] });
    target.snapshot = {
      identity: identityOf('/photos/x.png'),
      encoders: [
        { cardId: 'c1', fingerprint: paramFingerprint(cleanCard), artifactPath: '/out/c1.jpg' },
        { cardId: 'c2', fingerprint: paramFingerprint(dirtyCard), artifactPath: '/out/c2.webp' },
      ],
    };
    target.encoders[1].quality = 40; // 只改第二张卡

    const plan = planScore([target], probe);
    expect(plan.encoders.map((item) => item.encoder.id)).toEqual(['c2']);

    const batches = planRunBatches(plan);
    expect(batches).toHaveLength(1);
    expect(batches[0].imageId).toBe('img-x');
    expect(batches[0].path).toBe('/photos/x.png');
    expect(batches[0].encoders.map((item) => item.encoder.id)).toEqual(['c2']);
    expect(batches[0].encoders[0].fingerprint).toBe(paramFingerprint(target.encoders[1]));
  });

  it('整张跳过的变体不出现在任何批次里', () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });
    const fresh = entry({ id: 'img-fresh', path: '/photos/new.png' });

    const plan = planScore([clean, fresh], probe);
    expect(plan.skippedImages.map((item) => item.imageId)).toEqual(['img-clean']);

    const batches = planRunBatches(plan);
    expect(batches.map((batch) => batch.imageId)).toEqual(['img-fresh']);
  });
});

// ---------- 「重跑改过的（N 张）」按钮文案 ----------

describe('rerunChangedButtonLabel：N = 待生成变体 + 缺指标的跑分图', () => {
  it('只变体脏：只数变体', () => {
    const changed = scoredEntry({ id: 'img-a', path: '/photos/a.png' });
    changed.encoders[0].quality = 55;
    const untouched = scoredEntry({ id: 'img-b', path: '/photos/b.png' });
    const plan = planScore([changed, untouched], probe);
    expect(rerunChangedButtonLabel(plan)).toBe('重跑改过的（1 张）');
    expect(rerunChangedButtonLabel(plan, 0)).toBe('重跑改过的（1 张）');
  });

  it('加上缺指标的跑分图（混合列表口径）', () => {
    const plan = planScore([newImageEntry('/photos/a.png')], probe);
    expect(rerunChangedButtonLabel(plan, 3)).toBe('重跑改过的（4 张）');
  });

  it('无待跑时显示 0 张——按钮仍可点（点开的提示由编排层给）', () => {
    const plan = planScore([scoredEntry()], probe);
    expect(rerunChangedButtonLabel(plan)).toBe('重跑改过的（0 张）');
    expect(rerunChangedButtonLabel(planScore([], probe))).toBe('重跑改过的（0 张）');
  });
});

// ---------- 汇总文案 ----------

describe('summaryLines：汇总卡片的正文行', () => {
  it('标题带 N/M 计数，随后逐个点名跳过原因（变体摘要，不是原图文件名）', () => {
    const cleanCard = card({ id: 'a1' });
    const clean = entry({
      id: 'img-a',
      path: '/photos/landscape.png',
      encoders: [cleanCard],
      snapshot: {
        identity: identityOf('/photos/landscape.png'),
        encoders: [{ cardId: 'a1', fingerprint: paramFingerprint(cleanCard), artifactPath: '/out/a.jpg' }],
      },
    });
    const fresh = entry({ id: 'img-b', path: '/photos/landscape.png' });

    const plan = planScore([clean, fresh], probe);
    expect(summaryLines(plan)).toEqual([
      '本次跑分 1 张，跳过 1 张',
      'JPEG q75（已跑分且无变更）',
    ]);
    expect(planSummary(plan).headline).toBe('本次跑分 1 张，跳过 1 张');
  });
});

// ---------- 跑分后的汇总口径（失败绝不说「完成」） ----------

describe('runSummaryHeadline / runSummaryLines：失败要说清是谁、为什么', () => {
  it('无失败：标题与 planSummary 完全一致，正文只有跳过原因', async () => {
    const fresh = entry({ id: 'img-ok', path: '/photos/ok.png' });
    const { executor } = createMockExecutor();

    const report = await runScorePlan([fresh], probe, executor);

    expect(runSummaryHeadline(report)).toBe(planSummary(report.plan).headline);
    expect(runSummaryHeadline(report)).toBe('本次跑分 1 张，跳过 0 张');
    expect(runSummaryLines(report)).toEqual(['本次跑分 1 张，跳过 0 张']);
  });

  it('有失败：标题追加条数，明细行同时给出变体摘要与原因原文', async () => {
    const target = entry({ id: 'img-fail', path: '/photos/fail.png' });
    const { executor } = createMockExecutor({ encode: () => new Error('编码器不可用') });

    const report = await runScorePlan([target], probe, executor);

    expect(runSummaryHeadline(report)).toBe('本次跑分 1 张，跳过 0 张，1 条失败');
    expect(runSummaryLines(report)).toEqual([
      '本次跑分 1 张，跳过 0 张，1 条失败',
      'JPEG q75（jpeg）：编码器不可用',
    ]);
    // 界面按段渲染：失败明细单独成段（详情块），不混进跳过原因的列表
    expect(runSummarySections(report)).toEqual({
      headline: '本次跑分 1 张，跳过 0 张，1 条失败',
      skipLines: [],
      failureLines: ['JPEG q75（jpeg）：编码器不可用'],
    });
    // 设计守卫禁止中点分隔符：明细行用括号与冒号分隔
    expect(runSummaryLines(report).join('\n')).not.toContain('·');
  });

  it('既有跳过又有失败：跳过原因与失败明细都留在正文里', async () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });
    const failing = entry({ id: 'img-fail', path: '/photos/fail.png' });
    const { executor } = createMockExecutor({ encode: () => new Error('编码器不可用') });

    const report = await runScorePlan([clean, failing], probe, executor);

    expect(runSummaryHeadline(report)).toBe('本次跑分 1 张，跳过 1 张，1 条失败');
    expect(runSummaryLines(report)).toEqual([
      '本次跑分 1 张，跳过 1 张，1 条失败',
      'JPEG q75（已跑分且无变更）',
      'JPEG q75（jpeg）：编码器不可用',
    ]);
  });

  it('系统级错误（跑分调用抛错）：明细行保留系统错误原文', async () => {
    const target = entry({ id: 'img-sys', path: '/photos/sys.png' });
    const { executor } = createMockExecutor({ fail: { scoreCandidates: '跑分 IPC 超时' } });

    const report = await runScorePlan([target], probe, executor);

    expect(runSummaryHeadline(report)).toBe('本次跑分 1 张，跳过 0 张，1 条失败');
    expect(runSummaryLines(report)).toEqual([
      '本次跑分 1 张，跳过 0 张，1 条失败',
      'JPEG q75（jpeg）：本次未完成跑分：跑分 IPC 超时',
    ]);
  });
});

// ---------- 计划为空时的提示文案（按跳过原因分流） ----------

describe('nothingToRunNotice：计划为空也要说对原因', () => {
  it('全部是「已跑分且无变更」：保持票面文案', () => {
    const clean = scoredEntry({ path: '/photos/done.png' });

    const notice = nothingToRunNotice(planScore([clean], probe));

    expect(notice.title).toBe('无需重跑');
    expect(notice.lines).toEqual([NOTHING_TO_RUN_MESSAGE]);
  });

  it('含「没有编码器配置」的变体：换准确文案并逐个点名', () => {
    const empty = entry({ id: 'img-empty', path: '/photos/no-encoder.png', encoders: [] });
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });

    const notice = nothingToRunNotice(planScore([empty, clean], probe));

    expect(notice.title).toBe('没有可跑的编码器配置');
    expect(notice.lines).toEqual([
      '没有可跑的编码器配置，请先在编辑窗口里添加编码器卡',
      '空配置（没有编码器配置）',
      'JPEG q75（已跑分且无变更）',
    ]);
    expect(notice.lines.join('\n'), '空计划的原因不是「已跑分」').not.toContain(
      NOTHING_TO_RUN_MESSAGE,
    );
  });
});

// ---------- 混合列表：候选侧增量口径 ----------

describe('candidatesNeedingScore：已跑分且成功的候选不重算', () => {
  function candidate(partial: Partial<CandidateImage> = {}): CandidateImage {
    return {
      path: '/out/a.jpg',
      fileSize: 1234,
      sizeRatio: 0.5,
      metrics: { psnr: 40 },
      encodingParams: 'JPEG q75',
      error: null,
      ...partial,
    };
  }

  it('待跑分（无指标）与上次失败的要跑；已完成的不跑', () => {
    const done = candidate();
    const pending = candidate({ path: '/out/b.jpg', metrics: null });
    const failed = candidate({ path: '/out/c.jpg', metrics: null, error: '解码失败' });
    expect(candidatesNeedingScore([done, pending, failed]).map((item) => item.path)).toEqual([
      '/out/b.jpg',
      '/out/c.jpg',
    ]);
  });

  it('有指标但带 error 的也重跑（失败永远不算已跑分）', () => {
    const odd = candidate({ metrics: { psnr: 30 }, error: '旧错误' });
    expect(candidatesNeedingScore([odd])).toHaveLength(1);
  });
});

// ---------- 执行编排 ----------

describe('runScorePlan：只跑计划内的编码器卡', () => {
  it('一变体两卡只有一张脏：只 encode 脏卡，跑分路径恰好是本次新产物', async () => {
    const cleanCard = card({ id: 'c1' });
    const dirtyCard = card({ id: 'c2', encoderId: 'webp' });
    const target = entry({ id: 'img-x', path: '/photos/x.png', encoders: [cleanCard, dirtyCard] });
    target.snapshot = {
      identity: identityOf('/photos/x.png'),
      encoders: [
        { cardId: 'c1', fingerprint: paramFingerprint(cleanCard), artifactPath: '/out/c1.jpg' },
        { cardId: 'c2', fingerprint: paramFingerprint(dirtyCard), artifactPath: '/out/c2.webp' },
      ],
    };
    target.encoders[1].quality = 40;

    const { executor, calls } = createMockExecutor();
    const report = await runScorePlan([target], probe, executor);

    expect(report.ran).toBe(true);
    expect(calls.encode).toEqual(['c2']);
    expect(calls.scoreCandidates).toEqual([['/out/c2.jpg']]);
    expect(calls.addCandidates).toEqual([['/out/c2.jpg']]);
    // 跑完两张卡都干净（脏卡写回计划时指纹，干净卡沿用旧快照）
    expect(planScore([target], probe).runImageCount).toBe(0);
  });

  it('未参与变体完全不被触碰：不编码、不跑分', async () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });
    const fresh = entry({ id: 'img-fresh', path: '/photos/new.png' });

    const { executor, calls } = createMockExecutor();
    await runScorePlan([clean, fresh], probe, executor);

    expect(calls.encode).toEqual(['card-1']);
    expect(calls.addCandidates).toHaveLength(1);
    expect(calls.scoreCandidates).toHaveLength(1);
  });
});

describe('runScorePlan：无待跑时零调用、只提示', () => {
  it('计划为空：不调用任何执行依赖，只触发提示回调', async () => {
    const clean = scoredEntry({ path: '/photos/done.png' });
    const { executor, calls } = createMockExecutor();
    const notices: ScorePlan[] = [];

    const report = await runScorePlan([clean], probe, executor, {
      onNothingToRun: (plan) => notices.push(plan),
    });

    expect(report.ran).toBe(false);
    expect(report.plan.runImageCount).toBe(0);
    expect(calls.encode).toEqual([]);
    expect(calls.addCandidates).toEqual([]);
    expect(calls.scoreCandidates).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(NOTHING_TO_RUN_MESSAGE).toBe('所有图片已跑分且无变更，无需重跑');
  });
});

describe('runScorePlan：单条失败不阻断该变体其余卡片', () => {
  it('第一张卡编码失败：第二张照样编码并跑分，变体变「上次失败」且下次只重试失败卡', async () => {
    const target = entry({ id: 'img-f', encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'webp' })] });
    const { executor, calls } = createMockExecutor({
      encode: (planned) =>
        planned.encoder.id === 'c1'
          ? new Error('编码器不可用')
          : { path: '/out/c2.webp', encodingParams: 'WebP q75' },
    });

    const report = await runScorePlan([target], probe, executor);

    expect(calls.encode).toEqual(['c1', 'c2']);
    expect(calls.scoreCandidates).toEqual([['/out/c2.webp']]);
    expect(report.images[0].failures).toEqual([
      { cardId: 'c1', encoderId: 'jpeg', reason: '编码器不可用' },
    ]);
    expect(judgeImageEntry(target, probe).state).toBe('failed');

    const retryPlan = planScore([target], probe);
    expect(retryPlan.encoders.map((item) => item.encoder.id)).toEqual(['c1']);
  });

  it('编码成功但产物行内有 error：折成失败，不算已跑分', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    const { executor } = createMockExecutor({
      scored: (paths) => paths.map((path) => ({ path, error: '解码失败：文件损坏' })),
    });

    await runScorePlan([target], probe, executor);

    expect(judgeImageEntry(target, probe).state).toBe('failed');
    expect(planScore([target], probe).runImageCount).toBe(1);
  });

  it('跑分结果里没有该产物的行：按失败处理（没确认指标就不算已跑分）', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    // 回包一行都没有：产物没跑出指标，不能当成功（否则这个变体会被永久跳过）
    const { executor } = createMockExecutor({ scored: () => [] });

    const report = await runScorePlan([target], probe, executor);

    expect(report.images[0].failures).toEqual([
      {
        cardId: 'c1',
        encoderId: 'jpeg',
        reason: '跑分结果里没有该产物的行，未确认指标',
      },
    ]);
    expect(target.snapshot).toBeNull();
    expect(judgeImageEntry(target, probe).state).toBe('failed');
    expect(planScore([target], probe).runImageCount, '缺行必须留待下次重跑').toBe(1);
  });
});

describe('runScorePlan：系统级错误落成计划内每张卡的失败（徽章不停在「未跑分」）', () => {
  it('纳产物抛错：已编码成功的卡也降级成失败，编码本身失败的原因原样保留', async () => {
    const target = entry({
      encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'webp' })],
    });
    const { executor } = createMockExecutor({
      encode: (planned) =>
        planned.encoder.id === 'c1'
          ? new Error('编码器不可用')
          : { path: '/out/c2.webp', encodingParams: 'WebP q75' },
      fail: { addCandidates: '纳入跑分图失败：IPC 超时' },
    });

    const report = await runScorePlan([target], probe, executor);

    expect(report.images[0].failures).toEqual([
      { cardId: 'c1', encoderId: 'jpeg', reason: '编码器不可用' },
      { cardId: 'c2', encoderId: 'webp', reason: '本次未完成跑分：纳入跑分图失败：IPC 超时' },
    ]);
    expect(target.snapshot, '没跑出指标就不许写快照').toBeNull();
    expect(planScore([target], probe).runEncoderCount).toBe(2);
  });

  it('跑分调用本身抛错：同样落成失败（产物进了轮但没指标）', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    const { executor } = createMockExecutor({ fail: { scoreCandidates: '跑分 IPC 超时' } });

    const report = await runScorePlan([target], probe, executor);

    expect(report.images[0].error).toBe('跑分 IPC 超时');
    expect(report.images[0].failures).toEqual([
      { cardId: 'c1', encoderId: 'jpeg', reason: '本次未完成跑分：跑分 IPC 超时' },
    ]);
    expect(judgeImageEntry(target, probe).state).toBe('failed');
  });
});

describe('runScorePlan：计划时指纹回传（跑分中途改参数的竞态）', () => {
  it('编码期间用户改了参数：快照写回计划时指纹，下一轮如实判「参数改了」', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    const { executor } = createMockExecutor({
      encode: (_planned) => {
        // 模拟编码进行中的界面操作：用户把质量从 75 改到 90
        target.encoders[0].quality = 90;
        return { path: '/out/1.jpg', encodingParams: 'JPEG q75' };
      },
    });

    await runScorePlan([target], probe, executor);

    expect(target.snapshot?.encoders[0].fingerprint).toBe(
      paramFingerprint({ ...target.encoders[0], quality: 75 }),
    );
    const next = planScore([target], probe);
    expect(next.encoders.map((item) => item.encoder.id)).toEqual(['c1']);
  });
});
