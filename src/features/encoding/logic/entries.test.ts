// 参数变体与增量跑分判定的单测（票 #76；票「变体并入当前轮」后改为按轮键控）。
//
// 断言口径：只锁「给定输入 → 外部结论」（这条要不要跑、为什么、计划拆成什么样、
// 文案说什么），不锁私有函数名与内部调用顺序。读盘探针一律用显式假数据注入，
// 因为纯逻辑层不自己读文件（这也是失败分支能被单独构造出来的原因）。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DIRTY_REASON_LABELS,
  IMAGE_ENTRY_STATE_LABELS,
  SKIP_REASON_LABELS,
  applyRunResults,
  badgeText,
  cardSummary,
  clearImageQueues,
  dropImageQueue,
  entryFailures,
  entryForArtifact,
  forgetArtifact,
  identityChanged,
  imageIdentityFrom,
  imageQueueFor,
  isPlanEmpty,
  judgeImageEntry,
  newImageEntry,
  newVariant,
  normalizeCardRows,
  paramFingerprint,
  planScore,
  planSummary,
  probeFromCache,
  removeImageEntry,
  replaceImagePath,
  skipReasonLine,
  summaryHeadline,
  syncEntryReference,
  variantSummary,
  type EncoderCard,
  type ImageEntry,
  type ImageIdentity,
  type ImageIdentityProbe,
  type ImageIdentityReading,
} from './entries';
import type { AdvancedParamRow } from './advanced';

// ---------- 测试夹具 ----------

function row(partial: Partial<AdvancedParamRow>): AdvancedParamRow {
  return {
    name: '',
    flag: '',
    value: '',
    note: '',
    kind: 'text',
    options: [],
    enabled: true,
    ...partial,
  };
}

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

/** 按路径批量入列（会话态里没有「添加」动作了：变体由界面层直接新建并 push）。 */
function addEntries(session: { entries: ImageEntry[] }, paths: string[]): ImageEntry[] {
  const added = paths.map((path) => newImageEntry(path));
  session.entries.push(...added);
  return added;
}

const identity: ImageIdentity = { path: '/photos/a.png', sizeBytes: 1024, modifiedMs: 1_000 };

/** 同步探针：给定路径 → 给定读取结果（默认全部可读）。 */
function probeOf(readings: Record<string, ImageIdentityReading>): ImageIdentityProbe {
  return (path) =>
    readings[path] ?? { kind: 'ok', identity: { path, sizeBytes: 1024, modifiedMs: 1_000 } };
}

function okIdentity(path: string, extra: Partial<ImageIdentity> = {}): ImageIdentityReading {
  return { kind: 'ok', identity: { path, sizeBytes: 1024, modifiedMs: 1_000, ...extra } };
}

/** 已成功跑分一次的条目：快照与当前卡/图完全一致。 */
function scoredEntry(overrides: Partial<ImageEntry> = {}, cardOverrides: Partial<EncoderCard> = {}): ImageEntry {
  const encoder = card(cardOverrides);
  return entry({
    encoders: [encoder],
    snapshot: {
      identity,
      encoders: [{ cardId: encoder.id, fingerprint: paramFingerprint(encoder), artifactPath: '/out/a.jpg' }],
    },
    ...overrides,
  });
}

beforeEach(() => {
  clearImageQueues();
});

// ---------- 参数指纹 ----------

describe('参数指纹', () => {
  it('同内容不同构造顺序得到相同指纹（字段序不影响）', () => {
    const a = card({ rows: [row({ name: '线程数', flag: '-j', value: '4' })] });
    const b: EncoderCard = {
      rows: [row({ name: '线程数', flag: '-j', value: '4' })],
      unit: 'KB',
      targetBytes: 200 * 1024,
      quality: 75,
      mode: 'quality',
      lossless: false,
      encoderId: 'jpeg',
      kind: 'image',
      id: 'card-1',
    };
    expect(paramFingerprint(a)).toBe(paramFingerprint(b));
  });

  it('卡片 id、参数行说明 note、显示单位 unit、choice 候选 options 不参与指纹（不影响产物）', () => {
    const base = card({ rows: [row({ name: '色度子采样', flag: '-sample', value: '2x2', kind: 'choice', options: ['2x2', '4:2:0'] })] });
    const changed = card({
      id: 'card-other',
      unit: 'MB',
      rows: [row({ name: '色度子采样', flag: '-sample', value: '2x2', kind: 'choice', options: ['4:2:0', '2x2'], note: '说明文字' })],
    });
    expect(paramFingerprint(changed)).toBe(paramFingerprint(base));
  });

  it.each<[string, Partial<EncoderCard>]>([
    ['编码器 id', { encoderId: 'webp' }],
    ['无损开关', { lossless: true }],
    ['模式', { mode: 'size' }],
    ['质量', { quality: 76 }],
    ['目标大小', { targetBytes: 300 * 1024 }],
  ])('改动决策字段「%s」会让指纹变化', (_label, change) => {
    expect(paramFingerprint(card(change))).not.toBe(paramFingerprint(card()));
  });

  it.each<[string, Partial<AdvancedParamRow>]>([
    ['参数名', { name: '线程数' }],
    ['标志', { flag: '-j' }],
    ['取值', { value: '4' }],
    ['种类', { kind: 'number' }],
    ['启用态', { enabled: false }],
  ])('改动参数行的「%s」会让指纹变化', (_label, change) => {
    const base = card({ rows: [row({})] });
    const changed = card({ rows: [row(change)] });
    expect(paramFingerprint(changed)).not.toBe(paramFingerprint(base));
  });

  it('参数行顺序参与指纹（顺序决定命令行词序）', () => {
    const a = card({
      rows: [row({ name: 'A', flag: '-a' }), row({ name: 'B', flag: '-b' })],
    });
    const b = card({
      rows: [row({ name: 'B', flag: '-b' }), row({ name: 'A', flag: '-a' })],
    });
    expect(paramFingerprint(a)).not.toBe(paramFingerprint(b));
  });

  it('指纹是稳定字符串（同输入多次调用完全一致）', () => {
    const target = card({ rows: [row({ name: '渐进式', flag: '-progressive' })] });
    expect(paramFingerprint(target)).toBe(paramFingerprint(target));
  });
});

