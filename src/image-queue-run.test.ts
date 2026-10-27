// 票 #79（T5 增量跑分调度）的纯逻辑测试：跑分计划 → 按图分组的执行批次 → 真实执行编排。
//
// 断言口径：只锁「给定条目状态与注入的执行依赖 → 调用了什么、回写了什么、总结说了什么」，
// 不锁私有函数名。判定算法本身（四态 / 脏原因 / 计划拆分）由 T2 的
// src/image-queue.test.ts 覆盖，本文件只测「编排层怎么用计划」：
// - 只 encode 计划内的编码器卡；
// - round_score_candidates 只收本次新增产物的路径子集；
// - 单条编码失败不阻断该图其余条目；
// - 计划为空时零编码 / 零跑分调用（只弹提示）；
// - 汇总标题与逐张跳过原因。

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
} from './image-queue';
import {
  NOTHING_TO_RUN_MESSAGE,
  planRunBatches,
  runScorePlan,
  scoreButtonLabel,
  summaryLines,
  type QueueRunExecutor,
  type ScoredCandidate,
} from './image-queue-run';

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
    roundId: null,
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

/** 已成功跑分一次的条目：快照与当前卡 / 图完全一致。 */
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
}

/** 记录所有调用的假执行器（面板真实实现注入 IPC 的地方）。 */
function createMockExecutor(options: MockOptions = {}): {
  executor: QueueRunExecutor;
  calls: {
    createRound: string[];
    setReference: string[];
    encode: string[];
    addCandidates: string[][];
    scoreCandidates: string[][];
    deleteRound: string[];
  };
} {
  const calls = {
    createRound: [] as string[],
    setReference: [] as string[],
    encode: [] as string[],
    addCandidates: [] as string[][],
    scoreCandidates: [] as string[][],
    deleteRound: [] as string[],
  };
  let sequence = 0;
  const executor: QueueRunExecutor = {
    async createRound(target) {
      calls.createRound.push(target.id);
      sequence += 1;
      return `round-${sequence}`;
    },
    async setReference(target, roundId) {
      calls.setReference.push(`${target.id}:${roundId}`);
    },
    async encode(_target, _roundId, planned) {
      calls.encode.push(planned.encoder.id);
      const result = options.encode?.(planned, calls.encode.length - 1);
      if (result instanceof Error) throw result;
      return result ?? { path: `/out/${planned.encoder.id}.jpg`, encodingParams: `参数-${planned.encoder.id}` };
    },
    async addCandidates(_target, _roundId, products) {
      calls.addCandidates.push(products.map((product) => product.path));
    },
    async scoreCandidates(_target, _roundId, paths) {
      calls.scoreCandidates.push([...paths]);
      return options.scored ? options.scored([...paths]) : paths.map((path) => ({ path, error: null }));
    },
    async deleteRound(target, roundId) {
      calls.deleteRound.push(`${target.id}:${roundId}`);
    },
  };
  return { executor, calls };
}

beforeEach(() => {
  clearImageQueues();
});

// ---------- 计划 → 执行批次 ----------

describe('planRunBatches：把计划按图分组，只带计划内的编码器卡', () => {
  it('一图两卡只有一张脏：批次里只有脏卡，计划时指纹原样带出', () => {
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

  it('整张跳过的图不出现在任何批次里', () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });
    const fresh = entry({ id: 'img-fresh', path: '/photos/new.png' });

    const plan = planScore([clean, fresh], probe);
    expect(plan.skippedImages.map((item) => item.imageId)).toEqual(['img-clean']);

    const batches = planRunBatches(plan);
    expect(batches.map((batch) => batch.imageId)).toEqual(['img-fresh']);
  });
});

// ---------- 跑分按钮文案（N = plan.runImageCount） ----------

