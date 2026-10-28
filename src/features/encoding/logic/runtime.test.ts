// 票 #82（T10）共享跑分编排的单测：面板的「跑分 / 重跑」与主界面新增的
// 「重跑改过的（N 张）」走的是同一份编排（标识读新 → 算计划 → 假执行器编排 →
// 状态栏 → 提示 / 汇总卡片）。这层一旦各自写一份，两条入口的增量语义就会漂移。
//
// 断言口径：只锁「给定条目状态 + 注入的宿主依赖 → 调用了什么、说了什么、写回了什么」，
// 不锁私有实现。DOM 卡片不在 node 环境渲染：卡片内容经 deps.showNotice 注入的假实现
// 断言（生产默认值仍是 src/modal-card.ts 的实现，另有机制守卫钉住）。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearImageQueues,
  judgeImageEntry,
  newImageEntry,
  paramFingerprint,
  type EncoderCard,
  type ImageEntry,
  type ImageIdentity,
} from './entries';
import {
  NOTHING_TO_RUN_MESSAGE,
  NO_ENCODERS_MESSAGE,
  type ScoredCandidate,
} from './run';
import {
  EMPTY_QUEUE_MESSAGE,
  clearImageQueueIdentities,
  queueEditorDeps,
  queueIdentityProbe,
  runQueuePlanOnce,
  type QueueRuntimeDeps,
} from './runtime';
import type { AdvancedProductDto } from '../ipc';

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

function identityOf(path: string): ImageIdentity {
  return { path, sizeBytes: 1024, modifiedMs: 1_000 };
}

/** 已成功跑分一次的条目：快照与当前卡 / 图完全一致（标识读回来也一样）。 */
function scoredEntry(overrides: Partial<ImageEntry> = {}, cardOverrides: Partial<EncoderCard> = {}): ImageEntry {
  const encoder = card(cardOverrides);
  const path = overrides.path ?? '/photos/a.png';
  return {
    id: 'img-1',
    path,
    encoders: [encoder],
    snapshot: {
      identity: identityOf(path),
      encoders: [{ cardId: encoder.id, fingerprint: paramFingerprint(encoder), artifactPath: '/out/a.jpg' }],
    },
    failures: [],
    replaced: false,
    roundId: null,
    ...overrides,
  };
}

interface MockOptions {
  /** 跑分回包行；缺省 = 本次路径全部成功。 */
  scored?: (paths: string[]) => ScoredCandidate[];
  /** 让某个宿主步骤抛错（模拟 IPC 失败）。 */
  fail?: Partial<Record<'createRound' | 'setReference' | 'addCandidates' | 'scoreRound', string>>;
  /** 不提供忙标志广播（模拟主界面自己持有忙标志）。 */
  withoutBusy?: boolean;
  /** 不提供卡片渲染（缺省 = 用生产默认的 showQueueNotice，需要 DOM，测试里必须给）。 */
  keepDefaultNotice?: boolean;
}

/**
 * 记录所有调用的假宿主（真实实现由 main.ts 注入 IPC）。
 * 原图标识默认与夹具快照一致（sizeBytes 1024 / modifiedMs 1000）：只有这样才能构造
 * 「已跑分且无变更」的干净条目，从而验证无待跑时零调用。
 */
function createMockHost(options: MockOptions = {}) {
  const calls = {
    probe: [] as string[][],
    createRound: [] as string[],
    setReference: [] as string[],
    encode: [] as string[],
    addCandidates: [] as string[][],
    scoreRound: [] as string[][],
    deleteRound: [] as string[],
    withBusy: 0,
  };
  const statuses: { text: string; isError: boolean }[] = [];
  const notices: { title: string; lines: readonly string[] }[] = [];
  let sequence = 0;

  const fail = (step: keyof NonNullable<MockOptions['fail']>): void => {
    const message = options.fail?.[step];
    if (message !== undefined) throw new Error(message);
  };

  const deps: QueueRuntimeDeps = {
    probeIdentities: async (paths) => {
      calls.probe.push([...paths]);
      return paths.map((path) => ({ path, sizeBytes: 1024, modifiedMs: 1_000, error: null }));
    },
    createRound: async (_groupId, sourcePath) => {
      fail('createRound');
      calls.createRound.push(sourcePath);
      sequence += 1;
      return { groupId: 'g1', roundId: `round-${sequence}` };
    },
    setReference: async (_groupId, roundId, path) => {
      fail('setReference');
      calls.setReference.push(`${path}:${roundId}`);
    },
    encode: async (_groupId, _roundId, _referencePath, encoder): Promise<AdvancedProductDto> => {
      calls.encode.push(encoder.id);
      return {
        path: `/out/${encoder.id}.jpg`,
        encodingParams: `参数-${encoder.id}`,
        commandLine: 'cjpeg ...',
        note: null,
      };
    },
    addCandidates: async (_groupId, _roundId, paths, params) => {
      fail('addCandidates');
      calls.addCandidates.push([...paths]);
      expect(params).toHaveLength(paths.length);
    },
    deleteRound: async (_groupId, roundId) => {
      calls.deleteRound.push(roundId);
    },
    scoreRound: async (_groupId, _roundId, paths): Promise<ScoredCandidate[]> => {
      fail('scoreRound');
      calls.scoreRound.push([...paths]);
      return options.scored
        ? options.scored([...paths])
        : paths.map((path) => ({ path, error: null }));
    },
    describeRound: (_groupId, roundId) => ({ name: `评测轮（${roundId}）`, candidateCount: 0 }),
    setStatus: (text, isError) => {
      statuses.push({ text, isError: isError === true });
    },
    ...(options.keepDefaultNotice
      ? {}
      : {
          showNotice: (lines: readonly string[], notice: { title: string }) => {
            notices.push({ title: notice.title, lines });
          },
        }),
    ...(options.withoutBusy
      ? {}
      : {
          withBusy: async <T>(task: () => Promise<T>): Promise<T> => {
            calls.withBusy += 1;
            return task();
          },
        }),
  };
  return { deps, calls, statuses, notices };
}