// ---------- 图片标识 ----------

describe('图片标识', () => {
  it('路径 / 大小 / 修改时间任一不同都算已变更', () => {
    expect(identityChanged(identity, okIdentity('/photos/a.png'))).toBe(false);
    expect(identityChanged(identity, okIdentity('/photos/other.png'))).toBe(true);
    expect(identityChanged(identity, okIdentity('/photos/a.png', { sizeBytes: 2048 }))).toBe(true);
    expect(identityChanged(identity, okIdentity('/photos/a.png', { modifiedMs: 2_000 }))).toBe(true);
  });

  it('读取失败算已变更（文件被移走 → 保守重跑）', () => {
    expect(
      identityChanged(identity, { kind: 'failed', path: '/photos/a.png', reason: '不存在' }),
    ).toBe(true);
  });

  it('探针抛错也按读取失败处理（判定走保守重跑，不把界面炸掉）', () => {
    const target = scoredEntry();
    const probe: ImageIdentityProbe = () => {
      throw new Error('IPC 调用失败');
    };
    const verdict = judgeImageEntry(target, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toEqual(['image']);
  });

  it('probeFromCache：缓存命中直接用；缓存里没有按读取失败处理（保守判已变更）', () => {
    const cache = new Map<string, ImageIdentityReading>([
      ['/photos/a.png', okIdentity('/photos/a.png')],
      ['/photos/gone.png', { kind: 'failed', path: '/photos/gone.png', reason: '文件已被移走' }],
    ]);
    const probe = probeFromCache(cache);
    expect(probe('/photos/a.png').kind).toBe('ok');
    expect(probe('/photos/gone.png').kind).toBe('failed');
    const unknown = probe('/photos/never-read.png');
    expect(unknown.kind).toBe('failed');
    // 真的判定：没读到元数据的已跑分条目也会被保守判成待重跑
    const target = scoredEntry({ path: '/photos/never-read.png' });
    expect(judgeImageEntry(target, probe).state).toBe('stale');
  });

  it('imageIdentityFrom：元数据缺失或不可用时给出失败分支', () => {
    expect(imageIdentityFrom('/p/a.png', null).kind).toBe('failed');
    expect(imageIdentityFrom('/p/a.png', { sizeBytes: 1 }).kind).toBe('failed');
    expect(imageIdentityFrom('/p/a.png', { sizeBytes: Number.NaN, modifiedMs: 1 }).kind).toBe('failed');
    const ok = imageIdentityFrom('/p/a.png', { sizeBytes: 10, modifiedMs: 20 });
    expect(ok).toEqual({ kind: 'ok', identity: { path: '/p/a.png', sizeBytes: 10, modifiedMs: 20 } });
  });
});

// ---------- 脏判定：四态与每条分支 ----------

describe('脏判定（编码器级，图片级四态汇总）', () => {
  it('从未成功跑分 → 未跑分，每张卡都要跑，原因是「从没跑过」', () => {
    const target = entry({ encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'webp' })] });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('unscored');
    expect(verdict.reasons).toEqual(['never']);
    expect(verdict.encoders.map((item) => [item.cardId, item.run, item.reasons])).toEqual([
      ['c1', true, ['never']],
      ['c2', true, ['never']],
    ]);
  });

  it('参数指纹与快照一致、图片未变 → 已跑分，跳过', () => {
    const target = scoredEntry();
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('scored');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.encoders[0].run).toBe(false);
  });

  it('参数指纹变了 → 将重跑，只重编这一条', () => {
    const target = scoredEntry();
    target.encoders[0].quality = 80; // 快照里记的是 quality=75
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toEqual(['params']);
    expect(verdict.encoders.map((item) => item.run)).toEqual([true]);
  });

  it('只有改过的那条卡要跑，其余卡保持跳过（编码器级，不是整图）', () => {
    const clean = card({ id: 'c1' });
    const dirty = card({ id: 'c2', encoderId: 'webp', quality: 50 });
    const target = entry({
      encoders: [clean, dirty],
      snapshot: {
        identity,
        encoders: [
          { cardId: 'c1', fingerprint: paramFingerprint(clean), artifactPath: '/out/1.jpg' },
          { cardId: 'c2', fingerprint: paramFingerprint(card({ id: 'c2', encoderId: 'webp' })), artifactPath: '/out/2.webp' },
        ],
      },
    });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('stale');
    expect(verdict.encoders.map((item) => [item.cardId, item.run])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    expect(verdict.encoders[1].reasons).toEqual(['params']);
  });

  it('原图标识变了 → 将重跑，该图全部条目重编（即使参数完全相同）', () => {
    const first = card({ id: 'c1' });
    const second = card({ id: 'c2', encoderId: 'avif' });
    const target = entry({
      encoders: [first, second],
      snapshot: {
        identity,
        encoders: [
          { cardId: 'c1', fingerprint: paramFingerprint(first), artifactPath: '/out/1.jpg' },
          { cardId: 'c2', fingerprint: paramFingerprint(second), artifactPath: '/out/2.avif' },
        ],
      },
    });
    const probe = probeOf({ '/photos/a.png': okIdentity('/photos/a.png', { sizeBytes: 2048 }) });
    const verdict = judgeImageEntry(target, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toEqual(['image']);
    expect(verdict.encoders.map((item) => [item.cardId, item.run, item.reasons])).toEqual([
      ['c1', true, ['image']],
      ['c2', true, ['image']],
    ]);
  });

  it.each<[string, ImageIdentityReading]>([
    ['路径', okIdentity('/photos/renamed.png')],
    ['大小', okIdentity('/photos/a.png', { sizeBytes: 2048 })],
    ['修改时间', okIdentity('/photos/a.png', { modifiedMs: 2_000 })],
  ])('原图标识的「%s」变化 → 整图判定待重跑', (_label, reading) => {
    const target = scoredEntry();
    const probe = probeOf({ '/photos/a.png': reading });
    const verdict = judgeImageEntry(target, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toEqual(['image']);
    expect(verdict.encoders.every((item) => item.run)).toBe(true);
  });

  it('原图读取失败 → 按已变更处理，全部条目待重跑', () => {
    const target = scoredEntry();
    const probe = probeOf({
      '/photos/a.png': { kind: 'failed', path: '/photos/a.png', reason: '文件已被移走' },
    });
    const verdict = judgeImageEntry(target, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toEqual(['image']);
    expect(verdict.encoders[0].run).toBe(true);
  });

  it('快照里缺这条卡的记录（例如新加的卡）→ 只跑这条，原因是「从没跑过」', () => {
    const oldCard = card({ id: 'c1' });
    const added = card({ id: 'c2', encoderId: 'jxl' });
    const target = entry({
      encoders: [oldCard, added],
      snapshot: {
        identity,
        encoders: [{ cardId: 'c1', fingerprint: paramFingerprint(oldCard), artifactPath: '/out/1.jpg' }],
      },
    });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.encoders.map((item) => [item.cardId, item.run, item.reasons])).toEqual([
      ['c1', false, []],
      ['c2', true, ['never']],
    ]);
    // 只有部分卡跑过的新图：图片级是「将重跑」，原因是从没跑过的那条卡
    expect(verdict.state).toBe('stale');
    expect(badgeText(verdict.state, verdict.reasons)).toBe('将重跑（从没跑过）');
  });

  it('上次失败 → 将重跑 / 上次失败，失败原因可带出；绝不算已跑分', () => {
    const failedCard = card({ id: 'c1' });
    const target = entry({
      encoders: [failedCard],
      snapshot: null,
      failures: [{ cardId: 'c1', reason: 'cjpeg 退出码 1' }],
    });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('failed');
    expect(verdict.encoders[0].run).toBe(true);
    expect(verdict.encoders[0].reasons).toEqual(['failed']);
    expect(badgeText(verdict.state, verdict.reasons)).toBe('上次失败');
  });

  it('有旧快照但本次该卡失败 → 该卡仍要跑（失败覆盖旧成功记录）', () => {
    const target = scoredEntry({ failures: [{ cardId: 'card-1', reason: '跑分服务不可用' }] });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('failed');
    expect(verdict.encoders[0].run).toBe(true);
    expect(verdict.encoders[0].reasons).toContain('failed');
  });

  it('失败记录只认当前配置里还在的卡（删掉的卡不会把整图拖成失败）', () => {
    const target = scoredEntry({ failures: [{ cardId: '已被删掉的卡', reason: '旧错误' }] });
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('scored');
  });

  it('四态徽章文案：未跑分 / 已跑分 / 将重跑（带原因）/ 上次失败', () => {
    expect(badgeText('unscored', [])).toBe('未跑分');
    expect(badgeText('scored', [])).toBe('已跑分');
    expect(badgeText('stale', ['params'])).toBe('将重跑（参数改了）');
    expect(badgeText('stale', ['image'])).toBe('将重跑（图片换了）');
    expect(badgeText('failed', ['failed'])).toBe('上次失败');
    expect(IMAGE_ENTRY_STATE_LABELS.stale).toBe('将重跑');
    expect(badgeText('stale', ['params', 'image'])).toBe('将重跑（参数改了、图片换了）');
    expect(DIRTY_REASON_LABELS.never).toBe('从没跑过');
  });
});

// ---------- 换图 ----------

describe('更换图片', () => {
  it('换图后配置与参数保留，但该条目全部编码器都判定待重跑', () => {
    const first = card({ id: 'c1' });
    const target = entry({
      encoders: [first, card({ id: 'c2', encoderId: 'webp' })],
      snapshot: {
        identity,
        encoders: [{ cardId: 'c1', fingerprint: paramFingerprint(first), artifactPath: '/out/1.jpg' }],
      },
    });
    replaceImagePath(target, '/photos/new.png');
    expect(target.encoders.map((item) => item.encoderId)).toEqual(['jpeg', 'webp']);
    expect(target.encoders[0].quality).toBe(75);

    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('stale');
    expect(verdict.encoders.map((item) => item.run)).toEqual([true, true]);
    expect(verdict.reasons).toEqual(['image']);
  });

  it('换到一张大小与修改时间恰好相同的图，也一律待重跑（显式换图不靠标识兜底）', () => {
    const target = scoredEntry();
    replaceImagePath(target, '/photos/same-meta.png');
    const probe = probeOf({
      '/photos/same-meta.png': okIdentity('/photos/same-meta.png'), // 大小/修改时间与旧图一致
    });
    expect(judgeImageEntry(target, probe).state).toBe('stale');
  });

  it('换图会清掉旧快照：不留下指向旧图的产物；跑成功后才恢复「已跑分」', () => {
    const target = scoredEntry();
    replaceImagePath(target, '/photos/new.png');
    expect(target.snapshot).toBeNull();
    expect(target.failures).toEqual([]);
    applyRunResults(
      target,
      [{ kind: 'success', cardId: 'card-1', artifactPath: '/out/new.jpg', fingerprint: paramFingerprint(target.encoders[0]) }],
      okIdentity('/photos/new.png'),
    );
    expect(target.replaced).toBe(false);
    expect(judgeImageEntry(target, probeOf({})).state).toBe('scored');
  });
});

// ---------- 失败不算已跑分 ----------

describe('失败永远不算已跑分', () => {
  it('从未成功、只记了失败 → 状态是上次失败，不是已跑分', () => {
    const target = entry();
    applyRunResults(
      target,
      [{ kind: 'failure', cardId: 'card-1', reason: '编码失败：磁盘已满' }],
      okIdentity('/photos/a.png'),
    );
    expect(target.snapshot).toBeNull();
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('failed');
    expect(verdict.encoders[0].run).toBe(true);
  });

  it('成功过一次之后再失败：旧记录被移除，绝不因为「曾经成功过」被判已跑分', () => {
    const target = scoredEntry();
    applyRunResults(
      target,
      [{ kind: 'failure', cardId: 'card-1', reason: '跑分失败：SSIM 计算错误' }],
      okIdentity('/photos/a.png'),
    );
    expect(target.failures).toEqual([{ cardId: 'card-1', reason: '跑分失败：SSIM 计算错误' }]);
    // 失败那条卡不再有成功记录 → 没有任何记录 → 快照为空
    expect(target.snapshot).toBeNull();
    expect(judgeImageEntry(target, probeOf({})).state).toBe('failed');
  });

  it('一张图里一条成功一条失败：成功的可跳过，失败的下次重试，整图状态为上次失败', () => {
    const ok = card({ id: 'c1' });
    const bad = card({ id: 'c2', encoderId: 'avif' });
    const target = entry({ encoders: [ok, bad] });
    applyRunResults(
      target,
      [
        { kind: 'success', cardId: 'c1', artifactPath: '/out/1.jpg', fingerprint: paramFingerprint(ok) },
        { kind: 'failure', cardId: 'c2', reason: 'avifenc 不存在' },
      ],
      okIdentity('/photos/a.png'),
    );
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('failed');
    expect(verdict.encoders.map((item) => [item.cardId, item.run])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    expect(target.snapshot?.encoders).toHaveLength(1);
  });

  it('entryFailures 只给出当前配置里还在的卡的失败明细（含编码器 id）', () => {
    const target = entry({
      encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'webp' })],
      failures: [
        { cardId: 'c1', reason: 'cjpeg 退出码 1' },
        { cardId: '已删除的卡', reason: '旧错误' },
      ],
    });
    expect(entryFailures(target)).toEqual([
      { cardId: 'c1', encoderId: 'jpeg', reason: 'cjpeg 退出码 1' },
    ]);
  });

  it('失败原因按卡记录，不会张冠李戴', () => {
    const target = entry({ encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'webp' })] });
    applyRunResults(
      target,
      [
        { kind: 'success', cardId: 'c1', artifactPath: '/out/1.jpg', fingerprint: paramFingerprint(target.encoders[0]) },
        { kind: 'failure', cardId: 'c2', reason: 'cwebp 崩溃' },
      ],
      okIdentity('/photos/a.png'),
    );
    expect(target.failures).toEqual([{ cardId: 'c2', reason: 'cwebp 崩溃' }]);
  });
});

