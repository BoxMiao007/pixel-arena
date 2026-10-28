// 剪贴板产物：把本轮结果序列化成 CSV / Markdown 文本。
//
// 边界（规格 §4.3）：文件导出仍以核心库 report.rs 为唯一真源，本模块只服务
// 「复制」——CSV 与导出文件同构（仅去掉 BOM），Markdown 是给 issue/文档用的表格。
// 这里不调 IPC、不碰 DOM，纯函数可单测。

import { formatRatio, formatSize } from '../../core/format';
import { formatLabelForPath } from '../../core/format-label';
import type { CandidateImage, CandidateVideo, Group, Round } from '../../core/model';
import { fileName } from '../../core/util';
import { IMAGE_METRIC_ORDER, formatMetricFor, metricMeta } from './metrics';
import { rowStatus, rowStatusText } from './status';

const VIDEO_METRIC_ORDER = ['VMAF', 'PSNR', 'SSIM'] as const;

export interface ClipboardInput {
  group: Group;
  round: Round;
  /** 只作展示的生成时间。 */
  generatedAt: string;
}

/** RFC 4180 最小转义：含 , " 换行 回车时整体加引号、内部引号翻倍。 */
function csvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 指标原始值文本（与导出文件一致：定点 6 位、inf/nan 哨兵、缺失留空）。 */
function metricText(value: number | 'inf' | undefined): string {
  if (value === undefined) return '';
  if (value === 'inf') return 'inf';
  if (Number.isNaN(value)) return 'nan';
  return value.toFixed(6);
}

function ratioText(ratio: number | null): string {
  return ratio === null ? '' : ratio.toFixed(6);
}

function imageRow(candidate: CandidateImage, hasNotes: boolean): string {
  const metrics = candidate.metrics;
  const status = rowStatusText(rowStatus(candidate, false), candidate.error);
  const fields = [
    csvField(candidate.path),
    candidate.encodingParams ? csvField(candidate.encodingParams) : '',
    String(candidate.fileSize),
    ratioText(candidate.sizeRatio),
    ...IMAGE_METRIC_ORDER.map((key) => metricText(metrics?.[key])),
    csvField(status),
  ];
  if (hasNotes) fields.push(candidate.note ? csvField(candidate.note) : '');
  return fields.join(',');
}

function videoRow(candidate: CandidateVideo): string {
  const metrics = candidate.metrics;
  const status = rowStatusText(rowStatus(candidate, false), candidate.error);
  return [
    csvField(candidate.path),
    String(candidate.fileSize),
    ratioText(candidate.sizeRatio),
    ...VIDEO_METRIC_ORDER.map((key) => metricText(metrics?.[key])),
    csvField(status),
  ].join(',');
}

function hasVideoContent(round: Round): boolean {
  return (round.videoReferencePath ?? null) !== null || (round.videoCandidates ?? []).length > 0;
}

/**
 * 剪贴板 CSV：与导出文件同构（头注释、三节、固定列序、6 位小数），仅去掉 BOM。
 * 指标列固定五列，旧轮次缺的留空——与 report.rs 的 IMAGE_METRIC_KEYS 一致。
 */
export function toClipboardCsv(input: ClipboardInput): string {
  const { group, round, generatedAt } = input;
  const lines: string[] = [];
  lines.push('# 像素竞技场评测报告');
  lines.push(`# 跑分组：${group.name}`);
  lines.push(`# 评测轮：${round.name}`);
  lines.push(`# 原图：${round.referencePath ?? '未设置'}`);
  lines.push(`# 生成时间：${generatedAt}`);
  lines.push('');

  lines.push('# 【图片跑分结果】');
  const hasNotes = round.candidates.some((candidate) => candidate.note !== null && candidate.note !== undefined);
  lines.push(
    `candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status${hasNotes ? ',note' : ''}`,
  );
  for (const candidate of round.candidates) lines.push(imageRow(candidate, hasNotes));

  if (hasVideoContent(round)) {
    lines.push('');
    lines.push('# 【视频跑分结果】');
    lines.push(`# 原视频：${round.videoReferencePath ?? '未设置'}`);
    lines.push('candidate,candidate_bytes,size_ratio,vmaf,psnr,ssim,status');
    for (const candidate of round.videoCandidates ?? []) lines.push(videoRow(candidate));
  }

  return `${lines.join('\n')}\n`;
}

