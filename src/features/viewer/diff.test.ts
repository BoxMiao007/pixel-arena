// 差异图像素运算与缓存键单测：只测纯逻辑（PixelBuffer 输入/输出，无 DOM、无 Canvas）。
// 期望值来自独立手工演算的字面量（亮度公式 L = 0.299R + 0.587G + 0.114B），
// 不复用实现里的表达式，防恒真断言。

import { describe, it, expect } from 'vitest';
import {
  MAX_DIFF_PIXELS,
  computeDiffData,
  diffCacheKey,
  diffExceedsLimit,
  type PixelBuffer,
} from './diff';

/** 按行优先 RGBA 造一张测试图；pixels 缺省为不透明黑 */
function makeBuf(width: number, height: number, pixels: number[][]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => {
    data[i * 4] = p[0]!;
    data[i * 4 + 1] = p[1]!;
    data[i * 4 + 2] = p[2]!;
    data[i * 4 + 3] = p.length > 3 ? p[3]! : 255;
  });
  return { width, height, data };
}

describe('computeDiffData（逐像素差异热图）', () => {
  it('两图完全相同：输出为原图亮度 25% 的灰阶底（保留轮廓、不抢眼）', () => {
    // (100,100,100) 的亮度 L=100 → 100×0.25=25；(20,30,40) 的 L=28.15 → round(7.0375)=7
    const ref = makeBuf(2, 1, [[100, 100, 100], [20, 30, 40]]);
    const out = computeDiffData(ref, makeBuf(2, 1, [[100, 100, 100], [20, 30, 40]]), 24);
    expect([out[0], out[1], out[2]]).toEqual([25, 25, 25]);
    expect([out[4], out[5], out[6]]).toEqual([7, 7, 7]);
  });

  it('亮度差超过阈值：按超出程度从黄渐变到红（低超出偏黄、高超出偏红）', () => {
    // ref (0,0,0) L=0，cand (100,0,0) L=29.9，diff=29.9，threshold=20
    // p=(29.9-20)/(255-20)=9.9/235，G=round(230×(1-p))=round(220.31)=220，R=255，B=0
    const ref = makeBuf(1, 1, [[0, 0, 0]]);
    const cand = makeBuf(1, 1, [[100, 0, 0]]);
    const out = computeDiffData(ref, cand, 20);
    expect([out[0], out[1], out[2]]).toEqual([255, 220, 0]);
  });

  it('亮度差恰好等于阈值：不算超出，仍是灰阶底', () => {
    // ref (100,100,100) L=100，cand (0,0,0) L=0，diff=100；threshold=100 → 不高亮
    const ref = makeBuf(1, 1, [[100, 100, 100]]);
    const out = computeDiffData(ref, makeBuf(1, 1, [[0, 0, 0]]), 100);
    expect([out[0], out[1]]).toEqual([25, 25]);
  });

  it('差到顶（黑白对比）：正好落在纯红端 (255,0,0)', () => {
    const ref = makeBuf(1, 1, [[0, 0, 0]]);
    const out = computeDiffData(ref, makeBuf(1, 1, [[255, 255, 255]]), 24);
    expect([out[0], out[1], out[2]]).toEqual([255, 0, 0]);
  });

  it('阈值为 0：任何非零亮度差都高亮', () => {
    // cand (1,1,1) L=1，diff=1>0；G=round(230×(1-1/255))=round(229.098)=229
    const ref = makeBuf(1, 1, [[0, 0, 0]]);
    const out = computeDiffData(ref, makeBuf(1, 1, [[1, 1, 1]]), 0);
    expect([out[0], out[1], out[2]]).toEqual([255, 229, 0]);
  });

  it('同一张图里超阈值与未超阈值的像素各自正确', () => {
    const ref = makeBuf(2, 1, [[100, 100, 100], [0, 0, 0]]);
    const cand = makeBuf(2, 1, [[100, 100, 100], [255, 255, 255]]);
    const out = computeDiffData(ref, cand, 24);
    expect([out[0], out[1], out[2]]).toEqual([25, 25, 25]);
    expect([out[4], out[5], out[6]]).toEqual([255, 0, 0]);
  });

  it('输出长度与 alpha：始终不透明，长度等于像素数 ×4', () => {
    const ref = makeBuf(3, 2, Array.from({ length: 6 }, () => [10, 10, 10]));
    const out = computeDiffData(ref, makeBuf(3, 2, Array.from({ length: 6 }, () => [10, 10, 10])), 24);
    expect(out).toHaveLength(3 * 2 * 4);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  it('极端阈值 255：不产生 NaN（除零被夹住）', () => {
    const ref = makeBuf(1, 1, [[0, 0, 0]]);
    const out = computeDiffData(ref, makeBuf(1, 1, [[255, 255, 255]]), 255);
    for (const value of out) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('差异图缓存键与尺寸上限', () => {
  it('同两张图同阈值 → 同键；任一变化 → 不同键', () => {
    const base = diffCacheKey('/a.png', '/b.png', 2);
    expect(diffCacheKey('/a.png', '/b.png', 2)).toBe(base);
    expect(diffCacheKey('/a.png', '/b.png', 3)).not.toBe(base);
    expect(diffCacheKey('/a.png', '/c.png', 2)).not.toBe(base);
  });

  it('缺图（null）也能算出稳定键，不会与空字符串路径混淆', () => {
    expect(diffCacheKey(null, '/b.png', 2)).not.toBe(diffCacheKey('', '/b.png', 2));
  });

  it('像素数超过上限才视为过大（边界值本身允许计算）', () => {
    expect(diffExceedsLimit(8000, 5000)).toBe(false); // 正好 4000 万
    expect(diffExceedsLimit(8000, 5001)).toBe(true);
    expect(MAX_DIFF_PIXELS).toBe(40_000_000);
  });
});
