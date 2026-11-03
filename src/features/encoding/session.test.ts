// 编码阶梯会话态测试（决策 0042）：两条缓存轴、原图失效、默认勾选与预览出口。
//
// 这里只测状态函数，不碰 DOM；分区渲染由手工验收与 design-guards 覆盖。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { initOnestopCatalog, type LadderItem, type SizeSearchOutcome } from './logic/ladder';
import type { CandidateImage, Round } from '../../core/model';
import {
  DEFAULT_BASELINE,
  DEFAULT_TARGET_BYTES,
  ensureDefaultSelection,
  ladderStateFor,
  previewOf,
  qualityKeyOf,
  setBaseline,
  setLadderMode,
  setTargetBytes,
  sizeKeyOf,
  syncQualityKey,
  syncReference,
  syncSizeKey,
  toggleSelectionFormat,
  type LadderUiState,
} from './session';

const invokeMock = vi.mocked(invoke);

const catalog = {
  lossyFormats: [
    { format: 'jpeg', label: 'JPEG' },
    { format: 'webp', label: 'WebP' },
    { format: 'avif', label: 'AVIF' },
    { format: 'jxl', label: 'JPEG XL' },
  ],
  losslessFormats: [
    { format: 'png', label: 'PNG' },
    { format: 'webp-lossless', label: '无损 WebP' },
    { format: 'jxl-lossless', label: '无损 JXL' },
  ],
};

const ladder: LadderItem[] = [
  { format: 'jpeg', quality: 75, label: 'JPEG q75' },
  { format: 'webp', quality: 75, label: 'WebP q75' },
  { format: 'avif', quality: 75, label: 'AVIF q75' },
  { format: 'jxl', quality: 95, label: 'JPEG XL q95' },
  { format: 'png', quality: null, label: 'PNG' },
];

function round(overrides: Partial<Round> = {}): Round {
  return {
    id: 'r1',
    name: '轮 1',
    referencePath: '/ref/a.png',
    referenceSize: 1024,
    candidates: [],
    ...overrides,
  };
}

function outcome(format: string): SizeSearchOutcome {
  return {
    format,
    targetBytes: 200 * 1024,
    hitQuality: 70,
    hitBytes: 204800,
    note: null,
    points: [
      { quality: 60, bytes: 150000 },
      { quality: 70, bytes: 204800 },
      { quality: 80, bytes: 260000 },
    ],
  };
}

function candidate(encodingParams: string): CandidateImage {
  return {
    path: `/out/${encodingParams}.jpg`,
    fileSize: 204800,
    sizeRatio: 0.5,
    metrics: null,
    encodingParams,
    error: null,
  };
}

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(catalog);
  await initOnestopCatalog();
});

describe('默认状态（决策 0042）', () => {
  it('默认单点、基准 75、有损全选、无损不选', () => {
    const state = ladderStateFor('round-defaults');
    expect(state.mode).toBe('single');
    expect(state.baseline).toBe(DEFAULT_BASELINE);
    expect(state.targetBytes).toBe(DEFAULT_TARGET_BYTES);
    expect(state.selection.lossyFormats).toEqual(['jpeg', 'webp', 'avif', 'jxl']);
    expect(state.selection.losslessFormats).toEqual([]);
    expect(state.selectionTouched).toBe(false);
  });

  it('目录晚到时只补一次默认勾选；用户动过勾选后不再覆盖', () => {
    const state = ladderStateFor('round-late-catalog');
    state.selection = { lossyFormats: [], losslessFormats: [] };
    expect(ensureDefaultSelection(state)).toBe(true);
    expect(state.selection.lossyFormats).toEqual(['jpeg', 'webp', 'avif', 'jxl']);

    toggleSelectionFormat(state, 'lossy', 'jpeg');
    expect(state.selectionTouched).toBe(true);
    expect(state.selection.lossyFormats).toEqual(['webp', 'avif', 'jxl']);
    expect(ensureDefaultSelection(state)).toBe(false);
    expect(state.selection.lossyFormats).toEqual(['webp', 'avif', 'jxl']);
  });
});