// ---------- 产物 → 条目反查（票 #82：主界面胶囊即参数入口） ----------

describe('entryForArtifact：由跑分图路径反查产出它的条目', () => {
  /** 跑过一次的条目：唯一一张卡产出 artifactPath（走真实结果回写，快照形状与运行期一致）。 */
  function scoredWithArtifact(id: string, path: string, artifactPath: string): ImageEntry {
    const target = entry({ id, path, encoders: [card({ id: `card-${id}` })] });
    applyRunResults(
      target,
      [
        {
          kind: 'success',
          cardId: `card-${id}`,
          artifactPath,
          fingerprint: paramFingerprint(card({ id: `card-${id}` })),
        },
      ],
      okIdentity(path),
    );
    return target;
  }

  it('命中：返回产出该产物的那个条目，不是列表里的第一张', () => {
    const a = scoredWithArtifact('img-a', '/photos/a.png', '/out/a.jpg');
    const b = scoredWithArtifact('img-b', '/photos/b.png', '/out/b.jpg');

    expect(entryForArtifact([a, b], '/out/a.jpg')?.id).toBe('img-a');
    expect(entryForArtifact([a, b], '/out/b.jpg')?.id).toBe('img-b');
  });

  it('未命中：人工导入的跑分图不指向任何条目', () => {
    const a = scoredWithArtifact('img-a', '/photos/a.png', '/out/a.jpg');

    expect(entryForArtifact([a], '/imports/from-photoshop.jpg')).toBeNull();
  });

  it('没有快照（从未成功跑分）的条目不参与反查', () => {
    const fresh = newImageEntry('/photos/c.png');

    expect(entryForArtifact([fresh], '/out/c.jpg')).toBeNull();
  });

  it('换过图后快照已清：旧产物不再指向该条目', () => {
    const a = scoredWithArtifact('img-a', '/photos/a.png', '/out/a.jpg');
    replaceImagePath(a, '/photos/a2.png');

    expect(entryForArtifact([a], '/out/a.jpg')).toBeNull();
  });

  it('多条命中取第一条（结果确定，不随列表顺序抖动）', () => {
    const a = scoredWithArtifact('img-a', '/photos/a.png', '/out/same.jpg');
    const b = scoredWithArtifact('img-b', '/photos/b.png', '/out/same.jpg');

    expect(entryForArtifact([a, b], '/out/same.jpg')?.id).toBe('img-a');
    expect(entryForArtifact([b, a], '/out/same.jpg')?.id).toBe('img-b');
  });

  it('空条目列表：返回 null（重启后条目清空，胶囊不该假装可配）', () => {
    expect(entryForArtifact([], '/out/a.jpg')).toBeNull();
  });
});

