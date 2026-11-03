// 视口几何单测：只测公共 API 的外部行为（纯几何，无 DOM）。
// 期望值来自独立演算的字面量，不复用实现里的公式（防恒真断言）。
// 迁移自 src/viewport.test.ts，并补上共享画布层新增的契约：
// - 源矩形向外取整到整像素（异尺寸窗格并排不出现半像素错位）；
// - 100% 附近用 epsilon 判等（滚轮连乘不会把「像素级」判丢）；
// - 多窗格逐窗归一：共享视口按锚图绝对口径存储，各图按自己的适配倍数显示
//   （相对Viewport 与其逆运算，分屏 / 网格 / 单画布 / 视频逐帧共用）。

import { describe, it, expect } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  absoluteViewportFromRelative,
  clampZoom,
  fitViewport,
  imageToScreen,
  isPixelZoom,
  panBy,
  relativeViewport,
  screenToImage,
  visibleRegion,
  withZoom,
  zoomAt,
} from '../../ui/canvas';

describe('fitViewport（窗格尺寸适配）', () => {
  it('宽图：以宽度为约束完整居中显示，中心落在窗格中心', () => {
    const vp = fitViewport({ width: 2000, height: 1000 }, { width: 400, height: 500 });
    expect(vp.zoom).toBeCloseTo(0.2); // 400 / 2000
    const center = imageToScreen(vp, { width: 400, height: 500 }, 1000, 500);
    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(250);
  });

  it('竖长图：以高度为约束', () => {
    const vp = fitViewport({ width: 1000, height: 3000 }, { width: 400, height: 600 });
    expect(vp.zoom).toBeCloseTo(0.2); // 600 / 3000
  });

  it('小图也会放大到铺满窗格较短的一边', () => {
    const vp = fitViewport({ width: 100, height: 100 }, { width: 400, height: 200 });
    expect(vp.zoom).toBeCloseTo(2);
  });

  it('图片尺寸异常（0 尺寸）时返回安全的默认视口，不产生非有限值', () => {
    const vp = fitViewport({ width: 0, height: 0 }, { width: 400, height: 300 });
    expect(Number.isFinite(vp.zoom)).toBe(true);
    expect(Number.isFinite(vp.centerX)).toBe(true);
    expect(Number.isFinite(vp.centerY)).toBe(true);
  });
});

describe('坐标换算（图片 ↔ 屏幕）', () => {
  const pane = { width: 800, height: 600 };

  it('视口中心映射到窗格中心，且往返换算还原', () => {
    const vp = { centerX: 640, centerY: 480, zoom: 0.5 };
    const center = imageToScreen(vp, pane, 640, 480);
    expect(center.x).toBeCloseTo(400);
    expect(center.y).toBeCloseTo(300);
    const back = screenToImage(vp, pane, center.x, center.y);
    expect(back.x).toBeCloseTo(640);
    expect(back.y).toBeCloseTo(480);
  });

  it('已知字面量：zoom=2 时原图 (0,0) 落在 (200,100)', () => {
    // 手工演算：x = 800/2 + (0-100)×2 = 200；y = 600/2 + (0-100)×2 = 100
    const vp = { centerX: 100, centerY: 100, zoom: 2 };
    const p = imageToScreen(vp, pane, 0, 0);
    expect(p.x).toBeCloseTo(200);
    expect(p.y).toBeCloseTo(100);
    const back = screenToImage(vp, pane, p.x, p.y);
    expect(back.x).toBeCloseTo(0);
    expect(back.y).toBeCloseTo(0);
  });
});

describe('zoomAt（光标处缩放）', () => {
  const pane = { width: 800, height: 600 };

  it('光标下的图片点在缩放前后保持在同一屏幕位置（指哪放哪）', () => {
    const vp0 = { centerX: 300, centerY: 200, zoom: 1 };
    const cursor = { x: 650, y: 120 };
    const anchorBefore = screenToImage(vp0, pane, cursor.x, cursor.y);
    const vp1 = zoomAt(vp0, 2, cursor.x, cursor.y, pane);
    const anchorAfter = screenToImage(vp1, pane, cursor.x, cursor.y);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y);
    expect(vp1.zoom).toBeCloseTo(2);
  });

  it('以窗格中心为锚缩放时视口中心不动', () => {
    const vp1 = zoomAt({ centerX: 320, centerY: 150, zoom: 1 }, 3, 400, 300, pane);
    expect(vp1.centerX).toBeCloseTo(320);
    expect(vp1.centerY).toBeCloseTo(150);
  });

  it('缩放不超过上限 MAX_ZOOM，也不低于下限 MIN_ZOOM', () => {
    expect(zoomAt({ centerX: 0, centerY: 0, zoom: 60 }, 10, 400, 300, pane).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ centerX: 0, centerY: 0, zoom: 0.02 }, 0.1, 400, 300, pane).zoom).toBe(MIN_ZOOM);
  });
});

