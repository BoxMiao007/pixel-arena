// 进度展示口径的单测：确定 / 不确定只由结构化 completed/total 决定，
// detail 只当文案用（含空串回退），绝不参与数值解析。

import { describe, expect, it } from 'vitest';
import { busyProgressView } from './progress';

describe('busyProgressView：忙状态进度只读结构化 completed/total', () => {
  it('completed/total 都有效且 total > 0：确定进度，label 取 detail', () => {
    expect(
      busyProgressView({
        label: '正在自动编码',
        detail: '正在生成 AVIF q75',
        completed: 5,
        total: 15,
      }),
    ).toEqual({
      kind: 'determinate',
      completed: 5,
      total: 15,
      label: '正在生成 AVIF q75',
    });
  });

  it('detail 为空串：label 回退到忙状态动词（不显示 N/M）', () => {
    expect(
      busyProgressView({ label: '正在跑分', detail: '', completed: 2, total: 8 }),
    ).toEqual({ kind: 'determinate', completed: 2, total: 8, label: '正在跑分' });
  });

  it('缺 completed 或 total：不确定进度', () => {
    expect(busyProgressView({ label: '正在跑分', detail: '正在计算指标' })).toEqual({
      kind: 'indeterminate',
      label: '正在计算指标',
    });
    expect(
      busyProgressView({ label: '正在跑分', detail: '', completed: 3 }),
    ).toEqual({ kind: 'indeterminate', label: '正在跑分' });
  });

  it('total 为 0 或负数：不确定进度（不伪造百分比）', () => {
    expect(
      busyProgressView({ label: '正在编码', detail: '', completed: 0, total: 0 }),
    ).toEqual({ kind: 'indeterminate', label: '正在编码' });
    expect(
      busyProgressView({ label: '正在编码', detail: '', completed: 1, total: -1 }),
    ).toEqual({ kind: 'indeterminate', label: '正在编码' });
  });

  it('NaN / Infinity：不确定进度', () => {
    expect(
      busyProgressView({ label: '正在编码', detail: '', completed: Number.NaN, total: 10 }),
    ).toEqual({ kind: 'indeterminate', label: '正在编码' });
    expect(
      busyProgressView({
        label: '正在编码',
        detail: '',
        completed: 1,
        total: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ kind: 'indeterminate', label: '正在编码' });
  });
});