// ---------- 跑分计划 ----------

describe('跑分计划', () => {
  it('拆出要跑的编码器清单（含所属条目）与跳过条目清单（含原因），计数与清单一致', () => {
    const cleanB = card({ id: 'b1', encoderId: 'webp' });
    const entries = [
      scoredEntry({ id: 'imgA', path: '/photos/a.png' }, { id: 'a1' }),
      entry({
        id: 'imgB',
        path: '/photos/b.png',
        encoders: [cleanB],
        snapshot: { identity: { path: '/photos/b.png', sizeBytes: 1024, modifiedMs: 1_000 }, encoders: [{ cardId: 'b1', fingerprint: paramFingerprint(cleanB), artifactPath: '/out/b.webp' }] },
      }),
      entry({ id: 'imgC', path: '/photos/c.png', encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'avif' })] }),
    ];
    const plan = planScore(entries, probeOf({}));
    expect(plan.encoders.map((item) => [item.imageId, item.encoder.id])).toEqual([
      ['imgC', 'c1'],
      ['imgC', 'c2'],
    ]);
    expect(plan.encoders[1].encoder.encoderId).toBe('avif');
    expect(plan.skippedImages.map((item) => [item.imageId, item.reason.code])).toEqual([
      ['imgA', 'clean'],
      ['imgB', 'clean'],
    ]);
    expect(plan.skippedImages[0].reason.text).toBe('已跑分且无变更');
    // 计数口径是图片张数：imgC 有两条编码器，但只算 1 张
    expect(plan.runImageCount).toBe(1);
    expect(plan.skippedImageCount).toBe(2);
    expect(plan.runImageCount + plan.skippedImageCount).toBe(entries.length);
    // 编码器条数另有一个显式字段：imgC 有两条卡，所以是 2（不是 1 张）
    expect(plan.runEncoderCount).toBe(2);
  });

  it('部分卡脏的条目算「要跑」，只把脏卡放进编码器清单', () => {
    const clean = card({ id: 'c1' });
    const dirty = card({ id: 'c2', encoderId: 'webp', quality: 42 });
    const target = entry({
      id: 'imgX',
      encoders: [clean, dirty],
      snapshot: {
        identity,
        encoders: [
          { cardId: 'c1', fingerprint: paramFingerprint(clean), artifactPath: '/out/1.jpg' },
          { cardId: 'c2', fingerprint: paramFingerprint(card({ id: 'c2', encoderId: 'webp' })), artifactPath: '/out/2.webp' },
        ],
      },
    });
    const plan = planScore([target], probeOf({}));
    expect(plan.encoders.map((item) => item.encoder.id)).toEqual(['c2']);
    expect(plan.runImageCount).toBe(1);
    expect(plan.skippedImageCount).toBe(0);
    expect(plan.skippedImages).toEqual([]);
  });

  it('换图后整条进入要跑清单（全部编码器都在计划里）', () => {
    const target = scoredEntry({ encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'jxl' })] });
    replaceImagePath(target, '/photos/new.png');
    const plan = planScore([target], probeOf({}));
    expect(plan.encoders.map((item) => item.encoder.id)).toEqual(['c1', 'c2']);
    expect(plan.encoders[0].reasons).toEqual(['image']);
    expect(plan.runImageCount).toBe(1);
  });

  it('全部条目都可跳过时计划为空（后续票据只弹提示、不执行跑分）', () => {
    const a = scoredEntry({ id: 'a' }, { id: 'a1' });
    const bCard = card({ id: 'b1' });
    const b = entry({
      id: 'b',
      path: '/photos/b.png',
      encoders: [bCard],
      snapshot: { identity: { path: '/photos/b.png', sizeBytes: 1024, modifiedMs: 1_000 }, encoders: [{ cardId: 'b1', fingerprint: paramFingerprint(bCard), artifactPath: '/out/b.jpg' }] },
    });
    const plan = planScore([a, b], probeOf({}));
    expect(plan.encoders).toEqual([]);
    expect(isPlanEmpty(plan)).toBe(true);
    expect(plan.runEncoderCount).toBe(0);
    expect(plan.runImageCount).toBe(0);
    expect(plan.skippedImageCount).toBe(2);
  });

  it('完全没有条目时计划为空', () => {
    const plan = planScore([], probeOf({}));
    expect(isPlanEmpty(plan)).toBe(true);
    expect(plan.runImageCount).toBe(0);
    expect(plan.skippedImageCount).toBe(0);
  });

  it('没有编码器配置的条目整条跳过并给出「没有编码器配置」原因', () => {
    const plan = planScore([entry({ encoders: [] })], probeOf({}));
    expect(isPlanEmpty(plan)).toBe(true);
    expect(plan.skippedImages).toEqual([
      { imageId: 'img-1', path: '/photos/a.png', label: '空配置', encoderCount: 0, reason: { code: 'no-encoders', text: '没有编码器配置' } },
    ]);
  });

  it('同一路径的多个条目共用一次标识读取（读盘只发生一次）', () => {
    let reads = 0;
    const probe: ImageIdentityProbe = (path) => {
      reads += 1;
      return okIdentity(path);
    };
    planScore([entry({ id: 'a' }), entry({ id: 'b' })], probe);
    expect(reads).toBe(1);
  });
});

