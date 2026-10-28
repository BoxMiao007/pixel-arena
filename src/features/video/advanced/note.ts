// 视频高级创建的轮备注：配置摘要 + 每项命令行（纯逻辑，可单测）。
//
// 本版本不做视频自动编码：确认后新建评测轮，把配置落进 round.note；产物由用户
// 复制命令行自行编码后用「添加跑分视频」导入。备注文案必须如实（不承诺自动编码）。
//
// 展示侧（inspector/round-note.ts）用的 NOTE_PREVIEW_LINES 折叠规则也在这里，
// 与构建逻辑同文件，测试可以脱离 DOM 钉死「前 6 行 + 展开全部」的口径。

import { videoSpec, type AdvancedSession, type AdvancedVideoCatalog } from './catalog';
import { buildEntryArgsLenient, previewVideoCommand } from './command';

/** 轮备注首行：说明本版本的能力边界与后续导入路径。 */
export const VIDEO_NOTE_HEADER =
  '高级创建配置（本版本不做视频自动编码；可复制命令行自行编码后用「添加跑分视频」导入）：';

/** 长备注默认展示的行数（其余折叠进 <details>）。 */
export const NOTE_PREVIEW_LINES = 6;

/**
 * 构建写进 round.note 的文本：编码器 + 参数摘要 + 每项命令行。
 * 参数摘要用宽松合并（与卡片预览同口径，半填的参数行不打断创建；错误已被面板
 * 的 validateAll 前置拦下）。catalog 为 null（目录加载失败）时表外方式展示。
 */
export function buildVideoNote(
  catalog: AdvancedVideoCatalog | null,
  session: AdvancedSession,
): string {
  const lines: string[] = [VIDEO_NOTE_HEADER];
  if (session.entries.length === 0) {
    lines.push('（没有编码器条目）');
    return lines.join('\n');
  }
  session.entries.forEach((entry, index) => {
    const spec = videoSpec(catalog, entry.encoderId);
    const label = spec?.displayName ?? entry.encoderId;
    const args = buildEntryArgsLenient(spec, entry);
    lines.push(
      `${index + 1}. ${label}：${args.length > 0 ? args.join(' ') : '（无参数）'}`,
    );
    lines.push(`   命令行：${previewVideoCommand(spec, entry, session.referencePath)}`);
  });
  return lines.join('\n');
}

/** 轮备注的展示布局：前 head 行 + 折叠区，空内容返回 null（分区不出现）。 */
export interface NoteLayout {
  /** 规范化后的完整文本（复制用，行尾统一 \n、去首尾空行）。 */
  full: string;
  lines: string[];
  /** 默认展示的前 head 行。 */
  head: string[];
  /** 折叠进 <details> 的其余行。 */
  rest: string[];
  folded: boolean;
  totalLines: number;
}

/**
 * 把轮备注切成「默认展示前 N 行 + 其余折叠」；空 / 全空白返回 null。
 * 只做换行规范化与首尾空行清理，不 trim 行内空白（命令行的缩进要保留）。
 */
export function noteLayout(
  note: string | null | undefined,
  headLines: number = NOTE_PREVIEW_LINES,
): NoteLayout | null {
  if (note === null || note === undefined) return null;
  const lines = note.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  if (lines.length === 0) return null;
  const limit = Math.max(1, Math.floor(headLines));
  const folded = lines.length > limit;
  return {
    full: lines.join('\n'),
    lines,
    head: lines.slice(0, limit),
    rest: lines.slice(limit),
    folded,
    totalLines: lines.length,
  };
}
