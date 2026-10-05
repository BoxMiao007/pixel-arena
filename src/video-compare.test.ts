// 视频逐帧对比的时间/帧纯逻辑守护（T15）：源列表与默认两路、时间钳制、帧步进换算、
// 时长取交集、时间戳格式化、多视图格子选路。交互与渲染不在此测（GUI 以截图为证）。

import { describe, expect, it } from 'vitest';
import {
  clampTime,
  defaultPair,
  formatTimestamp,
  frameIndexAt,
  minDuration,
  nextFrameTime,
  prevFrameTime,
  resolveCellVideo,
  videoSources,
} from './video-compare';

describe('videoSources', () => {
  it('原视频排最前，跑分视频按加入顺序跟后', () => {
    expect(videoSources('/ref.mp4', ['/a.mp4', '/b.mp4'])).toEqual(['/ref.mp4', '/a.mp4', '/b.mp4']);
  });

  it('没有原视频时只含跑分视频', () => {
    expect(videoSources(null, ['/a.mp4'])).toEqual(['/a.mp4']);
  });
});

describe('defaultPair', () => {
  it('默认左=原视频（列表第一项），右=第一段跑分视频（第二项）', () => {
    expect(defaultPair(['/ref.mp4', '/a.mp4', '/b.mp4'])).toEqual({
      left: '/ref.mp4',
      right: '/a.mp4',
    });
  });

  it('不足两段视频时没有默认组合（入口不可用）', () => {
    expect(defaultPair(['/ref.mp4'])).toBeNull();
    expect(defaultPair([])).toBeNull();
  });
});

describe('clampTime', () => {
  it('钳制到 [0, duration]', () => {
    expect(clampTime(-1, 3)).toBe(0);
    expect(clampTime(4, 3)).toBe(3);
    expect(clampTime(1.5, 3)).toBe(1.5);
  });

  it('时长未知（0）时钳到 0；非法时间归 0', () => {
    expect(clampTime(1, 0)).toBe(0);
    expect(clampTime(Number.NaN, 3)).toBe(0);
  });
});

describe('frameIndexAt / nextFrameTime / prevFrameTime', () => {
  const FPS = 30;

  it('帧序号 = floor(t*fps)，带浮点容差', () => {
    expect(frameIndexAt(0.5, FPS)).toBe(15);
    // 0.4999999*30 = 14.999997，浮点容差后仍应归入第 14 帧
    expect(frameIndexAt(0.4999999, FPS)).toBe(14);
    expect(frameIndexAt(0, FPS)).toBe(0);
  });

  it('+1 帧：从帧中或帧界都前进到下一个帧边界', () => {
    expect(nextFrameTime(0.5, FPS, 3)).toBeCloseTo(16 / 30, 12);
    expect(nextFrameTime(15 / 30, FPS, 3)).toBeCloseTo(16 / 30, 12);
  });

  it('-1 帧：恰在帧界时退到上一帧，帧中时落到本帧开头', () => {
    expect(prevFrameTime(15 / 30, FPS, 3)).toBeCloseTo(14 / 30, 12);
    expect(prevFrameTime(0.505, FPS, 3)).toBeCloseTo(15 / 30, 12);
  });

  it('步进结果钳制在 [0, duration]，0 的 -1 帧停在 0', () => {
    expect(nextFrameTime(2.99, FPS, 3)).toBeCloseTo(3, 12);
    expect(prevFrameTime(0, FPS, 3)).toBe(0);
    expect(prevFrameTime(0.001, FPS, 3)).toBe(0);
  });
});

describe('minDuration', () => {
  it('取各路时长最小值（时间轴以最短的一路为准）', () => {
    expect(minDuration([3, 2, 5])).toBe(2);
  });

  it('忽略未就绪的 0 时长；全未知时为 0（时间轴禁用）', () => {
    expect(minDuration([0, 2, 3])).toBe(2);
    expect(minDuration([0, 0])).toBe(0);
    expect(minDuration([])).toBe(0);
  });
});

describe('formatTimestamp', () => {
  it('格式为 分:秒.毫秒（毫秒三位）', () => {
    expect(formatTimestamp(0)).toBe('0:00.000');
    expect(formatTimestamp(3.5)).toBe('0:03.500');
    expect(formatTimestamp(65.1234)).toBe('1:05.123');
  });

  it('毫秒进位到整秒/整分', () => {
    expect(formatTimestamp(59.9999)).toBe('1:00.000');
  });
});

describe('resolveCellVideo', () => {
  const sources = ['/ref.mp4', '/a.mp4', '/b.mp4'];

  it('默认布局：第 0 格基准（左路），其余按源顺序填入', () => {
    expect(resolveCellVideo(0, null, '/ref.mp4', sources)).toBe('/ref.mp4');
    expect(resolveCellVideo(1, null, '/ref.mp4', sources)).toBe('/a.mp4');
    expect(resolveCellVideo(2, null, '/ref.mp4', sources)).toBe('/b.mp4');
    expect(resolveCellVideo(3, null, '/ref.mp4', sources)).toBeNull();
  });

  it('显式选路生效；空串表示显式留空', () => {
    expect(resolveCellVideo(2, [null, null, '/b.mp4'], '/ref.mp4', sources)).toBe('/b.mp4');
    expect(resolveCellVideo(2, [null, null, ''], '/ref.mp4', sources)).toBeNull();
  });

  it('显式路径已失效（视频被移除）时回落默认布局', () => {
    expect(resolveCellVideo(1, ['/gone.mp4'], '/ref.mp4', sources)).toBe('/a.mp4');
  });

  it('显式选择基准路本身也有效（同一视频可占多格）', () => {
    expect(resolveCellVideo(2, [null, null, '/ref.mp4'], '/ref.mp4', sources)).toBe('/ref.mp4');
  });
});