// ---------- 汇总文案 ----------

describe('汇总文案', () => {
  it('「本次跑分 N 张，跳过 M 张」按图片张数计数，不按编码器条数', () => {
    const target = entry({ id: 'imgC', encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'avif' }), card({ id: 'c3', encoderId: 'jxl' })] });
    const skipped = scoredEntry({ id: 'imgA' });
    const plan = planScore([target, skipped], probeOf({}));
    expect(plan.encoders).toHaveLength(3);
    expect(summaryHeadline(plan.runImageCount, plan.skippedImageCount)).toBe('本次跑分 1 张，跳过 1 张');
    expect(planSummary(plan).headline).toBe('本次跑分 1 张，跳过 1 张');
  });

  it('逐个点名跳过原因（变体摘要 + 原因，不再用原图文件名——同轮各变体共用一张原图）', () => {
    const aCard = card({ id: 'a1' });
    const a = entry({
      id: 'a',
      encoders: [aCard],
      snapshot: {
        identity,
        encoders: [{ cardId: 'a1', fingerprint: paramFingerprint(aCard), artifactPath: '/out/a.jpg' }],
      },
    });
    const b = entry({ id: 'b', encoders: [] });
    const plan = planScore([a, b], probeOf({}));
    expect(planSummary(plan).skipLines).toEqual([
      'JPEG q75（已跑分且无变更）',
      '空配置（没有编码器配置）',
    ]);
    expect(skipReasonLine(plan.skippedImages[0])).toBe('JPEG q75（已跑分且无变更）');
    expect(SKIP_REASON_LABELS.clean).toBe('已跑分且无变更');
  });

  it('零跳过时只有标题、没有逐条原因', () => {
    const plan = planScore([entry()], probeOf({}));
    expect(planSummary(plan)).toEqual({ headline: '本次跑分 1 张，跳过 0 张', skipLines: [] });
  });
});

