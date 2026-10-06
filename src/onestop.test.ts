// 一站式（T22 两种模式）的前端接线测试：mock IPC 命令，验证目录加载、核心库取点
// 的过滤、大小优先搜索结果展开成生成清单——只测纯逻辑，不测 DOM（规格 Testing Decisions）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  defaultSelection,
  filterLadder,
  initOnestopCatalog,
  losslessLadder,
  sizeOutcomeLadder,
  LOSSLESS_FORMATS,
  LOSSY_FORMATS,
  searchSizeFormat,
  type LadderItem,
  type SizeSearchOutcome,
} from './onestop';

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

/** 与核心库 quality_ladder(75) 输出一致的桩阶梯（15 项） */
const fullLadder: LadderItem[] = [
  { format: 'jpeg', quality: 60, label: 'JPEG q60' },
  { format: 'jpeg', quality: 75, label: 'JPEG q75' },
  { format: 'jpeg', quality: 90, label: 'JPEG q90' },
  { format: 'webp', quality: 60, label: 'WebP q60' },
  { format: 'webp', quality: 75, label: 'WebP q75' },
  { format: 'webp', quality: 90, label: 'WebP q90' },
  { format: 'avif', quality: 60, label: 'AVIF q60' },
  { format: 'avif', quality: 75, label: 'AVIF q75' },
  { format: 'avif', quality: 90, label: 'AVIF q90' },
  { format: 'jxl', quality: 60, label: 'JPEG XL q60' },
  { format: 'jxl', quality: 75, label: 'JPEG XL q75' },
  { format: 'jxl', quality: 90, label: 'JPEG XL q90' },
  { format: 'png', quality: null, label: 'PNG' },
  { format: 'webp-lossless', quality: null, label: '无损 WebP' },
  { format: 'jxl-lossless', quality: null, label: '无损 JXL' },
];

describe('onestop 目录与阶梯（T22）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('initOnestopCatalog：失败目录保持为空，成功后填充格式清单（不再自持档位）', async () => {
    // 目录是模块级状态（与界面一致，随生命周期只拉取一次），故两个阶段按序在
    // 同一用例里验证：先失败（保持空、错误上抛交由 boot 提示），再成功（填充）。
    invokeMock.mockRejectedValue(new Error('IPC 断了'));
    await expect(initOnestopCatalog()).rejects.toThrow('IPC 断了');
    expect(LOSSY_FORMATS).toEqual([]);
    expect(LOSSLESS_FORMATS).toEqual([]);
    expect(filterLadder(fullLadder, defaultSelection())).toEqual([]);

    invokeMock.mockResolvedValue(catalog);
    await initOnestopCatalog();

    expect(invokeMock).toHaveBeenCalledWith('onestop_default_ladder');
    expect(LOSSY_FORMATS.map((f) => f.format)).toEqual(['jpeg', 'webp', 'avif', 'jxl']);
    expect(LOSSLESS_FORMATS.map((f) => f.format)).toEqual(['png', 'webp-lossless', 'jxl-lossless']);

    // 默认全选：核心库阶梯原样通过（15 项，与 quality_ladder(75) 一致）
    expect(filterLadder(fullLadder, defaultSelection())).toEqual(fullLadder);
  });

  it('filterLadder：按格式勾选过滤有损项与无损项，顺序保持', () => {
    invokeMock.mockResolvedValue(catalog);
    return initOnestopCatalog().then(() => {
      // 只留 JPEG + 无损 PNG：其余有损与无损项全部剔除，相对顺序不变
      const ladder = filterLadder(fullLadder, {
        lossyFormats: ['jpeg'],
        losslessFormats: ['png'],
      });
      expect(ladder).toEqual([
        { format: 'jpeg', quality: 60, label: 'JPEG q60' },
        { format: 'jpeg', quality: 75, label: 'JPEG q75' },
        { format: 'jpeg', quality: 90, label: 'JPEG q90' },
        { format: 'png', quality: null, label: 'PNG' },
      ]);

      // 全部移除（含无损组）：空清单，触发入口应置灰/提示
      expect(filterLadder(fullLadder, { lossyFormats: [], losslessFormats: [] })).toEqual([]);
    });
  });

  it('losslessLadder：大小优先的无损对照组按勾选原样入清单（不参与搜索）', () => {
    invokeMock.mockResolvedValue(catalog);
    return initOnestopCatalog().then(() => {
      expect(losslessLadder(defaultSelection())).toEqual([
        { format: 'png', quality: null, label: 'PNG' },
        { format: 'webp-lossless', quality: null, label: '无损 WebP' },
        { format: 'jxl-lossless', quality: null, label: '无损 JXL' },
      ]);
      expect(
        losslessLadder({ lossyFormats: [], losslessFormats: ['jxl-lossless'] }),
      ).toEqual([{ format: 'jxl-lossless', quality: null, label: '无损 JXL' }]);
    });
  });

  it('searchSizeFormat：透传 onestop_size_search 载荷（目标传字节）', async () => {
    invokeMock.mockResolvedValue(catalog);
    await initOnestopCatalog();
    invokeMock.mockResolvedValue({
      format: 'jpeg',
      targetBytes: 13312,
      hit: { quality: 74, bytes: 13454 },
      note: null,
      points: [
        { quality: 59, bytes: 10421 },
        { quality: 74, bytes: 13454 },
        { quality: 89, bytes: 21007 },
      ],
    });
    const outcome = await searchSizeFormat({
      groupId: 'g1',
      roundId: 'r1',
      referencePath: '/tmp/ref.png',
      format: 'jpeg',
      targetBytes: 13 * 1024,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('onestop_size_search', {
      groupId: 'g1',
      roundId: 'r1',
      referencePath: '/tmp/ref.png',
      format: 'jpeg',
      targetBytes: 13 * 1024,
    });
    expect(outcome.hitQuality).toBe(74);
    expect(outcome.note).toBeNull();
    expect(outcome.points).toHaveLength(3);
  });

  it('sizeOutcomeLadder：命中点 + 邻近补点展开成生成清单，标注随格式携带', () => {
    invokeMock.mockResolvedValue(catalog);
    return initOnestopCatalog().then(() => {
      const outcome: SizeSearchOutcome = {
        format: 'jxl',
        targetBytes: 1024,
        hitQuality: 1,
        hitBytes: 4021,
        note: '目标 1024 字节过小不可达，已取最接近点 q1（实际 4021 字节）',
        points: [
          { quality: 1, bytes: 4021 },
          { quality: 16, bytes: 5310 },
          { quality: 31, bytes: 6902 },
        ],
      };
      expect(sizeOutcomeLadder(outcome)).toEqual([
        { format: 'jxl', quality: 1, label: 'JPEG XL q1' },
        { format: 'jxl', quality: 16, label: 'JPEG XL q16' },
        { format: 'jxl', quality: 31, label: 'JPEG XL q31' },
      ]);
      expect(outcome.note).toContain('不可达');
    });
  });
});