const lastStatus = (statuses: { text: string; isError: boolean }[]) =>
  statuses[statuses.length - 1]?.text;

beforeEach(() => {
  clearImageQueues();
  clearImageQueueIdentities();
});

// ---------- 无待跑：零调用 ----------

describe('runQueuePlanOnce：无待跑时零编码零跑分调用', () => {
  it('已跑分且无变更 → 只弹「无需重跑」卡片，createRound / encode / scoreRound 全 0', async () => {
    const clean = scoredEntry();
    const { deps, calls, statuses, notices } = createMockHost();

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [clean], deps });

    expect(report?.ran).toBe(false);
    expect(calls.createRound, '不得建轮').toEqual([]);
    expect(calls.encode, '不得编码').toEqual([]);
    expect(calls.scoreRound, '不得跑分').toEqual([]);
    expect(calls.addCandidates).toEqual([]);
    expect(calls.setReference).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe('无需重跑');
    expect(notices[0].lines).toEqual([NOTHING_TO_RUN_MESSAGE]);
    expect(lastStatus(statuses)).toBe(NOTHING_TO_RUN_MESSAGE);
  });

  it('没有编码器配置的条目：提示按原因分流（不说「已跑分且无变更」），仍零调用', async () => {
    const noCards = newImageEntry('/photos/empty.png');
    noCards.encoders = [];
    const { deps, calls, notices } = createMockHost();

    await runQueuePlanOnce({ groupId: 'g1', entries: [noCards], deps });

    expect(calls.encode).toEqual([]);
    expect(calls.createRound).toEqual([]);
    expect(notices[0].title).toBe('没有可跑的编码器配置');
    expect(notices[0].lines[0]).toBe(NO_ENCODERS_MESSAGE);
  });

  it('没有任何条目：连原图标识都不读，只提示', async () => {
    const { deps, calls, statuses, notices } = createMockHost();

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [], deps });

    expect(report).toBeNull();
    expect(calls.probe).toEqual([]);
    expect(calls.createRound).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe('无需重跑');
    expect(notices[0].lines).toEqual([EMPTY_QUEUE_MESSAGE]);
    expect(lastStatus(statuses)).toBe(EMPTY_QUEUE_MESSAGE);
  });
});

// ---------- 有待跑：走增量引擎 ----------

