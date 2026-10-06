// 视口状态模块的单测：只测公共 API 的外部行为（纯几何，无 DOM）。
// 期望值来自独立演算的字面量，不复用实现里的公式（防恒真断言）。

import { describe, it, expect } from 'vitest';
import {
  fitViewport,
  imageToScreen,
  screenToImage,
  zoomAt,
  panBy,
  visibleRegion,
  MAX_ZOOM,
  MIN_ZOOM,
} from './viewport';

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

  it('放大后只画窗格覆盖的部分：目标区域铺满窗格，源区域按 zoom 反算', () => {
    const vp = { centerX: 1000, centerY: 750, zoom: 4 };
    const r = visibleRegion(vp, pane, { width: 2000, height: 1500 })!;
    expect(r.dst).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(r.src.width).toBeCloseTo(100); // 400 / 4
    expect(r.src.height).toBeCloseTo(75); // 300 / 4
    expect(r.src.x).toBeCloseTo(950); // 1000 - 400/2/4
    expect(r.src.y).toBeCloseTo(712.5); // 750 - 300/2/4
  });

  it('视口完全移出图片：返回 null，调用方无需绘制', () => {
    const vp = { centerX: 5000, centerY: 0, zoom: 1 };
    expect(visibleRegion(vp, pane, { width: 2000, height: 1500 })).toBeNull();
  });
});