// ---------- 变体摘要与预设参数 ----------

describe('变体摘要与预设参数', () => {
  it('卡片摘要：质量优先 / 无损 / 大小优先', () => {
    expect(cardSummary(card())).toBe('JPEG q75');
    expect(cardSummary(card({ encoderId: 'webp', lossless: true }))).toBe('WebP 无损');
    expect(cardSummary(card({ encoderId: 'avif', mode: 'size', targetBytes: 200 * 1024 }))).toBe(
      'AVIF 目标 200 KB',
    );
  });

  it('多卡变体点名条数；空配置有明确的占位文案', () => {
    const v = entry({ encoders: [card({ id: 'c1' }), card({ id: 'c2', encoderId: 'avif' })] });
    expect(variantSummary(v)).toBe('JPEG q75 等 2 条');
    expect(variantSummary(entry({ encoders: [] }))).toBe('空配置');
  });
});

// ---------- 会话态与复制 ----------

describe('参数变体会话态与复制', () => {
  it('同一轮的变体跨多次取用共享；不同轮 / 不同组互不串扰', () => {
    const first = imageQueueFor('g1', 'r1');
    addEntries(first, ['/photos/a.png']);
    expect(imageQueueFor('g1', 'r1')).toBe(first);
    expect(imageQueueFor('g1', 'r1').entries).toHaveLength(1);
    expect(imageQueueFor('g1', 'r2').entries).toHaveLength(0);
    expect(imageQueueFor('g2', 'r1').entries).toHaveLength(0);
  });

  it('新变体不带轮 id（取消独立轮次），默认未跑分', () => {
    const target = newVariant('/photos/a.png');
    expect(target.snapshot).toBeNull();
    expect(target.failures).toEqual([]);
    expect(target.replaced).toBe(false);
    expect(judgeImageEntry(target, probeOf({})).state).toBe('unscored');
  });

  it('syncEntryReference：路径不同即整体作废（快照/失败清空、置为图片换了）；相同不动', () => {
    const target = scoredEntry();
    target.failures = [{ cardId: target.encoders[0].id, reason: '旧失败' }];
    expect(syncEntryReference([target], '/photos/a.png')).toBe(false);
    expect(target.snapshot).not.toBeNull();

    expect(syncEntryReference([target], '/photos/b.png')).toBe(true);
    expect(target.path).toBe('/photos/b.png');
    expect(target.snapshot).toBeNull();
    expect(target.failures).toEqual([]);
    expect(target.replaced).toBe(true);
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toContain('image');
  });

  it('forgetArtifact：抹掉被移出本轮的产物记录，变体回到待跑', () => {
    const target = scoredEntry();
    expect(judgeImageEntry(target, probeOf({})).state).toBe('scored');
    expect(forgetArtifact(target, '/out/a.jpg')).toBe(true);
    expect(target.snapshot).toBeNull();
    expect(judgeImageEntry(target, probeOf({})).state).toBe('unscored');
    // 没这条记录时什么也不做
    expect(forgetArtifact(target, '/out/a.jpg')).toBe(false);
  });

  it('removeImageEntry 按 id 删除并回传被删变体；找不到返回 null', () => {
    const session = imageQueueFor('g1', 'r1');
    const [first, second] = addEntries(session, ['/a.png', '/b.png']);
    const removed = removeImageEntry(session.entries, first.id);
    expect(removed?.id).toBe(first.id);
    expect(session.entries.map((item) => item.id)).toEqual([second.id]);
    expect(removeImageEntry(session.entries, '不存在')).toBeNull();
  });

  it('dropImageQueue 丢弃整组（含全部轮）；clearImageQueues 模拟重启归零', () => {
    addEntries(imageQueueFor('g1', 'r1'), ['/a.png']);
    addEntries(imageQueueFor('g1', 'r2'), ['/b.png']);
    dropImageQueue('g1');
    expect(imageQueueFor('g1', 'r1').entries).toHaveLength(0);
    expect(imageQueueFor('g1', 'r2').entries).toHaveLength(0);
    addEntries(imageQueueFor('g2', 'r1'), ['/b.png']);
    clearImageQueues();
    expect(imageQueueFor('g2', 'r1').entries).toHaveLength(0);
  });

  it('一个轮添变体不会让同组另一个轮出现变体', () => {
    addEntries(imageQueueFor('g1', 'r1'), ['/a.png', '/b.png']);
    const other = imageQueueFor('g1', 'r2');
    expect(other.entries).toEqual([]);
    expect(planScore(other.entries, probeOf({})).runImageCount).toBe(0);
  });
});