describe('runQueuePlanOnce：有待跑时走既有增量引擎', () => {
  it('新条目：建轮 → 设原图 → 编码 → 纳产物 → 只对本次产物跑分 → 写回快照', async () => {
    const fresh = newImageEntry('/photos/a.png');
    const encoderId = fresh.encoders[0].id;
    const { deps, calls, statuses, notices } = createMockHost();

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [fresh], deps });

    expect(report?.ran).toBe(true);
    expect(calls.createRound).toEqual(['/photos/a.png']);
    expect(calls.setReference).toEqual(['/photos/a.png:round-1']);
    expect(calls.encode).toEqual([encoderId]);
    expect(calls.addCandidates).toEqual([[`/out/${encoderId}.jpg`]]);
    expect(calls.scoreRound).toEqual([[`/out/${encoderId}.jpg`]]);
    expect(fresh.snapshot?.encoders[0].artifactPath).toBe(`/out/${encoderId}.jpg`);
    // 跑完立刻回到「已跑分」：主界面「重跑改过的」计数当场归零
    expect(judgeImageEntry(fresh, queueIdentityProbe()).state).toBe('scored');
    expect(notices[0].title).toBe('跑分汇总');
    expect(notices[0].lines[0]).toBe('本次跑分 1 张，跳过 0 张');
    expect(lastStatus(statuses)).toBe('跑分完成：1 张图片已更新');
  });

  it('混合：只跑脏的那张，干净的那张不建轮、进汇总的跳过清单', async () => {
    const clean = scoredEntry({ id: 'img-clean', path: '/photos/done.png' },
      { id: 'clean-card' });
    const dirty = newImageEntry('/photos/new.png');
    const { deps, calls, notices } = createMockHost();

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [clean, dirty], deps });

    expect(calls.createRound).toEqual(['/photos/new.png']);
    expect(calls.encode).toEqual([dirty.encoders[0].id]);
    expect(report?.plan.runImageCount).toBe(1);
    expect(notices[0].lines).toContain('done.png（已跑分且无变更）');
  });

  it('跑分调用抛错：不向上抛，状态栏报「几条失败 / 几张图出错」，条目记失败（不假装已跑分）', async () => {
    const fresh = newImageEntry('/photos/a.png');
    const { deps, statuses, notices } = createMockHost({ fail: { scoreRound: '跑分服务不可用' } });

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [fresh], deps });

    expect(report?.ran).toBe(true);
    expect(report?.images[0]?.error).toContain('跑分服务不可用');
    expect(statuses[statuses.length - 1]?.text).toContain('1 条失败');
    expect(statuses[statuses.length - 1]?.text).toContain('1 张图出错');
    expect(statuses[statuses.length - 1]?.isError).toBe(true);
    expect(fresh.failures).toHaveLength(1);
    expect(fresh.failures[0].reason).toContain('跑分服务不可用');
    expect(judgeImageEntry(fresh, queueIdentityProbe()).state).toBe('failed');
    // 跑完照旧弹汇总（失败也留在卡片里给用户看）
    expect(notices[0].title).toBe('跑分汇总');
  });

  it('宿主忙标志自己抛错：兜底成状态栏「跑分失败」，不把界面带崩', async () => {
    const fresh = newImageEntry('/photos/a.png');
    const { deps, statuses } = createMockHost();
    const broken = {
      ...deps,
      withBusy: async <T>(_task: () => Promise<T>): Promise<T> => {
        throw new Error('忙标志切换失败');
      },
    };

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [fresh], deps: broken });

    expect(report).toBeNull();
    expect(statuses[statuses.length - 1]?.text).toBe('跑分失败：Error: 忙标志切换失败');
    expect(statuses[statuses.length - 1]?.isError).toBe(true);
  });

  it('宿主没提供忙标志广播（主界面自己持有忙标志）时照样跑分', async () => {
    const fresh = newImageEntry('/photos/a.png');
    const { deps, calls } = createMockHost({ withoutBusy: true });

    const report = await runQueuePlanOnce({ groupId: 'g1', entries: [fresh], deps });

    expect(report?.ran).toBe(true);
    expect(calls.withBusy).toBe(0);
    expect(calls.scoreRound).toHaveLength(1);
  });

  it('忙标志只在跑分阶段持有：读原图标识时不置忙', async () => {
    const fresh = newImageEntry('/photos/a.png');
    const { deps, calls } = createMockHost();

    await runQueuePlanOnce({ groupId: 'g1', entries: [fresh], deps });

    expect(calls.probe).toHaveLength(1);
    expect(calls.withBusy).toBe(1);
  });
});

// ---------- 逐图编辑弹窗的依赖（面板行点击与主界面胶囊共用） ----------

describe('queueEditorDeps：参数弹窗的接线只此一份', () => {
  it('describeRound / clearCandidates 补上组 id，refreshIdentity 读新标识并进缓存', async () => {
    const seen: string[] = [];
    const { deps } = createMockHost();
    const host = {
      ...deps,
      loadImageCatalog: async () => [],
      pickReplacementImage: async () => null,
      clearCandidates: async (groupId: string, roundId: string) => {
        seen.push(`clear:${groupId}:${roundId}`);
      },
      describeRound: (groupId: string, roundId: string) => {
        seen.push(`describe:${groupId}:${roundId}`);
        return { name: '评测轮 3', candidateCount: 2 };
      },
    };

    const editor = queueEditorDeps('g-9', host, () => undefined);
    expect(editor.describeRound('r-1')).toEqual({ name: '评测轮 3', candidateCount: 2 });
    expect(editor.identityProbe()('/photos/a.png').kind).toBe('failed'); // 缓存还没读过
    await editor.refreshIdentity('/photos/a.png');
    expect(editor.identityProbe()('/photos/a.png').kind).toBe('ok');
    await editor.clearCandidates('g-9', 'r-1');

    expect(seen).toEqual(['describe:g-9:r-1', 'clear:g-9:r-1']);
  });

  it('onChanged 原样转发（弹窗内改动 → 调用方刷新自己的界面）', () => {
    const { deps } = createMockHost();
    let changed = 0;
    const editor = queueEditorDeps(
      'g1',
      {
        ...deps,
        loadImageCatalog: async () => [],
        pickReplacementImage: async () => null,
        clearCandidates: async () => undefined,
      },
      () => {
        changed += 1;
      },
    );

    editor.onChanged();

    expect(changed).toBe(1);
  });
});