describe('scoreButtonLabel：跑分 / 重跑与待跑张数', () => {
  it('空列表只写「跑分」', () => {
    expect(scoreButtonLabel(planScore([], probe), [])).toBe('跑分');
  });

  it('全新条目按待跑张数写「跑分（N 张）」', () => {
    const entries = [newImageEntry('/photos/a.png'), newImageEntry('/photos/b.png')];
    expect(scoreButtonLabel(planScore(entries, probe), entries)).toBe('跑分（2 张）');
  });

  it('跑过且改过参数 →「重跑（N 张）」，N 只数本次要跑的图', () => {
    const changed = scoredEntry({ id: 'img-a', path: '/photos/a.png' });
    changed.encoders[0].quality = 55;
    const untouched = scoredEntry({ id: 'img-b', path: '/photos/b.png' });
    const entries = [changed, untouched];

    const plan = planScore(entries, probe);
    expect(plan.runImageCount).toBe(1);
    expect(scoreButtonLabel(plan, entries)).toBe('重跑（1 张）');
  });

  it('全部已跑分且无变更 →「跑分（0 张）」仍可点开提示卡片', () => {
    const entries = [scoredEntry()];
    const plan = planScore(entries, probe);
    expect(plan.runImageCount).toBe(0);
    expect(scoreButtonLabel(plan, entries)).toBe('跑分（0 张）');
  });

  it('上次失败的条目算重跑（下次自动重试）', () => {
    const failed = entry({ failures: [{ cardId: 'card-1', reason: '编码器不可用' }] });
    const entries = [failed];
    const plan = planScore(entries, probe);
    expect(plan.runImageCount).toBe(1);
    expect(scoreButtonLabel(plan, entries)).toBe('重跑（1 张）');
  });
});

// ---------- 汇总文案 ----------

describe('summaryLines：汇总卡片的正文行', () => {
  it('标题带 N/M 计数，随后逐张点名跳过原因', () => {
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
    const fresh = entry({ id: 'img-b', path: '/photos/portrait.png' });

    const plan = planScore([clean, fresh], probe);
    expect(summaryLines(plan)).toEqual([
      '本次跑分 1 张，跳过 1 张',
      'landscape.png（已跑分且无变更）',
    ]);
    expect(planSummary(plan).headline).toBe('本次跑分 1 张，跳过 1 张');
  });
});

// ---------- 执行编排 ----------

describe('runScorePlan：只跑计划内的编码器卡', () => {
  it('一图两卡只有一张脏：只 encode 脏卡，跑分路径恰好是本次新产物', async () => {
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

  it('未参与条目完全不被触碰：不建轮、不设原图、不编码、不跑分', async () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' });
    clean.roundId = 'r-clean';
    const fresh = entry({ id: 'img-fresh', path: '/photos/new.png' });

    const { executor, calls } = createMockExecutor();
    await runScorePlan([clean, fresh], probe, executor);

    expect(calls.createRound).toEqual(['img-fresh']);
    expect(calls.setReference).toEqual(['img-fresh:round-1']);
    expect(calls.encode).toEqual(['card-1']);
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
    expect(calls.createRound).toEqual([]);
    expect(calls.setReference).toEqual([]);
    expect(calls.encode).toEqual([]);
    expect(calls.addCandidates).toEqual([]);
    expect(calls.scoreCandidates).toEqual([]);
    expect(calls.deleteRound).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(NOTHING_TO_RUN_MESSAGE).toBe('所有图片已跑分且无变更，无需重跑');
  });
});

describe('runScorePlan：单条失败不阻断该图其余条目', () => {
  it('第一张卡编码失败：第二张照样编码并跑分，条目变「上次失败」且下次只重试失败卡', async () => {
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

  it('本次新建的轮一条产物都没产出时回滚，工作区不留空轮', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    const { executor, calls } = createMockExecutor({ encode: () => new Error('编码器不可用') });

    const report = await runScorePlan([target], probe, executor);

    expect(calls.createRound).toEqual(['img-1']);
    expect(calls.deleteRound).toEqual(['img-1:round-1']);
    expect(target.roundId).toBeNull();
    expect(report.ran).toBe(true);
    expect(report.images[0].failures).toHaveLength(1);
  });

  it('已有轮全部编码失败时保留轮（轮里可能还有上一轮结果，不能删）', async () => {
    const target = entry({ encoders: [card({ id: 'c1' })], roundId: 'r-old' });
    const { executor, calls } = createMockExecutor({ encode: () => new Error('编码器不可用') });

    await runScorePlan([target], probe, executor);

    expect(calls.createRound).toEqual([]);
    expect(calls.deleteRound).toEqual([]);
    expect(target.roundId).toBe('r-old');
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