describe('两条缓存轴', () => {
  it('质量轴：方式或基准变化才清阶梯；切到目标大小不清质量缓存', () => {
    const state = ladderStateFor('round-quality');
    state.ladder = ladder;
    state.ladderKey = 'single:75';
    state.failures = ['旧失败'];

    expect(syncQualityKey(state)).toBe(false);
    expect(state.ladder).toBe(ladder);

    setBaseline(state, 80);
    expect(syncQualityKey(state)).toBe(true);
    expect(state.ladder).toBeNull();
    expect(state.failures).toEqual([]);

    state.ladder = ladder;
    state.ladderKey = 'single:80';
    setLadderMode(state, 'ladder');
    expect(syncQualityKey(state)).toBe(true);
    state.ladder = ladder;
    state.ladderKey = 'ladder:80';

    setLadderMode(state, 'size');
    expect(qualityKeyOf(state)).toBeNull();
    expect(syncQualityKey(state)).toBe(false);
    expect(state.ladder).toBe(ladder);
  });

  it('大小轴：目标或原图变化清探测结果；切方式不清', () => {
    const state = ladderStateFor('round-size');
    state.mode = 'size';
    state.sizeOutcomes = { jpeg: outcome('jpeg') };
    state.sizeErrors = { webp: '探测失败：坏了' };
    state.sizeKey = sizeKeyOf(state);

    expect(syncSizeKey(state)).toBe(false);
    setLadderMode(state, 'single');
    expect(syncSizeKey(state)).toBe(false);
    expect(state.sizeOutcomes).toHaveProperty('jpeg');

    setLadderMode(state, 'size');
    setTargetBytes(state, 300 * 1024);
    expect(state.sizeOutcomes).toEqual({});
    expect(state.sizeErrors).toEqual({});
  });

  it('换原图：清大小轴、失败清单与编码器问题，保留方式与勾选', () => {
    const state = ladderStateFor('round-reference');
    state.mode = 'size';
    state.sizeOutcomes = { jpeg: outcome('jpeg') };
    state.sizeErrors = { webp: '探测失败：坏了' };
    state.failures = ['生成失败'];
    state.encoderIssue = '编码器未就绪';
    state.selection.lossyFormats = ['jpeg'];

    expect(syncReference(state, round({ referencePath: '/ref/b.png', referenceSize: 2048 }))).toBe(
      true,
    );
    expect(state.sizeOutcomes).toEqual({});
    expect(state.sizeErrors).toEqual({});
    expect(state.failures).toEqual([]);
    expect(state.encoderIssue).toBeNull();
    expect(state.mode).toBe('size');
    expect(state.selection.lossyFormats).toEqual(['jpeg']);

    // 同一个原图再同步一次：不重复清空
    state.failures = ['x'];
    expect(syncReference(state, round({ referencePath: '/ref/b.png', referenceSize: 2048 }))).toBe(
      false,
    );
    expect(state.failures).toEqual(['x']);
  });
});

describe('previewOf：界面与生成共用的清单', () => {
  it('单点 + 已勾选无损：清单含四个有损点与无损项；已有参数只计数', () => {
    const state = ladderStateFor('round-preview');
    state.ladder = ladder;
    state.ladderKey = 'single:75';
    toggleSelectionFormat(state, 'lossless', 'png');
    const preview = previewOf(state, [candidate('JPEG q75'), candidate('WebP q75')]);
    expect(preview.count).toBe(5);
    expect(preview.existingCount).toBe(2);
    expect(preview.plan.map((item) => item.label)).toEqual([
      'JPEG q75',
      'WebP q75',
      'AVIF q75',
      'JPEG XL q95',
      'PNG',
    ]);
  });

  it('目标大小未探测：清单为空、四个格式待探测', () => {
    const state = ladderStateFor('round-preview-size');
    state.mode = 'size';
    const preview = previewOf(state);
    expect(preview.count).toBe(0);
    expect(preview.pendingFormats).toEqual(['jpeg', 'webp', 'avif', 'jxl']);
  });
});

describe('setLadderMode / setTargetBytes 的提示清理', () => {
  it('切方式清掉上一次的取点错误与编码器问题', () => {
    const state: LadderUiState = ladderStateFor('round-mode');
    state.ladderError = '取点失败：超时';
    state.encoderIssue = '编码器未就绪';
    setLadderMode(state, 'ladder');
    expect(state.ladderError).toBeNull();
    expect(state.encoderIssue).toBeNull();
  });

  it('改目标大小清掉失败清单与编码器问题', () => {
    const state = ladderStateFor('round-target');
    state.failures = ['旧失败'];
    state.encoderIssue = '编码器未就绪';
    setTargetBytes(state, 300 * 1024);
    expect(state.targetBytes).toBe(300 * 1024);
    expect(state.failures).toEqual([]);
    expect(state.encoderIssue).toBeNull();
  });
});
