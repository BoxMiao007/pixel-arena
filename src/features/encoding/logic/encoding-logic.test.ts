// encoding 域新增纯逻辑的单测（Phase B）：阶梯分组 / 逐点勾选 / 生成编排、
// 条目删除计划、逐图编辑的换图计划与卡片增删。全部零 DOM、零 IPC。
//
// 旧逻辑的守护测试（entries/run/runtime/advanced/conflict/ladder 各自的 test）迁移在
// 同目录；本文件只钉新增的这几个出口。

import { describe, expect, it, vi } from 'vitest';
import {
  groupLadderByFormat,
  ladderItemKey,
  pickLadderItems,
  runLadder,
  type LadderItem,
} from './ladder';
import { planDelete } from './queue-plan';
import { addEncoderCard, moveCard, planReplaceImage, runReplaceImage } from './editor-plan';
import { newImageEntry, type ImageEntry } from './entries';
import type { ImageSpec } from './advanced';

const ITEMS: LadderItem[] = [
  { format: 'jpeg', quality: 60, label: 'JPEG q60' },
  { format: 'jpeg', quality: 75, label: 'JPEG q75' },
  { format: 'jpeg', quality: 90, label: 'JPEG q90' },
  { format: 'avif', quality: 60, label: 'AVIF q60' },
  { format: 'avif', quality: 75, label: 'AVIF q75' },
  { format: 'png', quality: null, label: 'PNG' },
];

describe('阶梯分组与逐点勾选（预览网格的数据基础）', () => {
  it('groupLadderByFormat：首次出现顺序即行顺序，行内保序，无损行单独标记', () => {
    const rows = groupLadderByFormat(ITEMS);
    expect(rows.map((row) => row.format)).toEqual(['jpeg', 'avif', 'png']);
    expect(rows[0].items.map((item) => item.quality)).toEqual([60, 75, 90]);
    expect(rows[0].lossless).toBe(false);
    expect(rows[2].lossless).toBe(true);
    expect(rows[2].items).toHaveLength(1);
  });

  it('ladderItemKey：有损按质量、无损用稳定后缀（同一格式内唯一）', () => {
    expect(ladderItemKey({ format: 'jpeg', quality: 75, label: 'x' })).toBe('jpeg:75');
    expect(ladderItemKey({ format: 'png', quality: null, label: 'x' })).toBe('png:lossless');
  });

  it('pickLadderItems：按勾选键保序取子集；null 表示不过滤', () => {
    const keys = new Set(['jpeg:75', 'png:lossless']);
    expect(pickLadderItems(ITEMS, keys).map(ladderItemKey)).toEqual(['jpeg:75', 'png:lossless']);
    expect(pickLadderItems(ITEMS, null)).toHaveLength(ITEMS.length);
    expect(pickLadderItems(ITEMS, new Set())).toEqual([]);
  });
});

describe('runLadder：逐项生成 + 失败不回滚 + 冲突协议', () => {
  it('全部成功：按清单顺序编码，成功后一次性交付产物（含格式）', async () => {
    const encoded: string[] = [];
    const added: string[] = [];
    const result = await runLadder({
      ladder: ITEMS.slice(0, 2),
      encode: (item) => {
        encoded.push(item.label);
        return Promise.resolve({ kind: 'done', product: { path: `/out/${item.format}.img`, encodingParams: item.label } });
      },
      addCandidates: (products) => {
        added.push(...products.map((product) => product.path));
        return Promise.resolve();
      },
      onProgress: () => undefined,
      onConflict: () => Promise.reject(new Error('不该问冲突')),
    });
    expect(encoded).toEqual(['JPEG q60', 'JPEG q75']);
    expect(added).toEqual(['/out/jpeg.img', '/out/jpeg.img']);
    expect(result.generated).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.products.map((item) => item.format)).toEqual(['jpeg', 'jpeg']);
  });

  it('单项失败不回滚：继续生成其余项，失败原因带格式标签', async () => {
    const result = await runLadder({
      ladder: ITEMS.slice(0, 3),
      encode: (item) => {
        if (item.quality === 60) return Promise.reject(new Error('编码器不可用'));
        return Promise.resolve({ kind: 'done', product: { path: `/out/q${item.quality}`, encodingParams: 'x' } });
      },
      addCandidates: () => Promise.resolve(),
      onProgress: () => undefined,
      onConflict: () => Promise.reject(new Error('不该问冲突')),
    });
    expect(result.generated).toBe(2);
    expect(result.failures).toEqual(['JPEG q60: Error: 编码器不可用']);
  });

  it('冲突选「跳过」：该项不进轮、记一条失败；选「覆盖」则带 overwrite 重调', async () => {
    const calls: boolean[] = [];
    const conflicts = ['skip', 'overwrite'] as const;
    let asked = 0;
    const result = await runLadder({
      ladder: ITEMS.slice(0, 2),
      encode: (_item, overwrite) => {
        calls.push(overwrite);
        if (!overwrite) return Promise.resolve({ kind: 'conflict', proposedName: '同图.jpg' });
        return Promise.resolve({ kind: 'done', product: { path: '/out/ok.jpg', encodingParams: 'y' } });
      },
      addCandidates: () => Promise.resolve(),
      onProgress: () => undefined,
      onConflict: () => {
        const answer = conflicts[asked] ?? 'skip';
        asked += 1;
        return Promise.resolve(answer);
      },
    });
    expect(calls).toEqual([false, false, true]);
    expect(result.generated).toBe(1);
    expect(result.failures[0]).toContain('已跳过（同图.jpg 已存在）');
  });

  it('毫无产物时不调用纳产物回调（工作区零变更）', async () => {
    const addCandidates = vi.fn(() => Promise.resolve());
    const result = await runLadder({
      ladder: ITEMS.slice(0, 1),
      encode: () => Promise.reject(new Error('坏了')),
      addCandidates,
      onProgress: () => undefined,
      onConflict: () => Promise.reject(new Error('不该问冲突')),
    });
    expect(addCandidates).not.toHaveBeenCalled();
    expect(result.generated).toBe(0);
  });

  it('进度文案带上 序号/总数（分区据此画真实 N/M）', async () => {
    const progress: string[] = [];
    await runLadder({
      ladder: ITEMS.slice(0, 2),
      encode: () => Promise.resolve({ kind: 'done', product: { path: '/p', encodingParams: 'q' } }),
      addCandidates: () => Promise.resolve(),
      onProgress: (text) => progress.push(text),
      onConflict: () => Promise.reject(new Error('不该问冲突')),
    });
    expect(progress).toEqual([
      '正在生成 JPEG q60（1/2）',
      '正在生成 JPEG q75（2/2）',
    ]);
  });
});

