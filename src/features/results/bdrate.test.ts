// BD-rate 缓存：指纹变（跑分结果/文件大小/原图变了）就必须重算，否则页签会显示旧汇总。

import { describe, expect, it, beforeEach } from 'vitest';
import type { Round } from '../../core/model';
import type { BdrateSummary } from './ipc';
import {
  bdrateSignature,
  cachedBdrate,
  clearBdrateCache,
  forgetBdrate,
  rememberBdrate,
} from './bdrate';

function makeRound(): Round {
  return {
    id: 'round-1',
    name: '轮 1',
    referencePath: '/r/ref.png',
    referenceSize: 1000,
    candidates: [
      {
        path: '/r/a.jpg',
        fileSize: 100,
        sizeRatio: 0.1,
        metrics: { PSNR: 30 },
        error: null,
      },
      {
        path: '/r/b.webp',
        fileSize: 120,
        sizeRatio: 0.12,
        metrics: { PSNR: 32 },
        error: null,
      },
    ],
  };
}

const summary: BdrateSummary = {
  referenceFormat: 'JPEG',
  note: null,
  entries: [{ format: 'JPEG', bdRatePercent: null, pointCount: 1, note: '参照格式' }],
};

describe('bdrateSignature', () => {
  it('稳定：同样数据签名相同', () => {
    expect(bdrateSignature(makeRound())).toBe(bdrateSignature(makeRound()));
  });

  it('PSNR 变化会改变签名', () => {
    const round = makeRound();
    const before = bdrateSignature(round);
    round.candidates[0].metrics = { PSNR: 31 };
    expect(bdrateSignature(round)).not.toBe(before);
  });

  it('文件大小变化会改变签名', () => {
    const round = makeRound();
    const before = bdrateSignature(round);
    round.candidates[1].fileSize = 121;
    expect(bdrateSignature(round)).not.toBe(before);
  });

  it('换原图会改变签名', () => {
    const round = makeRound();
    const before = bdrateSignature(round);
    round.referencePath = '/r/other.png';
    expect(bdrateSignature(round)).not.toBe(before);
  });

  it('路径里含分隔符也不会串味（JSON 编码）', () => {
    const a = makeRound();
    const b = makeRound();
    a.candidates = [
      { path: '/r/x|y.jpg', fileSize: 100, sizeRatio: 1, metrics: { PSNR: 30 }, error: null },
    ];
    b.candidates = [
      { path: '/r/x', fileSize: 100, sizeRatio: 1, metrics: { PSNR: 30 }, error: null },
      { path: 'y.jpg', fileSize: 100, sizeRatio: 1, metrics: { PSNR: 30 }, error: null },
    ];
    expect(bdrateSignature(a)).not.toBe(bdrateSignature(b));
  });
});

describe('按轮缓存', () => {
  beforeEach(() => {
    clearBdrateCache();
  });

  it('未计算时为 null', () => {
    expect(cachedBdrate(makeRound())).toBeNull();
  });

  it('记住后命中，数据变了就失效', () => {
    const round = makeRound();
    rememberBdrate(round, summary);
    expect(cachedBdrate(round)).toBe(summary);

    round.candidates[0].metrics = { PSNR: 35 };
    expect(cachedBdrate(round)).toBeNull();
  });

  it('删轮后不再命中', () => {
    const round = makeRound();
    rememberBdrate(round, summary);
    forgetBdrate(round.id);
    expect(cachedBdrate(round)).toBeNull();
  });
});
