// 视频指标列序 / 排序取值 / 首点方向守卫（新架构，从旧 video.test.ts 复制扩展）。

import { describe, expect, it } from 'vitest';
import { firstClickDir, videoMetricKeys, videoSortableValue } from './metrics';
import type { CandidateVideo } from '../../core/model';

function row(overrides: Partial<CandidateVideo>): CandidateVideo {
  return {
    path: '/tmp/dis.mp4',
    fileSize: 27050,
    sizeRatio: 0.45,
    metrics: null,
    error: null,
    elapsedMs: null,
    ...overrides,
  };
}

describe('videoMetricKeys', () => {
  it('VMAF/PSNR/SSIM 按偏好顺序排前（VMAF 是视频主指标）', () => {
    const rows = [row({ metrics: { PSNR: 41.8, SSIM: 0.99, VMAF: 94.9 } })];
    expect(videoMetricKeys(rows)).toEqual(['VMAF', 'PSNR', 'SSIM']);
  });

  it('未知指标按首现顺序跟在偏好列后面', () => {
    const rows = [
      row({ metrics: { VMAF: 90, XPSNR: 40 } }),
      row({ metrics: { XPSNR: 41, VMAF: 91, SSIM: 0.98 } }),
    ];
    expect(videoMetricKeys(rows)).toEqual(['VMAF', 'SSIM', 'XPSNR']);
  });

  it('没有任何已跑分行时返回空数组', () => {
    expect(videoMetricKeys([row({ metrics: null }), row({ metrics: null })])).toEqual([]);
  });
});

describe('videoSortableValue', () => {
  it('inf 哨兵还原为无穷大（参与排序）', () => {
    expect(videoSortableValue(row({ metrics: { PSNR: 'inf' } }), 'PSNR')).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('缺指标 / 缺耗时返回 null（排序沉底）', () => {
    expect(videoSortableValue(row({ metrics: null }), 'VMAF')).toBeNull();
    expect(videoSortableValue(row({ elapsedMs: null }), 'elapsedMs')).toBeNull();
    expect(videoSortableValue(row({ elapsedMs: undefined }), 'elapsedMs')).toBeNull();
  });

  it('耗时与文件大小取原始数值', () => {
    expect(videoSortableValue(row({ elapsedMs: 1234 }), 'elapsedMs')).toBe(1234);
    expect(videoSortableValue(row({ fileSize: 100 }), 'fileSize')).toBe(100);
    expect(videoSortableValue(row({ sizeRatio: 0.45 }), 'sizeRatio')).toBe(0.45);
  });

  it('名称取文件名部分', () => {
    expect(videoSortableValue(row({ path: '/a/b/dis.mp4' }), 'name')).toBe('dis.mp4');
  });

  it('未知键返回 null（不崩）', () => {
    expect(videoSortableValue(row({}), '不存在')).toBeNull();
  });
});

describe('firstClickDir', () => {
  it('文件大小/耗时/名称首点升序，指标与体积比首点降序', () => {
    expect(firstClickDir('fileSize')).toBe(1);
    expect(firstClickDir('elapsedMs')).toBe(1);
    expect(firstClickDir('name')).toBe(1);
    expect(firstClickDir('VMAF')).toBe(-1);
    expect(firstClickDir('sizeRatio')).toBe(-1);
    expect(firstClickDir('PSNR')).toBe(-1);
  });
});