describe('planDelete：删条目要不要连带删轮', () => {
  function entry(roundId: string | null): ImageEntry {
    return { ...newImageEntry('C:/pics/a.png'), roundId };
  }

  it('有轮且轮还在：点名轮名与结果条数，写明磁盘文件保留', () => {
    const plan = planDelete(entry('r1'), { name: '评测轮 1', candidateCount: 3 });
    expect(plan.roundId).toBe('r1');
    expect(plan.message).toContain('评测轮 1');
    expect(plan.message).toContain('3 条跑分结果');
    expect(plan.message).toContain('磁盘上的产物文件保留');
  });

  it('没有轮：不动工作区，文案说明理由', () => {
    const plan = planDelete(entry(null), null);
    expect(plan.roundId).toBeNull();
    expect(plan.message).toContain('没有对应的评测轮');
  });

  it('轮已被外部删掉（describeRound 返回 null）：不拿旧 id 去删', () => {
    const plan = planDelete(entry('gone'), null);
    expect(plan.roundId).toBeNull();
  });
});

describe('逐图编辑的纯逻辑', () => {
  const spec = {
    id: 'jpeg',
    toolKey: 'cjpeg',
    displayName: 'JPEG',
    baseArgs: [],
    losslessSupported: false,
    losslessNote: '',
    losslessArgs: [],
    qualityFlag: '-quality',
    qualityMin: 0,
    qualityMax: 100,
    qualityDefault: 80,
    qualityStep: 1,
    inputPng: true,
    outputExt: 'jpg',
    knownParams: [],
  } as unknown as ImageSpec;

  it('planReplaceImage：先清行再换路径；同一条轮上有结果时点名条数', () => {
    const entry: ImageEntry = { ...newImageEntry('C:/a.png'), roundId: 'r1' };
    const plan = planReplaceImage(entry, 'C:/b.png', { name: '轮 1', candidateCount: 2 });
    expect(plan.steps).toEqual([
      { kind: 'clear-candidates', roundId: 'r1' },
      { kind: 'replace-path', path: 'C:/b.png' },
    ]);
    expect(plan.message).toContain('2 条跑分结果');
  });

  it('选回同一路径也走完整流程（原地覆写后的自救路径）', () => {
    const entry: ImageEntry = { ...newImageEntry('C:/a.png'), roundId: 'r1' };
    const plan = planReplaceImage(entry, 'C:/a.png', { name: '轮 1', candidateCount: 0 });
    expect(plan.steps).toEqual([
      { kind: 'clear-candidates', roundId: 'r1' },
      { kind: 'replace-path', path: 'C:/a.png' },
    ]);
    expect(plan.message).toContain('重新读取');
  });

  it('runReplaceImage：清行失败即中止，不换路径（不留「新图 + 旧结果」）', async () => {
    const entry: ImageEntry = { ...newImageEntry('C:/a.png'), roundId: 'r1' };
    const plan = planReplaceImage(entry, 'C:/b.png', { name: '轮 1', candidateCount: 1 });
    await expect(
      runReplaceImage(plan, entry, {
        clearCandidates: () => Promise.reject(new Error('后端拒绝')),
        refreshIdentity: () => Promise.resolve(),
      }),
    ).rejects.toThrow('后端拒绝');
    expect(entry.path).toBe('C:/a.png');
  });

  it('addEncoderCard 优先 JPEG；目录为空时不加卡', () => {
    const entry: ImageEntry = { ...newImageEntry('C:/a.png'), encoders: [] };
    expect(addEncoderCard(entry, [])).toBeNull();
    const card = addEncoderCard(entry, [spec]);
    expect(card?.encoderId).toBe('jpeg');
    expect(card?.quality).toBe(80);
    expect(entry.encoders).toHaveLength(1);
  });

  it('moveCard：越界不动，正常交换位置', () => {
    const entry: ImageEntry = { ...newImageEntry('C:/a.png'), encoders: [] };
    addEncoderCard(entry, [spec]);
    addEncoderCard(entry, [spec]);
    const [first, second] = entry.encoders;
    moveCard(entry, 0, 1);
    expect(entry.encoders).toEqual([second, first]);
    moveCard(entry, 0, -1);
    expect(entry.encoders).toEqual([second, first]);
  });
});
