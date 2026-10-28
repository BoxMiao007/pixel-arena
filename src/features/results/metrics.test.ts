import { describe, expect, it } from 'vitest';
import {
  formatBdRate,
  formatBdRateCell,
  formatMetricFor,
  metricHeaderTitle,
  metricMeta,
  metricPreferredDir,
  metricSortValue,
  orderMetricKeys,
} from './metrics';

describe('指标语义', () => {
  it('已知指标的列名含单位，PSNR 带 dB', () => {
    expect(metricMeta('PSNR').label).toBe('PSNR (dB)');
    expect(metricMeta('PSNR').unit).toBe('dB');
    expect(metricMeta('SSIM').label).toBe('SSIM');
    expect(metricMeta('SSIM').unit).toBeNull();
    expect(metricMeta('MS-SSIM').label).toBe('MS-SSIM');
    expect(metricMeta('SSIMULACRA2').label).toBe('SSIMULACRA2');
    expect(metricMeta('Butteraugli').label).toBe('Butteraugli');
  });

  it('每个指标固定小数位，不随数值大小跳变', () => {
    expect(metricMeta('PSNR').decimals).toBe(2);
    expect(metricMeta('SSIM').decimals).toBe(4);
    expect(metricMeta('MS-SSIM').decimals).toBe(4);
    expect(metricMeta('SSIMULACRA2').decimals).toBe(2);
    expect(metricMeta('Butteraugli').decimals).toBe(3);
  });

  it('Butteraugli 是距离，越小越好；其余越大越好', () => {
    expect(metricMeta('Butteraugli').better).toBe('lower');
    for (const key of ['PSNR', 'SSIM', 'MS-SSIM', 'SSIMULACRA2', 'VMAF']) {
      expect(metricMeta(key).better, key).toBe('higher');
    }
  });

  it('首次点击方向按优方向：越小越好的升序，其余降序', () => {
    expect(metricPreferredDir(metricMeta('Butteraugli'))).toBe(1);
    expect(metricPreferredDir(metricMeta('PSNR'))).toBe(-1);
  });

  it('未知指标原样显示键名，四位小数、按越大越好兜底', () => {
    const meta = metricMeta('CUSTOM');
    expect(meta.label).toBe('CUSTOM');
    expect(meta.known).toBe(false);
    expect(meta.decimals).toBe(4);
    expect(meta.better).toBe('higher');
  });

  it('表头说明带量纲与方向', () => {
    expect(metricHeaderTitle(metricMeta('PSNR'))).toContain('dB');
    expect(metricHeaderTitle(metricMeta('Butteraugli'))).toContain('越小越好');
  });
});

describe('指标列序', () => {
  it('固定语义序：PSNR → SSIM → MS-SSIM → SSIMULACRA2 → Butteraugli', () => {
    const keys = ['Butteraugli', 'SSIMULACRA2', 'PSNR', 'SSIM', 'MS-SSIM'];
    expect(orderMetricKeys(keys)).toEqual([
      'PSNR',
      'SSIM',
      'MS-SSIM',
      'SSIMULACRA2',
      'Butteraugli',
    ]);
  });

  it('未登记的指标按字典序追加在后', () => {
    expect(orderMetricKeys(['Zeta', 'PSNR', 'Alpha'])).toEqual(['PSNR', 'Alpha', 'Zeta']);
  });

  it('只出出现过的指标，不补空列', () => {
    expect(orderMetricKeys(['SSIM', 'PSNR'])).toEqual(['PSNR', 'SSIM']);
  });

  it('视频表可以传自己的优先序', () => {
    expect(orderMetricKeys(['VMAF', 'PSNR', 'SSIM'], ['VMAF', 'PSNR', 'SSIM'])).toEqual([
      'VMAF',
      'PSNR',
      'SSIM',
    ]);
  });
});

describe('指标格式化', () => {
  it('固定小数位：PSNR 两位、SSIM 四位、Butteraugli 三位', () => {
    expect(formatMetricFor('PSNR', 42.126)).toBe('42.13');
    expect(formatMetricFor('SSIM', 0.993912)).toBe('0.9939');
    expect(formatMetricFor('Butteraugli', 0.8421)).toBe('0.842');
  });

  it('SSIMULACRA2 在同一列不会一会儿两位一会儿四位', () => {
    expect(formatMetricFor('SSIMULACRA2', 90.2)).toBe('90.20');
    expect(formatMetricFor('SSIMULACRA2', 9.5)).toBe('9.50');
  });

  it('inf 用数学符号，缺值用破折号，0 是有效值', () => {
    expect(formatMetricFor('PSNR', 'inf')).toBe('∞');
    expect(formatMetricFor('PSNR', undefined)).toBe('—');
    expect(formatMetricFor('PSNR', null)).toBe('—');
    expect(formatMetricFor('Butteraugli', 0)).toBe('0.000');
  });

  it('排序取值："inf" 按 +∞，缺值按 null', () => {
    expect(metricSortValue('inf')).toBe(Number.POSITIVE_INFINITY);
    expect(metricSortValue(0)).toBe(0);
    expect(metricSortValue(undefined)).toBeNull();
    expect(metricSortValue(null)).toBeNull();
  });
});

describe('BD-rate 文本', () => {
  it('带符号两位小数百分数', () => {
    expect(formatBdRate(12.3456)).toBe('+12.35%');
    expect(formatBdRate(-5.6)).toBe('-5.60%');
    expect(formatBdRate(0)).toBe('+0.00%');
  });

  it('不可算时为破折号', () => {
    expect(formatBdRateCell(null)).toBe('—');
    expect(formatBdRateCell(undefined)).toBe('—');
    expect(formatBdRateCell(-3.2)).toBe('-3.20%');
  });
});