describe('缩放档位与像素级判定', () => {
  it('clampZoom 把越界值夹回 [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
  });

  it('withZoom 只换倍数，中心不动', () => {
    const vp = withZoom({ centerX: 120, centerY: 80, zoom: 2 }, 0.5);
    expect(vp).toEqual({ centerX: 120, centerY: 80, zoom: 0.5 });
  });

  it('100% 用 epsilon 判等：1.0000000001 仍算像素级，0.999 不算', () => {
    expect(isPixelZoom(1)).toBe(true);
    expect(isPixelZoom(1.0000000001)).toBe(true);
    expect(isPixelZoom(0.999)).toBe(false);
    expect(isPixelZoom(4)).toBe(true);
  });
});

describe('panBy（拖拽平移）', () => {
  it('向右拖 100 屏幕像素：视口中心在图片坐标系里左移 100/zoom', () => {
    const vp = panBy({ centerX: 500, centerY: 500, zoom: 2 }, 100, 0);
    expect(vp.centerX).toBeCloseTo(450);
    expect(vp.centerY).toBeCloseTo(500);
  });

  it('平移后屏幕点与图片点对应关系保持一致（内容跟着手走）', () => {
    const vp0 = { centerX: 400, centerY: 300, zoom: 0.5 };
    const pane = { width: 800, height: 600 };
    const vp1 = panBy(vp0, 30, -70);
    const before = imageToScreen(vp0, pane, 100, 100);
    const after = imageToScreen(vp1, pane, 100, 100);
    expect(after.x - before.x).toBeCloseTo(30);
    expect(after.y - before.y).toBeCloseTo(-70);
  });
});

