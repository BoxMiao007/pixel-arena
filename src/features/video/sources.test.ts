// 视频源与网格排布的纯逻辑守卫（新架构）：源列表、默认两路、分屏栏位、
// 网格行列、每格显式选路与失效回落。

import { describe, expect, it } from 'vitest';
import {
  defaultCellVideo,
  defaultPair,
  gridCellCount,
  gridLayout,
  gridZoomLabel,
  resolveCellVideo,
  splitPanes,
  videoSources,
} from './sources';

describe('videoSources', () => {
  it('原视频排最前，跑分视频按加入顺序跟后', () => {
    expect(videoSources('/ref.mp4', ['/a.mp4', '/b.mp4'])).toEqual([
      '/ref.mp4',
      '/a.mp4',
      '/b.mp4',
    ]);
  });

  it('没有原视频时只含跑分视频', () => {
    expect(videoSources(null, ['/a.mp4'])).toEqual(['/a.mp4']);
  });
});

describe('defaultPair', () => {
  it('默认左=原视频，右=第一段跑分视频', () => {
    expect(defaultPair(['/ref.mp4', '/a.mp4', '/b.mp4'])).toEqual({
      left: '/ref.mp4',
      right: '/a.mp4',
    });
  });

  it('不足两段视频时没有默认组合', () => {
    expect(defaultPair(['/ref.mp4'])).toBeNull();
    expect(defaultPair([])).toBeNull();
  });
});

describe('splitPanes', () => {
  it('原视频固定最左，其余源各一栏', () => {
    expect(splitPanes('/ref.mp4', ['/ref.mp4', '/a.mp4', '/b.mp4'])).toEqual([
      '/ref.mp4',
      '/a.mp4',
      '/b.mp4',
    ]);
  });

  it('没有原视频时第一源当基准，且不重复', () => {
    expect(splitPanes(null, ['/a.mp4', '/b.mp4'])).toEqual(['/a.mp4', '/b.mp4']);
    expect(splitPanes('/a.mp4', ['/a.mp4', '/b.mp4'])).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('空源返回空数组', () => {
    expect(splitPanes(null, [])).toEqual([]);
  });
});

describe('gridLayout / gridCellCount', () => {
  it('按源总数映射行列', () => {
    expect(gridLayout(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridLayout(2)).toEqual({ rows: 1, cols: 2 });
    expect(gridLayout(3)).toEqual({ rows: 2, cols: 2 });
    expect(gridLayout(4)).toEqual({ rows: 2, cols: 2 });
    expect(gridLayout(5)).toEqual({ rows: 2, cols: 3 });
    expect(gridLayout(6)).toEqual({ rows: 2, cols: 3 });
    expect(gridLayout(7)).toEqual({ rows: 3, cols: 3 });
    expect(gridLayout(9)).toEqual({ rows: 3, cols: 3 });
    expect(gridLayout(10)).toEqual({ rows: 4, cols: 3 });
  });

  it('0/负数按 1 格处理；格子数 = 行×列（含留空格）', () => {
    expect(gridLayout(0)).toEqual({ rows: 1, cols: 1 });
    expect(gridCellCount(3)).toBe(4);
    expect(gridCellCount(5)).toBe(6);
  });

  it('放大按钮文案', () => {
    expect(gridZoomLabel(false)).toBe('放大');
    expect(gridZoomLabel(true)).toBe('还原');
  });
});

describe('resolveCellVideo', () => {
  const sources = ['/ref.mp4', '/a.mp4', '/b.mp4'];

  it('默认布局：第 0 格基准，其余按源顺序填入', () => {
    expect(defaultCellVideo(0, '/ref.mp4', sources)).toBe('/ref.mp4');
    expect(defaultCellVideo(1, '/ref.mp4', sources)).toBe('/a.mp4');
    expect(defaultCellVideo(2, '/ref.mp4', sources)).toBe('/b.mp4');
    expect(defaultCellVideo(3, '/ref.mp4', sources)).toBeNull();
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

  it('没有 cellPaths 时与默认布局一致', () => {
    expect(resolveCellVideo(0, null, '/ref.mp4', sources)).toBe('/ref.mp4');
    expect(resolveCellVideo(1, null, '/ref.mp4', sources)).toBe('/a.mp4');
  });
});
