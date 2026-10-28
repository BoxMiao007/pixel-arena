// 状态文案守卫：结果表与复制产物共用一份判定。
// 这四条文案与核心库 report.rs 的 status_text 同口径，改了导出文件就会跟着变，
// 所以在这里钉死（原 src/main-scoring.test.ts 的同类守卫迁到这里）。

import { describe, expect, it } from 'vitest';
import { rowStatus, rowStatusText } from './status';

describe('rowStatus 判定顺序', () => {
  it('失败优先于一切', () => {
    expect(rowStatus({ error: '解码失败', metrics: null }, true)).toBe('fail');
    expect(rowStatus({ error: '解码失败', metrics: { PSNR: 30 } }, true)).toBe('fail');
  });

  it('跑分中优先于待跑分', () => {
    expect(rowStatus({ error: null, metrics: null }, true)).toBe('running');
  });

  it('没有指标且不在跑 = 待跑分', () => {
    expect(rowStatus({ error: null, metrics: null }, false)).toBe('pending');
  });

  it('有指标且无错误 = 完成', () => {
    expect(rowStatus({ error: null, metrics: { PSNR: 30 } }, false)).toBe('done');
  });
});

describe('rowStatusText 四段文案', () => {
  it('失败带中文原因前缀', () => {
    expect(rowStatusText('fail', '解码失败: 不是图片')).toBe('失败：解码失败: 不是图片');
  });

  it('缺原因时不留空（不显眼地暴露坏数据）', () => {
    expect(rowStatusText('fail', null)).toBe('失败：未知原因');
  });

  it('跑分中与待跑分用省略号与原文', () => {
    expect(rowStatusText('running', null)).toBe('跑分中…');
    expect(rowStatusText('pending', null)).toBe('待跑分');
  });

  it('完成', () => {
    expect(rowStatusText('done', null)).toBe('完成');
  });
});
