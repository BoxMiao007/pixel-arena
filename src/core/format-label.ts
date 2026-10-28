// 文件路径 → 格式显示名：来源清单与结果表「格式」列共用同一份映射，
// 避免同一张图在两个视图里显示成两种格式。
//
// 扩展名大小写不敏感，不做 MIME 探测——这是纯展示映射。

import { fileName } from './util';

const EXTENSION_LABELS: Record<string, string> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  png: 'PNG',
  mp4: 'MP4',
  mkv: 'MKV',
  webm: 'WebM',
  mov: 'MOV',
  m4v: 'M4V',
  avi: 'AVI',
  ts: 'TS',
  flv: 'FLV',
};

/** 取扩展名（最后一个点之后，大小写不敏感；无扩展名或点在开头返回空串）。 */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 格式显示名：已知扩展名走固定表；未知扩展名按 ASCII 大写；无扩展名为「未知格式」。
 * 结果表的「格式」列用这个口径（缺格式时也要有文案）。
 */
export function formatLabelForPath(path: string): string {
  const ext = extensionOf(path);
  if (ext === '') return '未知格式';
  return EXTENSION_LABELS[ext] ?? ext.replace(/[a-z]/g, (char) => char.toUpperCase());
}

/**
 * 格式显示名（可为空）：来源清单里不显示占位，未知扩展名照样大写，无扩展名返回空串。
 */
export function formatLabelOrEmpty(path: string): string {
  const ext = extensionOf(path);
  if (ext === '') return '';
  return EXTENSION_LABELS[ext] ?? ext.replace(/[a-z]/g, (char) => char.toUpperCase());
}
