// 剪贴板序列化：CSV 与导出文件同构，Markdown 给文档/issue 用。纯函数，无 DOM。

import { describe, expect, it } from 'vitest';
import type { CandidateImage, Group, Round } from '../../core/model';
import type { BdrateSummary } from './ipc';
import { toClipboardCsv, toMarkdown } from './serialize';

function candidate(overrides: Partial<CandidateImage> = {}): CandidateImage {
  return {
    path: '/r/photo-q60.jpg',
    fileSize: 17341,
    sizeRatio: 0.136424,
    metrics: { PSNR: 41.862135, SSIM: 0.993912 },
    encodingParams: 'JPEG q60',
    note: null,
    error: null,
    ...overrides,
  };
}

function round(overrides: Partial<Round> = {}): Round {
  return {
    id: 'r-1',
    name: '照片测试轮',
    referencePath: '/r/原图 photo.png',
    referenceSize: 127123,
    candidates: [candidate()],
    ...overrides,
  };
}

const group: Group = { id: 'g-1', name: '人像测试', kind: 'image', rounds: [], activeRoundId: 'r-1' };

const summary: BdrateSummary = {
  referenceFormat: 'JPEG',
  note: null,
  entries: [
    { format: 'JPEG', bdRatePercent: null, pointCount: 3, note: '参照格式' },
    { format: 'WebP', bdRatePercent: -12.3456, pointCount: 3, note: null },
  ],
};

describe('剪贴板 CSV', () => {
  it('与导出文件同构但不带 BOM', () => {
    const csv = toClipboardCsv({ group, round: round(), summary, generatedAt: '2026-10-28 10:00:00' });
    expect(csv.startsWith('\uFEFF')).toBe(false);
    expect(csv.startsWith('# 像素竞技场评测报告')).toBe(true);
    expect(csv).toContain('# 跑分组：人像测试');
    expect(csv).toContain('# 评测轮：照片测试轮');
    expect(csv).toContain('# 原图：/r/原图 photo.png');
    expect(csv).toContain(
      'candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status',
    );
  });

  it('指标定点 6 位，缺列留空，状态为中文文案', () => {
    const csv = toClipboardCsv({ group, round: round(), summary, generatedAt: 't' });
    const row = csv.split('\n').find((line) => line.startsWith('/r/photo-q60.jpg')) ?? '';
    expect(row).toBe('/r/photo-q60.jpg,JPEG q60,17341,0.136424,41.862135,0.993912,,,,完成');
  });

  it('待跑分行没有指标也没有编码参数', () => {
    const csv = toClipboardCsv({
      group,
      round: round({ candidates: [candidate({ metrics: null, encodingParams: null })] }),
      summary: null,
      generatedAt: 't',
    });
    expect(csv).toContain('/r/photo-q60.jpg,,17341,0.136424,,,,,,待跑分');
  });

  it('inf 走哨兵、失败行带原因、路径按 RFC 4180 转义', () => {
    const csv = toClipboardCsv({
      group,
      round: round({
        candidates: [
          candidate({ path: '/r/照片, "好".png', metrics: { PSNR: 'inf' }, error: null }),
          candidate({ path: '/r/bad.jpg', metrics: null, error: '解码失败: 不是图片' }),
        ],
      }),
      summary: null,
      generatedAt: 't',
    });
    expect(csv).toContain('"/r/照片, ""好"".png"');
    expect(csv).toContain(',inf,');
    expect(csv).toContain('失败：解码失败: 不是图片');
  });

  it('任一行有备注才追加 note 列', () => {
    const withoutNotes = toClipboardCsv({ group, round: round(), summary, generatedAt: 't' });
    expect(withoutNotes).not.toContain('status,note');
    const withNotes = toClipboardCsv({
      group,
      round: round({ candidates: [candidate({ note: '目标大小不可达' })] }),
      summary,
      generatedAt: 't',
    });
    expect(withNotes).toContain(',status,note');
    expect(withNotes).toContain('目标大小不可达');
  });

  it('BD-rate 节总会出现：有汇总写数据，没有汇总写原因', () => {
    const withSummary = toClipboardCsv({ group, round: round(), summary, generatedAt: 't' });
    expect(withSummary).toContain('# 【BD-rate 汇总】（参照格式：JPEG）');
    expect(withSummary).toContain('format,bd_rate_percent,point_count,note');
    expect(withSummary).toContain('WebP,-12.345600,3,');
    expect(withSummary).toContain('JPEG,,3,参照格式');

    const without = toClipboardCsv({
      group,
      round: round(),
      summary: null,
      bdrateError: '样本不足',
      generatedAt: 't',
    });
    expect(without).toContain('# 【BD-rate 汇总】不可用：样本不足');
  });

  it('有视频内容才写视频节', () => {
    const noVideo = toClipboardCsv({ group, round: round(), summary, generatedAt: 't' });
    expect(noVideo).not.toContain('# 【视频跑分结果】');

    const withVideo = toClipboardCsv({
      group,
      round: round({
        videoReferencePath: '/r/ref.mp4',
        videoCandidates: [
          {
            path: '/r/dis-150k.mp4',
            fileSize: 27050,
            sizeRatio: 0.453083,
            metrics: { VMAF: 94.87, PSNR: 'inf', SSIM: 0.9926 },
            error: null,
          },
        ],
      }),
      summary,
      generatedAt: 't',
    });
    expect(withVideo).toContain('# 【视频跑分结果】');
    expect(withVideo).toContain('candidate,candidate_bytes,size_ratio,vmaf,psnr,ssim,status');
    expect(withVideo).toContain('/r/dis-150k.mp4,27050,0.453083,94.870000,inf,0.992600,完成');
  });
});

