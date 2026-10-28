// 选图逻辑单测：单槽模式的「轮×模式」隔离 + 分屏/网格共用的显式选择语义 + 胶片条落点。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。

import { describe, it, expect } from 'vitest';
import {
  applyPick,
  defaultPaneImage,
  pickSlot,
  resolveCandidatePath,
  resolveModeCandidatePath,
  resolvePaneImage,
} from './selection';

const round = {
  referencePath: '/demo/ref.png',
  candidates: [{ path: '/demo/a.jpg' }, { path: '/demo/b.webp' }, { path: '/demo/c.avif' }],
};

describe('resolveCandidatePath（单槽槽位解析）', () => {
  it('换跑分图后槽位立即解析为刚选的图（回归：画布曾持续画挂载时的旧图）', () => {
    expect(resolveCandidatePath('/demo/c.avif', round)).toBe('/demo/c.avif');
    expect(resolveCandidatePath('/demo/a.jpg', round)).toBe('/demo/a.jpg');
  });

  it('显式选择仍在本轮时原样保留（跑分刷新后不丢选择）', () => {
    expect(resolveCandidatePath('/demo/b.webp', round)).toBe('/demo/b.webp');
  });

  it('显式选择的图已不在本轮（被删除）时回落第一张', () => {
    expect(resolveCandidatePath('/demo/removed.jpg', round)).toBe('/demo/a.jpg');
  });

  it('跑分图删光时槽位为 null', () => {
    expect(resolveCandidatePath('/demo/a.jpg', { candidates: [] })).toBeNull();
  });
});

describe('resolveModeCandidatePath（按「轮×模式」隔离）', () => {
  it('滑动模式的手动选择不泄漏到叠加模式', () => {
    const choices = { slider: '/demo/c.avif' };
    expect(resolveModeCandidatePath(choices, 'slider', round)).toBe('/demo/c.avif');
    expect(resolveModeCandidatePath(choices, 'overlay', round)).toBe('/demo/a.jpg');
  });

  it('各模式保留各自的选择，来回切换模式不互相覆盖', () => {
    const choices = { slider: '/demo/b.webp', diff: '/demo/c.avif' };
    expect(resolveModeCandidatePath(choices, 'slider', round)).toBe('/demo/b.webp');
    expect(resolveModeCandidatePath(choices, 'diff', round)).toBe('/demo/c.avif');
    expect(resolveModeCandidatePath(choices, 'blink', round)).toBe('/demo/a.jpg');
  });

  it('某模式选中的图被删除后回落第一张，其他模式的选择不受牵连', () => {
    const choices = { slider: '/demo/removed.jpg', overlay: '/demo/b.webp' };
    expect(resolveModeCandidatePath(choices, 'slider', round)).toBe('/demo/a.jpg');
    expect(resolveModeCandidatePath(choices, 'overlay', round)).toBe('/demo/b.webp');
  });

  it('未选过任何图（空键控）时所有模式都跟随候选顺序', () => {
    expect(resolveModeCandidatePath({}, 'slider', round)).toBe('/demo/a.jpg');
    expect(resolveModeCandidatePath({}, 'blink', round)).toBe('/demo/a.jpg');
  });
});

describe('defaultPaneImage / resolvePaneImage（分屏栏与网格格共用）', () => {
  it('默认布局：第 0 位原图，第 i 位第 i 张跑分图；越界为 null', () => {
    expect(defaultPaneImage(0, round)).toBe('/demo/ref.png');
    expect(defaultPaneImage(1, round)).toBe('/demo/a.jpg');
    expect(defaultPaneImage(3, round)).toBe('/demo/c.avif');
    expect(defaultPaneImage(4, round)).toBeNull();
  });

  it('无显式选择（null/undefined/空数组）时全部走默认布局', () => {
    expect(resolvePaneImage(null, 0, round)).toBe('/demo/ref.png');
    expect(resolvePaneImage(undefined, 1, round)).toBe('/demo/a.jpg');
    expect(resolvePaneImage([], 2, round)).toBe('/demo/b.webp');
    expect(resolvePaneImage([], 3, round)).toBe('/demo/c.avif');
    expect(resolvePaneImage([], 4, round)).toBeNull();
  });

  it('显式选择仍在本轮（原图或任一张跑分图）时原样生效', () => {
    expect(resolvePaneImage(['/demo/b.webp'], 0, round)).toBe('/demo/b.webp');
    expect(resolvePaneImage([null, '/demo/ref.png'], 1, round)).toBe('/demo/ref.png');
  });

  it('显式选择的图已被移出本轮时回落该位默认，不显示失效图', () => {
    expect(resolvePaneImage(['/demo/removed.jpg', '/demo/a.jpg'], 0, round)).toBe('/demo/ref.png');
    expect(resolvePaneImage([null, '/demo/removed.jpg'], 1, round)).toBe('/demo/a.jpg');
  });

  it('显式留空（空字符串）返回 null；分屏不提供该选项，但语义由同一函数承载', () => {
    expect(resolvePaneImage(['', null], 0, round)).toBeNull();
  });

  it('数组缺省位（undefined）走默认布局，显式位不受影响', () => {
    const paths = [undefined, '/demo/b.webp'] as (string | null | undefined)[];
    expect(resolvePaneImage(paths, 0, round)).toBe('/demo/ref.png');
    expect(resolvePaneImage(paths, 1, round)).toBe('/demo/b.webp');
    // 缺省位按「第 i 位 = 第 i 张跑分图」：第 2 位是 b.webp（candidates[1]）
    expect(resolvePaneImage(paths, 2, round)).toBe('/demo/b.webp');
    expect(resolvePaneImage(paths, 3, round)).toBe('/demo/c.avif');
    expect(resolvePaneImage(paths, 4, round)).toBeNull();
  });
});