/** Markdown 表格单元格：竖线转义、换行压成空格（GFM 表格不能跨行）。 */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdRow(cells: readonly string[]): string {
  return `| ${cells.map(mdCell).join(' | ')} |`;
}

/**
 * 剪贴板 Markdown：给 issue/文档的紧凑表格。列集合随数据走（只出出现过的指标），
 * 备注列与编码参数列沿用结果表的口径（全空不显示）。
 */
export function toMarkdown(input: ClipboardInput): string {
  const { group, round, generatedAt } = input;
  const metricKeys = IMAGE_METRIC_ORDER.filter((key) =>
    round.candidates.some((candidate) => candidate.metrics?.[key] !== undefined),
  );
  const hasNotes = round.candidates.some((candidate) => candidate.note !== null && candidate.note !== undefined);
  const hasParams = round.candidates.some(
    (candidate) => (candidate.encodingParams ?? '').length > 0,
  );

  const header = ['#', '跑分图', '格式', '文件大小', '体积比'];
  if (hasParams) header.push('编码参数');
  for (const key of metricKeys) header.push(metricMeta(key).label);
  header.push('状态');
  if (hasNotes) header.push('备注');

  const lines: string[] = [];
  lines.push(`### ${mdCell(group.name)} / ${mdCell(round.name)}`);
  lines.push('');
  lines.push(
    `原图：${round.referencePath ? `${fileName(round.referencePath)}（\`${round.referencePath}\`）` : '未设置'}`,
  );
  lines.push(`生成时间：${generatedAt}`);
  lines.push('');
  lines.push(mdRow(header));
  lines.push(mdRow(header.map(() => '---')));

  round.candidates.forEach((candidate, index) => {
    const status = rowStatusText(rowStatus(candidate, false), candidate.error);
    const cells = [
      String(index + 1),
      fileName(candidate.path),
      formatLabelForPath(candidate.path),
      formatSize(candidate.fileSize),
      candidate.sizeRatio === null ? '—' : formatRatio(candidate.sizeRatio),
    ];
    if (hasParams) cells.push(candidate.encodingParams ?? '—');
    for (const key of metricKeys) cells.push(formatMetricFor(key, candidate.metrics?.[key]));
    cells.push(status);
    if (hasNotes) cells.push(candidate.note ?? '');
    lines.push(mdRow(cells));
  });

  const videoCandidates = round.videoCandidates ?? [];
  if (hasVideoContent(round) && videoCandidates.length > 0) {
    lines.push('');
    lines.push('#### 视频跑分结果');
    lines.push('');
    const videoHeader = ['#', '跑分视频', '文件大小', '体积比', 'VMAF', 'PSNR (dB)', 'SSIM', '状态'];
    lines.push(mdRow(videoHeader));
    lines.push(mdRow(videoHeader.map(() => '---')));
    videoCandidates.forEach((candidate, index) => {
      lines.push(
        mdRow([
          String(index + 1),
          fileName(candidate.path),
          formatSize(candidate.fileSize),
          candidate.sizeRatio === null ? '—' : formatRatio(candidate.sizeRatio),
          formatMetricFor('VMAF', candidate.metrics?.VMAF),
          formatMetricFor('PSNR', candidate.metrics?.PSNR),
          formatMetricFor('SSIM', candidate.metrics?.SSIM),
          rowStatusText(rowStatus(candidate, false), candidate.error),
        ]),
      );
    });
  }

  return `${lines.join('\n')}\n`;
}