describe('剪贴板 Markdown', () => {
  it('表头含单位与格式列，行内是可直接读的格式化值', () => {
    const md = toMarkdown({ group, round: round(), summary, generatedAt: '2026-10-28 10:00:00' });
    expect(md).toContain('### 人像测试 / 照片测试轮');
    expect(md).toContain('| # | 跑分图 | 格式 | 文件大小 | 体积比 | 编码参数 | PSNR (dB) | SSIM | 状态 |');
    expect(md).toContain('| 1 | photo-q60.jpg | JPEG | 16.9 KB | 13.6% | JPEG q60 | 41.86 | 0.9939 | 完成 |');
  });

  it('全空的可选列不进表格（没有参数就不出编码参数列）', () => {
    const md = toMarkdown({
      group,
      round: round({ candidates: [candidate({ encodingParams: null, metrics: null })] }),
      summary: null,
      generatedAt: 't',
    });
    expect(md).not.toContain('编码参数');
    expect(md).toContain('待跑分');
  });

  it('单元格竖线转义，避免破坏表格结构', () => {
    const md = toMarkdown({
      group,
      round: round({ candidates: [candidate({ path: '/r/a|b.jpg' })] }),
      summary: null,
      generatedAt: 't',
    });
    expect(md).toContain('a\\|b.jpg');
  });

  it('BD-rate 段带口径说明与参照行', () => {
    const md = toMarkdown({ group, round: round(), summary, generatedAt: 't' });
    expect(md).toContain('#### BD-rate 汇总（参照格式：JPEG）');
    expect(md).toContain('BD-rate 为负表示同画质下码率更低。');
    expect(md).toContain('| WebP | -12.35% | 3 |');
    expect(md).toContain('| JPEG | — | 3 | 参照格式 |');
  });

  it('没有汇总时写明原因而不是静默省略', () => {
    const md = toMarkdown({ group, round: round(), summary: null, generatedAt: 't' });
    expect(md).toContain('#### BD-rate 汇总不可用');
    expect(md).toContain('尚未计算。');
  });
});