// ---------- 历史重复参数行的加载归一化 ----------

describe('历史重复参数行归一化（进入编辑前修好）', () => {
  /** 一张带历史重复 -progressive 的编码器卡（旧版本界面能加出这种行）。 */
  const duplicateCard = (): EncoderCard =>
    card({
      rows: [
        row({ name: '渐进式', flag: '-progressive' }),
        row({ name: '重复的渐进式', flag: '-progressive' }),
        row({ name: '平滑', flag: '-smooth', value: '20' }),
      ],
    });

  it('normalizeCardRows 保留第一行，把后面的重复行标成不生效（幂等）', () => {
    const target = duplicateCard();
    expect(normalizeCardRows(target)).toBe(true);
    expect(target.rows.map((item) => item.enabled)).toEqual([true, false, true]);
    // 第二次调用没有可改写的行
    expect(normalizeCardRows(target)).toBe(false);
  });

  it('syncEntryReference 同步时就归一化（即使原图路径没变，也返回被改写）', () => {
    const target = entry({ encoders: [duplicateCard()] });
    expect(syncEntryReference([target], '/photos/a.png')).toBe(true);
    expect(target.encoders[0].rows[1]?.enabled).toBe(false);
  });

  it('imageQueueFor 取变体列表时归一化（弹窗与就地编辑都经这条加载路径）', () => {
    const session = imageQueueFor('g1', 'r1');
    // 直接 push 一段历史数据：模拟加载前就存在的重复行
    session.entries.push(entry({ encoders: [duplicateCard()] }));
    expect(session.entries[0]?.encoders[0].rows[1]?.enabled).toBe(true);

    const loaded = imageQueueFor('g1', 'r1').entries[0];
    expect(loaded?.encoders[0].rows[1]?.enabled).toBe(false);
    expect(loaded?.encoders[0].rows[0]?.enabled).toBe(true);
  });

  it('归一化只做一次：用户事后重新打开的重复行不会被下一次加载悄悄改回去', () => {
    const session = imageQueueFor('g1', 'r1');
    const target = entry({ encoders: [duplicateCard()] });
    session.entries.push(target);
    expect(imageQueueFor('g1', 'r1').entries[0]).toBe(target);
    expect(target.encoders[0].rows[1]?.enabled).toBe(false);

    // 用户明确把重复行重新打开：界面会显示冲突红字，提交时 mergeArgs 仍会报错；
    // 加载路径不再替他做决定。
    target.encoders[0].rows[1]!.enabled = true;
    imageQueueFor('g1', 'r1');
    expect(target.encoders[0].rows[1]?.enabled).toBe(true);
  });
});