describe('visibleRegion（可见区域换算，供 drawImage 裁剪绘制）', () => {
  const pane = { width: 400, height: 300 };

  it('整图完全可见：返回整张图的源区域与屏幕上的目标区域', () => {
    // 2000x1500 图在 zoom=0.1 下占屏幕 200x150，原点在 (100, 75)
    const vp = { centerX: 1000, centerY: 750, zoom: 0.1 };
    const r = visibleRegion(vp, pane, { width: 2000, height: 1500 });
    expect(r).not.toBeNull();
    expect(r!.dst).toEqual({ x: 100, y: 75, width: 200, height: 150 });
    expect(r!.src).toEqual({ x: 0, y: 0, width: 2000, height: 1500 });
  });

  it('放大后只画窗格覆盖的部分：源区域向外取整到整像素，目标区域按同一变换反算', () => {
    // 手工演算：原点 x = 200 - 1000×4 = -3800，y = 150 - 750×4 = -2850
    // 源左 = (0+3800)/4 = 950；源上 = 2850/4 = 712.5 → 取整 712
    // 源右 = (400+3800)/4 = 1050；源下 = (300+2850)/4 = 787.5 → 取整 788
    // 目标 = 原点 + 源×4：x = -3800+3800 = 0，y = -2850+2848 = -2
    const vp = { centerX: 1000, centerY: 750, zoom: 4 };
    const r = visibleRegion(vp, pane, { width: 2000, height: 1500 })!;
    expect(r.src).toEqual({ x: 950, y: 712, width: 100, height: 76 });
    expect(r.dst.x).toBeCloseTo(0);
    expect(r.dst.y).toBeCloseTo(-2);
    expect(r.dst.width).toBeCloseTo(400);
    expect(r.dst.height).toBeCloseTo(304);
  });

  it('非整数缩放也按整像素取样：源区域宽高不出现小数', () => {
    const vp = { centerX: 333.3, centerY: 222.2, zoom: 1.37 };
    const r = visibleRegion(vp, { width: 300, height: 200 }, { width: 800, height: 600 });
    expect(r).not.toBeNull();
    for (const value of [r!.src.x, r!.src.y, r!.src.width, r!.src.height]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('适应后图像在窗格内严格居中：上下左右留白相等（分屏窄栏也一样）', () => {
    // 分屏 7 栏时每栏约 110px 宽：fit 后图像应垂直/水平居中，不能贴顶
    const pane = { width: 110, height: 210 };
    const image = { width: 4000, height: 3000 };
    const vp = fitViewport(image, pane);
    const r = visibleRegion(vp, pane, image)!;
    expect(r.dst.x).toBeCloseTo((pane.width - r.dst.width) / 2);
    expect(r.dst.y).toBeCloseTo((pane.height - r.dst.height) / 2);
    expect(r.dst.x).toBeGreaterThanOrEqual(0);
    expect(r.dst.y).toBeGreaterThanOrEqual(0);
  });

  it('网格单元格（280×180）里的小图同样居中，不被顶部选图条挤偏', () => {
    const pane = { width: 280, height: 180 };
    const image = { width: 1000, height: 1000 };
    const vp = fitViewport(image, pane);
    const r = visibleRegion(vp, pane, image)!;
    expect(r.dst.width).toBeCloseTo(180);
    expect(r.dst.x).toBeCloseTo((280 - 180) / 2);
    expect(r.dst.y).toBeCloseTo(0);
  });

  it('视口完全移出图片：返回 null，调用方无需绘制', () => {
    const vp = { centerX: 5000, centerY: 0, zoom: 1 };
    expect(visibleRegion(vp, pane, { width: 2000, height: 1500 })).toBeNull();
  });
});

// 多窗格逐窗归一：共享视口以「锚图」绝对口径存储，各图按自己的尺寸适配窗格，
// 共享缩放只作为「相对适应的倍数」。期望值全部用独立演算的字面量。
describe('relativeViewport（共享视口 → 某张图在窗格里的视口）', () => {
  const PANE = { width: 800, height: 600 };
  const ANCHOR = { width: 1600, height: 1200 };
  /** 锚图按 800×600 适配出来的默认共享视口：zoom = 800/1600 = 0.5。 */
  const SHARED_FIT = { centerX: 800, centerY: 600, zoom: 0.5 };

  it('默认（相对 1）时每张图按自己的尺寸填满窗格', () => {
    // 400×300 在 800×600 里适配两倍；中心仍是图片中心。
    expect(relativeViewport(SHARED_FIT, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 2,
    });
  });

  it('共享缩放翻倍时该图倍数同步翻倍，中心不动', () => {
    const shared = { centerX: 800, centerY: 600, zoom: 1 };
    expect(relativeViewport(shared, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 4,
    });
  });

  it('非居中位置按图片内相对位置映射（25% 处仍是 25%）', () => {
    const shared = { centerX: 400, centerY: 300, zoom: 0.5 };
    expect(relativeViewport(shared, ANCHOR, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 100,
      centerY: 75,
      zoom: 2,
    });
  });

  it('小图与大图在同一窗格里的显示尺寸一致（分屏/网格等尺寸的核心验收）', () => {
    const big = relativeViewport(SHARED_FIT, ANCHOR, { width: 400, height: 300 }, PANE);
    const small = relativeViewport(SHARED_FIT, ANCHOR, { width: 200, height: 150 }, PANE);
    // 屏幕尺寸 = 图片像素 × 该图 zoom：两者都是 800×600。
    expect(400 * big.zoom).toBe(800);
    expect(300 * big.zoom).toBe(600);
    expect(200 * small.zoom).toBe(800);
    expect(150 * small.zoom).toBe(600);
  });

  it('长宽比不同时按各自的短边适配，不出现拉伸', () => {
    // 200×400 在 800×600 里受高度限制：600/400 = 1.5。
    expect(relativeViewport(SHARED_FIT, ANCHOR, { width: 200, height: 400 }, PANE)).toEqual({
      centerX: 100,
      centerY: 200,
      zoom: 1.5,
    });
  });

  it('锚图尺寸不同时倍数口径跟着锚图走（同一共享视口不能混用两种锚图）', () => {
    // 锚图换成 3200×2400：在 800×600 里 anchorFit = 0.25（原来 0.5），
    // 400×300 的图 fit = 2，相对倍数 = 2 × 0.5 / 0.25 = 4。
    const wideAnchor = { width: 3200, height: 2400 };
    const shared = { centerX: 1600, centerY: 1200, zoom: 0.5 };
    expect(relativeViewport(shared, wideAnchor, { width: 400, height: 300 }, PANE)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 4,
    });
  });

  it('窗格尺寸不同时按该窗格自身口径换算（自洽优先，同一相对倍数）', () => {
    // 窗格减半为 400×300：锚图 fit = min(0.25, 0.25) = 0.25，
    // 共享视口也按该窗格适配为 (800, 600, 0.25)，400×300 的图 fit = 1 → 相对 1 倍。
    const halfPane = { width: 400, height: 300 };
    const shared = { centerX: 800, centerY: 600, zoom: 0.25 };
    expect(relativeViewport(shared, ANCHOR, { width: 400, height: 300 }, halfPane)).toEqual({
      centerX: 200,
      centerY: 150,
      zoom: 1,
    });
  });

  it('倍数超出上限/下限时钳制到与画布同一口径（不会算出无限大或 0）', () => {
    const huge = { centerX: 800, centerY: 600, zoom: 100 };
    expect(relativeViewport(huge, ANCHOR, { width: 400, height: 300 }, PANE).zoom).toBe(MAX_ZOOM);
    const tiny = { centerX: 800, centerY: 600, zoom: 1e-9 };
    expect(relativeViewport(tiny, ANCHOR, { width: 400, height: 300 }, PANE).zoom).toBe(MIN_ZOOM);
  });

  it('尺寸不可用时退回共享视口（不产生 NaN）', () => {
    expect(relativeViewport(SHARED_FIT, ANCHOR, { width: 0, height: 300 }, PANE)).toEqual(SHARED_FIT);
  });
});

describe('absoluteViewportFromRelative（该图视口 → 共享视口）', () => {
  const PANE = { width: 800, height: 600 };
  const ANCHOR = { width: 1600, height: 1200 };

  it('是 relativeViewport 的逆运算（滚轮/拖拽写回不漂移）', () => {
    const image = { width: 400, height: 300 };
    expect(absoluteViewportFromRelative({ centerX: 125, centerY: 90, zoom: 3 }, ANCHOR, image, PANE)).toEqual({
      // 独立演算：中心回到锚图 (125/400×1600, 90/300×1200) = (500, 360)，
      // 倍数回到共享口径 (3/2×0.5) = 0.75。
      centerX: 500,
      centerY: 360,
      zoom: 0.75,
    });
    const shared = absoluteViewportFromRelative({ centerX: 125, centerY: 90, zoom: 3 }, ANCHOR, image, PANE);
    const back = relativeViewport(shared, ANCHOR, image, PANE);
    expect(back.centerX).toBeCloseTo(125, 6);
    expect(back.centerY).toBeCloseTo(90, 6);
    expect(back.zoom).toBeCloseTo(3, 6);
  });

  it('默认适配位置写回后仍是锚图适配口径', () => {
    const image = { width: 400, height: 300 };
    const fit = { centerX: 800, centerY: 600, zoom: 0.5 };
    const cell = relativeViewport(fit, ANCHOR, image, PANE);
    const shared = absoluteViewportFromRelative(cell, ANCHOR, image, PANE);
    expect(shared.zoom).toBeCloseTo(0.5, 6);
    expect(shared.centerX).toBeCloseTo(800, 6);
    expect(shared.centerY).toBeCloseTo(600, 6);
  });

  it('往返在锚图尺寸不同、窗格尺寸不同时同样成立', () => {
    const anchor = { width: 3200, height: 2400 };
    const image = { width: 500, height: 375 };
    const pane = { width: 300, height: 200 };
    const shared = { centerX: 1234.5, centerY: 987.5, zoom: 0.37 };
    const relative = relativeViewport(shared, anchor, image, pane);
    const back = absoluteViewportFromRelative(relative, anchor, image, pane);
    expect(back.centerX).toBeCloseTo(shared.centerX, 6);
    expect(back.centerY).toBeCloseTo(shared.centerY, 6);
    expect(back.zoom).toBeCloseTo(shared.zoom, 6);
  });

  it('反向写入同样受缩放上下限钳制', () => {
    const image = { width: 400, height: 300 };
    expect(
      absoluteViewportFromRelative({ centerX: 0, centerY: 0, zoom: MAX_ZOOM * 100 }, ANCHOR, image, PANE).zoom,
    ).toBe(MAX_ZOOM);
    // 0.001 / 2 × 0.5 = 0.00025，低于下限，钳到 MIN_ZOOM。
    expect(
      absoluteViewportFromRelative({ centerX: 0, centerY: 0, zoom: 0.001 }, ANCHOR, image, PANE).zoom,
    ).toBe(MIN_ZOOM);
  });

  it('尺寸不可用时原样返回（不产生 NaN）', () => {
    const cell = { centerX: 10, centerY: 20, zoom: 1 };
    expect(absoluteViewportFromRelative(cell, ANCHOR, { width: 400, height: 0 }, PANE)).toEqual(cell);
  });
});
