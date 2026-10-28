// 评分表页签的无 DOM 规则：列最优值标记（含读屏兜底）与空态文案。
//
// 仓库没有 jsdom（ADR 0002 §5：DOM 层不做单测，界面用真实窗口截图验收），所以
// 表头 aria-sort、行内状态、焦点还原等 DOM 装配不在这里测；本文件只覆盖
// mount 之外、能脱离 DOM 表达的规则。

import { describe, expect, it } from 'vitest';
import type { CandidateImage } from '../../core/model';
import { bestValues, emptyNoteText, formatCellFor } from './results-tab';

function candidate(overrides: Partial<CandidateImage> = {}): CandidateImage {
  return {
    path: '/r/a.webp',
    fileSize: 100,
    sizeRatio: 0.5,
    metrics: { PSNR: 40 },
    error: null,
    ...overrides,
  };
}

describe('列最优值标记', () => {
  const big = candidate({ path: '/r/big.png', fileSize: 300, sizeRatio: 0.9, metrics: { PSNR: 38 } });
  const small = candidate({ path: '/r/small.webp', fileSize: 100, sizeRatio: 0.4, metrics: { PSNR: 42 } });
  const best = bestValues([big, small], ['PSNR']);

  it('最优格带视觉隐藏的「最佳」，不只靠底色', () => {
    expect(formatCellFor(small, 'fileSize', best)).toMatchObject({
      className: 'is-best',
      title: '本列最小',
      srText: '最佳',
    });
    expect(formatCellFor(big, 'fileSize', best).srText).toBeUndefined();
  });

  it('指标列的最优格给出指标名提示', () => {
    const psnr = formatCellFor(small, 'PSNR', best);
    expect(psnr.srText).toBe('最佳');
    expect(psnr.title).toContain('本列最优');
    expect(psnr.text).not.toBe('');
  });

  it('只有一个有值时不高亮整列（没有比较意义）', () => {
    const only = bestValues([small], ['PSNR']);
    expect(formatCellFor(small, 'fileSize', only).srText).toBeUndefined();
    expect(formatCellFor(small, 'PSNR', only).srText).toBeUndefined();
  });

  it('失败行不参与最优值计数', () => {
    const failed = candidate({ path: '/r/bad.png', fileSize: 1, error: '解码失败', metrics: null });
    const values = bestValues([failed, small], ['PSNR']);
    expect(values.get('fileSize')?.present).toBe(1);
    expect(values.get('PSNR')?.present).toBe(1);
  });

  it('没有值的列不进最优值表', () => {
    const empty = bestValues([candidate({ metrics: null })], ['PSNR']);
    expect(empty.has('PSNR')).toBe(false);
  });
});

describe('空态文案', () => {
  it('图片组：跑分后这里出现指标表', () => {
    expect(emptyNoteText('image')).toBe('跑分后这里出现指标表');
  });

  it('视频组：提示旧工作区的图片结果会显示在这里', () => {
    expect(emptyNoteText('video')).toBe('旧工作区的图片跑分结果会显示在这里');
  });

  it('两种分组都是一行说明', () => {
    for (const kind of ['image', 'video'] as const) {
      const text = emptyNoteText(kind);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('\n');
    }
  });
});