// ---------- 组合场景：改参数 → 计划 → 跑完 → 再判定 ----------

describe('端到端（纯逻辑）', () => {
  it('首次全跑 → 改一张参数 → 只重跑那张 → 跑完回到已跑分', () => {
    const probe = probeOf({});
    const a = newImageEntry('/photos/a.png');
    const b = newImageEntry('/photos/b.png');

    const firstPlan = planScore([a, b], probe);
    expect(firstPlan.runImageCount).toBe(2);
    expect(firstPlan.encoders).toHaveLength(2);
    for (const planned of firstPlan.encoders) {
      const owner = planned.imageId === a.id ? a : b;
      applyRunResults(owner, [{ kind: 'success', cardId: planned.encoder.id, artifactPath: `/out/${planned.encoder.id}.jpg`, fingerprint: planned.fingerprint }], okIdentity(planned.path));
    }
    expect(judgeImageEntry(a, probe).state).toBe('scored');
    expect(judgeImageEntry(b, probe).state).toBe('scored');

    b.encoders[0].quality = 60;
    const secondPlan = planScore([a, b], probe);
    expect(secondPlan.runImageCount).toBe(1);
    expect(secondPlan.skippedImageCount).toBe(1);
    expect(secondPlan.encoders.map((item) => item.imageId)).toEqual([b.id]);
    expect(secondPlan.skippedImages[0].path).toBe('/photos/a.png');
    expect(planSummary(secondPlan).skipLines).toEqual(['JPEG q75（已跑分且无变更）']);

    const planned = secondPlan.encoders[0];
    applyRunResults(b, [{ kind: 'success', cardId: planned.encoder.id, artifactPath: '/out/b2.jpg', fingerprint: planned.fingerprint }], okIdentity(b.path));
    expect(isPlanEmpty(planScore([a, b], probe))).toBe(true);
  });

  it('跑分中途改了参数：写回的是计划时指纹，下一轮如实判成「参数改了」', () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    const plan = planScore([target], probeOf({}));
    const planned = plan.encoders[0];
    // 跑分期间用户把质量从 75 改成 90
    target.encoders[0].quality = 90;
    applyRunResults(
      target,
      [{ kind: 'success', cardId: 'c1', artifactPath: '/out/1.jpg', fingerprint: planned.fingerprint }],
      okIdentity('/photos/a.png'),
    );
    // 快照记的是计划时（q75）的指纹 → 与当前 q90 不一致 → 待重跑
    const verdict = judgeImageEntry(target, probeOf({}));
    expect(verdict.state).toBe('stale');
    expect(verdict.encoders[0].reasons).toEqual(['params']);
  });

  it('跑分期间卡被删掉：迟到的结果被丢弃，不会复活旧卡', () => {
    const target = entry({ encoders: [card({ id: 'c1' })] });
    target.encoders = [];
    applyRunResults(target, [{ kind: 'success', cardId: 'c1', artifactPath: '/out/1.jpg', fingerprint: paramFingerprint(card({ id: 'c1' })) }], okIdentity('/photos/a.png'));
    expect(target.snapshot).toBeNull();
    expect(target.failures).toEqual([]);
  });

  it('结果为空时什么都不改（没跑过就是没跑过）', () => {
    const target = entry();
    applyRunResults(target, [], okIdentity('/photos/a.png'));
    expect(target.snapshot).toBeNull();
    expect(target.failures).toEqual([]);
  });

  it('读不到原图标识时成功结果仍生效，但快照沿用旧标识（下次判定按已变更重跑）', () => {
    const target = scoredEntry();
    applyRunResults(
      target,
      [{ kind: 'success', cardId: 'card-1', artifactPath: '/out/2.jpg', fingerprint: paramFingerprint(target.encoders[0]) }],
      { kind: 'failed', path: '/photos/a.png', reason: '文件不可读' },
    );
    expect(target.snapshot?.identity).toEqual(identity);
    expect(judgeImageEntry(target, probeOf({})).state).toBe('scored');
  });

  it('从未有过标识又读不到：不写快照（保守重跑）', () => {
    const target = entry();
    applyRunResults(
      target,
      [{ kind: 'success', cardId: 'card-1', artifactPath: '/out/1.jpg', fingerprint: paramFingerprint(target.encoders[0]) }],
      { kind: 'failed', path: '/photos/a.png', reason: '文件不可读' },
    );
    expect(target.snapshot).toBeNull();
    expect(judgeImageEntry(target, probeOf({})).state).toBe('unscored');
  });
});
