// 导出文件名：默认名主干 + 文件系统非法字符清洗。
//
// 规则沿用旧界面（票 18）：优先原图文件名主干（photo.png → photo），没有原图或
// 清洗后为空时回落轮名，再空回落「评测轮」。
// 新增 Windows 兜底：保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）与结尾点/空格
// 在保存对话框里会失败或写成怪名字，统一加下划线/去掉。

import { fileName } from '../../core/util';

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const TRAILING_DOTS_SPACES = /[. ]+$/;

/** 清洗成可落盘的文件名片段；空串表示清洗后什么都不剩（由调用方回落）。 */
function clean(raw: string): string {
  const replaced = raw.replace(ILLEGAL_CHARS, '_').trim().replace(TRAILING_DOTS_SPACES, '');
  if (replaced.length === 0) return '';
  return RESERVED_NAMES.test(replaced) ? `${replaced}_` : replaced;
}

/** 轮名 → 文件名片段；清洗后为空时返回「评测轮」。 */
export function sanitizeFileName(name: string): string {
  return clean(name) || '评测轮';
}

/** 原图文件名主干（最后一个点之前；`.hidden` 视为无扩展名）；无原图返回 null。 */
export function referenceStem(path: string | null): string | null {
  if (path === null) return null;
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 导出报告的默认文件名主干：优先原图主干，其次轮名。 */
export function exportBaseName(round: { referencePath: string | null; name: string }): string {
  const stem = referenceStem(round.referencePath);
  if (stem !== null) {
    const cleaned = clean(stem);
    if (cleaned.length > 0) return cleaned;
  }
  return sanitizeFileName(round.name);
}

/** 导出报告的默认文件名（含扩展名）。 */
export function exportFileName(
  round: { referencePath: string | null; name: string },
  kind: 'csv' | 'html',
): string {
  return `${exportBaseName(round)}.${kind}`;
}
