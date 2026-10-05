// 视频结果表的纯函数守护（T14）：列序偏好 / 排序取值 / 耗时格式化。
// 交互与渲染不在此测（GUI 以截图为证，与 T06/T08 约定一致）。

import { describe, expect, it } from 'vitest';
import { firstClickDir, formatElapsed, videoMetricKeys, videoSortableValue } from './video';
import type { VideoCandidate } from './video';

function row(overrides: Partial<VideoCandidate>): VideoCandidate {
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
    // 核心库 BTreeMap 序列化顺序是字典序 PSNR/SSIM/VMAF，展示层负责重排
    const rows = [row({ metrics: { PSNR: 41.8, SSIM: 0.99, VMAF: 94.9 } })];
    expect(videoMetricKeys(rows)).toEqual(['VMAF', 'PSNR', 'SSIM']);
  });

  it('未知指标按首现顺序跟在偏好列后面（数据驱动，后续加指标自动多列）', () => {
    const rows = [
      row({ metrics: { VMAF: 90, XPSNR: 40 } }),
      row({ metrics: { XPSNR: 41, VMAF: 91, SSIM: 0.98 } }),
    ];
    // 偏好列 VMAF/SSIM 整体在前，XPSNR 按首现顺序殿后
    expect(videoMetricKeys(rows)).toEqual(['VMAF', 'SSIM', 'XPSNR']);
  });

  it('没有任何已跑分行时返回空数组', () => {
    expect(videoMetricKeys([row({ metrics: null }), row({ metrics: null })])).toEqual([]);
  });
});

describe('videoSortableValue', () => {
  it('inf 哨兵还原为无穷大（参与排序）', () => {
    const candidate = row({ metrics: { PSNR: 'inf' } });
    expect(videoSortableValue(candidate, 'PSNR')).toBe(Number.POSITIVE_INFINITY);
  });

  it('缺指标 / 缺耗时返回 null（排序沉底）', () => {
    expect(videoSortableValue(row({ metrics: null }), 'VMAF')).toBeNull();
    expect(videoSortableValue(row({ elapsedMs: null }), 'elapsedMs')).toBeNull();
  });

  it('耗时与文件大小取原始数值', () => {
    expect(videoSortableValue(row({ elapsedMs: 1234 }), 'elapsedMs')).toBe(1234);
    expect(videoSortableValue(row({ fileSize: 100 }), 'fileSize')).toBe(100);
  });

  it('名称取文件名部分', () => {
    expect(videoSortableValue(row({ path: '/a/b/dis.mp4' }), 'name')).toBe('dis.mp4');
  });
});

describe('firstClickDir', () => {
  it('文件大小/耗时首点升序（越小越好），指标与体积比首点降序', () => {
    expect(firstClickDir('fileSize')).toBe(1);
    expect(firstClickDir('elapsedMs')).toBe(1);
    expect(firstClickDir('name')).toBe(1);
    expect(firstClickDir('VMAF')).toBe(-1);
    expect(firstClickDir('sizeRatio')).toBe(-1);
  });
});

describe('formatElapsed', () => {
  it('不足一秒显毫秒，超过一秒显秒（一位小数）', () => {
    expect(formatElapsed(812)).toBe('812 ms');
    expect(formatElapsed(3200)).toBe('3.2 s');
  });
});
