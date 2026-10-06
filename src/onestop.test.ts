// 一站式目录（T21 单源化）的前端接线测试：mock IPC 命令，验证 initOnestopCatalog
// 从核心库目录填充档位清单，且默认勾选与展开阶梯与现行默认完全一致
//（数据源切到核心库、界面行为不变的外部行为锚点）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  buildLadder,
  defaultSelection,
  initOnestopCatalog,
  LOSSLESS_FORMATS,
  LOSSY_FORMATS,
  QUALITIES,
} from './onestop';

const invokeMock = vi.mocked(invoke);

const catalog = {
  lossyFormats: [
    { format: 'jpeg', label: 'JPEG' },
    { format: 'webp', label: 'WebP' },
    { format: 'avif', label: 'AVIF' },
    { format: 'jxl', label: 'JPEG XL' },
  ],
  qualities: [60, 75, 90],
  losslessFormats: [
    { format: 'png', label: 'PNG' },
    { format: 'webp-lossless', label: '无损 WebP' },
    { format: 'jxl-lossless', label: '无损 JXL' },
  ],
};

describe('onestop 目录（T21 单源化）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('initOnestopCatalog：失败目录保持为空，成功后填充且默认勾选与阶梯与现行默认一致', async () => {
    // 目录是模块级状态（与界面一致，随生命周期只拉取一次），故两个阶段按序在
    // 同一用例里验证：先失败（保持空、错误上抛交由 boot 提示），再成功（填充）。
    invokeMock.mockRejectedValue(new Error('IPC 断了'));
    await expect(initOnestopCatalog()).rejects.toThrow('IPC 断了');
    expect(LOSSY_FORMATS).toEqual([]);
    expect(QUALITIES).toEqual([]);
    expect(LOSSLESS_FORMATS).toEqual([]);
    expect(buildLadder(defaultSelection())).toEqual([]);

    invokeMock.mockResolvedValue(catalog);
    await initOnestopCatalog();

    expect(invokeMock).toHaveBeenCalledWith('onestop_default_ladder');
    expect(LOSSY_FORMATS.map((f) => f.format)).toEqual(['jpeg', 'webp', 'avif', 'jxl']);
    expect(LOSSY_FORMATS.map((f) => f.label)).toEqual(['JPEG', 'WebP', 'AVIF', 'JPEG XL']);
    expect(QUALITIES).toEqual([60, 75, 90]);
    expect(LOSSLESS_FORMATS.map((f) => f.format)).toEqual(['png', 'webp-lossless', 'jxl-lossless']);

    // 默认全开 + 展开阶梯：15 项，顺序与核心库 quality_ladder(75) 一致
    const ladder = buildLadder(defaultSelection());
    expect(ladder).toHaveLength(15);
    expect(ladder[0]).toEqual({ format: 'jpeg', quality: 60, label: 'JPEG q60' });
    expect(ladder[11]).toEqual({ format: 'jxl', quality: 90, label: 'JPEG XL q90' });
    expect(ladder[12]).toEqual({ format: 'png', quality: null, label: 'PNG' });
    expect(ladder[13]).toEqual({ format: 'webp-lossless', quality: null, label: '无损 WebP' });
  });
});