describe('pickSlot（胶片条点击落到哪个槽位）', () => {
  it('单槽四模式写模式自己的隔离槽', () => {
    for (const mode of ['slider', 'overlay', 'diff', 'blink'] as const) {
      expect(pickSlot(mode, null, { panes: 4, cells: 4 })).toEqual({ kind: 'mode' });
    }
  });

  it('分屏写当前聚焦栏；无聚焦时写第 1 栏（第 0 栏默认是原图）', () => {
    expect(pickSlot('split', 2, { panes: 4, cells: 4 })).toEqual({ kind: 'pane', index: 2 });
    expect(pickSlot('split', null, { panes: 4, cells: 4 })).toEqual({ kind: 'pane', index: 1 });
  });

  it('网格写当前聚焦格；无聚焦时写第 1 格', () => {
    expect(pickSlot('grid', 3, { panes: 4, cells: 4 })).toEqual({ kind: 'cell', index: 3 });
    expect(pickSlot('grid', null, { panes: 4, cells: 4 })).toEqual({ kind: 'cell', index: 1 });
  });

  it('聚焦索引越界（删图后）会被钳回合法范围，不写不存在的栏/格', () => {
    expect(pickSlot('split', 9, { panes: 3, cells: 4 })).toEqual({ kind: 'pane', index: 2 });
    expect(pickSlot('grid', 9, { panes: 4, cells: 2 })).toEqual({ kind: 'cell', index: 1 });
    expect(pickSlot('split', -3, { panes: 2, cells: 2 })).toEqual({ kind: 'pane', index: 0 });
  });
});

describe('applyPick（把一次选图写成状态切片，不就地改入参）', () => {
  const base = {
    candidateChoices: { slider: '/demo/a.jpg' },
    panePaths: [null, '/demo/a.jpg'],
    cellPaths: [null, '', '/demo/c.avif'],
    paneCount: 3,
    cellCount: 4,
  };

  it('模式槽：只改该模式，其余键与其它字段保持原样', () => {
    const patch = applyPick(base, { kind: 'mode' }, 'overlay', '/demo/b.webp');
    expect(patch.candidateChoices).toEqual({ slider: '/demo/a.jpg', overlay: '/demo/b.webp' });
    expect(patch.panePaths).toBeUndefined();
    expect(patch.cellPaths).toBeUndefined();
  });

  it('栏槽：数组补到当前栏数，显式位覆盖，其余缺省位保持 null', () => {
    const patch = applyPick(base, { kind: 'pane', index: 2 }, null, '/demo/c.avif');
    expect(patch.panePaths).toEqual([null, '/demo/a.jpg', '/demo/c.avif']);
  });

  it('格槽：保留显式留空的空串，只改目标格', () => {
    const patch = applyPick(base, { kind: 'cell', index: 0 }, null, '/demo/ref.png');
    expect(patch.cellPaths).toEqual(['/demo/ref.png', '', '/demo/c.avif', null]);
  });

  it('格槽写入空串表示显式留空', () => {
    const patch = applyPick(base, { kind: 'cell', index: 2 }, null, '');
    expect(patch.cellPaths).toEqual([null, '', '', null]);
  });

  it('模式槽但当前不是单槽模式时返回空补丁（不误写状态）', () => {
    expect(applyPick(base, { kind: 'mode' }, null, '/demo/a.jpg')).toEqual({});
  });
});
