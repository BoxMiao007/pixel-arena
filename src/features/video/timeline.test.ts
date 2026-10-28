// 逐帧对比时间/帧换算的纯逻辑守卫（新架构）：源列表、时间钳制、帧步进、
// 时长交集、时间戳与帧率读数。交互与渲染不在单测范围（桌面截图验收）。

import { describe, expect, it } from 'vitest';
import {
  clampTime,
  estimateFrameTotal,
  formatFps,
  formatTimestamp,
  frameIndexAt,
  frameLengthMs,
  minDuration,
  nextFrameTime,
  prevFrameTime,
  stepFrames,
  usableFps,
} from './timeline';

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

  it('帧率不可用（0 / NaN / null）时返回钳制后的原时间', () => {
    expect(nextFrameTime(0.5, 0, 3)).toBe(0.5);
    expect(prevFrameTime(0.5, Number.NaN, 3)).toBe(0.5);
  });
});

describe('stepFrames', () => {
  const FPS = 30;
  const DURATION = 3;

  it('±1 帧与 prev/nextFrameTime 完全一致', () => {
    for (const t of [0, 0.5, 15 / 30, 2.99]) {
      expect(stepFrames(t, FPS, DURATION, 1)).toBe(nextFrameTime(t, FPS, DURATION));
      expect(stepFrames(t, FPS, DURATION, -1)).toBe(prevFrameTime(t, FPS, DURATION));
    }
  });

  it('±10 帧按帧序号平移并钳制', () => {
    expect(stepFrames(0.5, FPS, DURATION, 10)).toBeCloseTo(25 / 30, 12);
    expect(stepFrames(0.5, FPS, DURATION, -10)).toBeCloseTo(5 / 30, 12);
    // 0.5s 是第 15 帧：退 10 帧到第 5 帧；再退 10 帧到 0
    expect(stepFrames(5 / 30, FPS, DURATION, -10)).toBe(0);
  });

  it('零步进与未知帧率只做钳制', () => {
    expect(stepFrames(1, FPS, DURATION, 0)).toBe(1);
    expect(stepFrames(9, 0, DURATION, 5)).toBe(3);
  });
});

describe('minDuration', () => {
  it('取各路时长最小值；忽略未就绪的 0；全未知为 0', () => {
    expect(minDuration([3, 2, 5])).toBe(2);
    expect(minDuration([0, 2, 3])).toBe(2);
    expect(minDuration([0, 0])).toBe(0);
    expect(minDuration([])).toBe(0);
    expect(minDuration([Number.NaN, Number.POSITIVE_INFINITY])).toBe(0);
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

describe('usableFps / 读数格式化', () => {
  it('只有有限正数才算已知帧率', () => {
    expect(usableFps(30)).toBe(30);
    expect(usableFps(29.97)).toBe(29.97);
    expect(usableFps(0)).toBeNull();
    expect(usableFps(null)).toBeNull();
    expect(usableFps(Number.NaN)).toBeNull();
    expect(usableFps(undefined)).toBeNull();
  });

  it('帧长与帧率读数', () => {
    expect(frameLengthMs(30)).toBeCloseTo(33.333, 3);
    expect(formatFps(30)).toBe('30');
    expect(formatFps(29.97)).toBe('29.970');
  });

  it('总帧数按四舍五入估算，未知帧率/时长返回 0', () => {
    expect(estimateFrameTotal(3, 30)).toBe(90);
    expect(estimateFrameTotal(3, null)).toBe(0);
    expect(estimateFrameTotal(0, 30)).toBe(0);
  });
});
