// 选图逻辑单测：单槽模式的「轮×模式」隔离 + 分屏/网格共用的显式选择语义。
// 期望值来自票面验收标准与手工推演的字面量，不复用实现（防恒真断言）。

import { describe, it, expect } from 'vitest';
import {
  applyPick,
  defaultLayout,
  defaultPaneImage,
  reconcileExplicitPaths,
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


// 真窗回归：分屏 7 栏时第 2、3 栏曾都显示同一张（候选 q55/q78），根因是候选增删后
// 旧的显式选择叠在位移后的默认布局上。这里把「默认逐位映射」与「失效对账」都钉住。
const six = {
  referencePath: '/shots/landscape.png',
  candidates: [
    { path: '/out/landscape_q55.jpg' },
    { path: '/out/landscape_q78.jpg' },
    { path: '/out/landscape_q92.jpg' },
    { path: '/out/landscape_q70.jpg' },
    { path: '/out/landscape_q90.jpg' },
    { path: '/out/landscape_broken.jpg' },
  ],
};

describe('分屏默认顺序（真窗回归：每栏 = 原图 + 第 i 张候选）', () => {
  it('无显式选择时 resolvePaneImage(0..6) 依次是原图与候选 1..6', () => {
    const slots = Array.from({ length: 7 }, (_, index) => resolvePaneImage([], index, six));
    expect(slots).toEqual([
      '/shots/landscape.png',
      '/out/landscape_q55.jpg',
      '/out/landscape_q78.jpg',
      '/out/landscape_q92.jpg',
      '/out/landscape_q70.jpg',
      '/out/landscape_q90.jpg',
      '/out/landscape_broken.jpg',
    ]);
  });

  it('defaultLayout 与逐位解析完全一致（分屏栏数 = 候选数 + 1）', () => {
    expect(defaultLayout(six, 7)).toEqual(
      Array.from({ length: 7 }, (_, index) => resolvePaneImage(null, index, six)),
    );
  });

  it('重建 surface（同样的状态再解析一遍）标签与路径不变、且第 2/3 栏不同图', () => {
    const state = { panePaths: [] as (string | null)[] };
    const first = Array.from({ length: 7 }, (_, i) => resolvePaneImage(state.panePaths, i, six));
    const afterRebuild = Array.from({ length: 7 }, (_, i) =>
      resolvePaneImage(state.panePaths, i, six),
    );
    expect(afterRebuild).toEqual(first);
    expect(afterRebuild[1]).toBe('/out/landscape_q55.jpg');
    expect(afterRebuild[2]).toBe('/out/landscape_q78.jpg');
    expect(new Set(afterRebuild).size).toBe(7);
  });

  it('网格（7 张图 → 3×3）同样按位映射，多出的两格为 null', () => {
    const cells = defaultLayout(six, 9);
    expect(cells.slice(0, 7)).toEqual([
      '/shots/landscape.png',
      '/out/landscape_q55.jpg',
      '/out/landscape_q78.jpg',
      '/out/landscape_q92.jpg',
      '/out/landscape_q70.jpg',
      '/out/landscape_q90.jpg',
      '/out/landscape_broken.jpg',
    ]);
    expect(cells.slice(7)).toEqual([null, null]);
  });
});

describe('reconcileExplicitPaths（候选增删后显式选择失效）', () => {
  const ref = '/shots/landscape.png';

  it('默认布局没变：显式选择原样保留', () => {
    const defaults = [ref, '/out/a.jpg', '/out/b.jpg'];
    expect(reconcileExplicitPaths([null, '/out/x.jpg', '/out/y.jpg'], defaults, defaults)).toEqual([
      null,
      '/out/x.jpg',
      '/out/y.jpg',
    ]);
  });

  it('默认布局在该位变了（前面插入候选）：该位显式选择回默认，其它位不受影响', () => {
    const previous = [ref, '/out/q78.jpg'];
    const next = [ref, '/out/q55.jpg'];
    expect(reconcileExplicitPaths([null, '/out/q78.jpg'], previous, next)).toEqual([null, null]);
    // 第三位默认没变，显式选择保住
    expect(
      reconcileExplicitPaths(
        [null, '/out/q78.jpg', '/out/q92.jpg'],
        [ref, '/out/q78.jpg', '/out/q92.jpg'],
        [ref, '/out/q55.jpg', '/out/q92.jpg'],
      ),
    ).toEqual([null, null, '/out/q92.jpg']);
  });

  it('真窗场景：先只有 q78 时手动选过第 1 栏，之后加入 q55 → 不再出现「第 2、3 栏都是 q78」', () => {
    // 上一轮只有一张候选
    const previousRound = { referencePath: ref, candidates: [{ path: '/out/q78.jpg' }] };
    const nextRound = {
      referencePath: ref,
      candidates: [{ path: '/out/q55.jpg' }, { path: '/out/q78.jpg' }],
    };
    const previousDefaults = defaultLayout(previousRound, 2); // [ref, q78]
    const nextDefaults = defaultLayout(nextRound, 3); // [ref, q55, q78]
    const panePaths = reconcileExplicitPaths([null, '/out/q78.jpg'], previousDefaults, nextDefaults);
    expect(panePaths).toEqual([null, null]);
    expect(resolvePaneImage(panePaths, 1, nextRound)).toBe('/out/q55.jpg');
    expect(resolvePaneImage(panePaths, 2, nextRound)).toBe('/out/q78.jpg');
  });

  it('长度变化：旧显式位在新默认布局下越界/换图时清空，不把旧值带到新位置', () => {
    const previous = [ref, '/out/a.jpg'];
    const next = [ref, '/out/b.jpg', '/out/c.jpg'];
    expect(reconcileExplicitPaths([null, '/out/a.jpg'], previous, next)).toEqual([null, null]);
  });
});
