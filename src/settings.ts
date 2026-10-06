// 设置（T23 设置中心）：数据形状与 src-tauri/src/settings.rs 的 serde camelCase
// 输出一一对应；纯函数（路径处理、恢复门控）在这里，可脱离 DOM 单测。

export type ThemePref = 'light' | 'dark' | 'system';

export interface WindowSize {
  width: number;
  height: number;
}

/** 编码器可执行文件路径覆盖；null = 使用内置自动安装的编码器（清空恢复）。 */
export interface EncoderOverrides {
  cjpeg: string | null;
  cwebp: string | null;
  avifenc: string | null;
  cjxl: string | null;
  avifdec: string | null;
}

export interface SettingsData {
  formatVersion: number;
  recordState: boolean;
  theme: ThemePref;
  defaultExportDir: string | null;
  recentDir: string | null;
  window: WindowSize | null;
  encoderOverrides: EncoderOverrides;
}

/** 设置面板可编辑的编码器清单（与设置文件键一一对应；标签面向用户）。 */
export const ENCODER_FIELDS: { key: keyof EncoderOverrides; label: string }[] = [
  { key: 'cjpeg', label: 'JPEG（cjpeg）' },
  { key: 'cwebp', label: 'WebP（cwebp）' },
  { key: 'avifenc', label: 'AVIF 编码（avifenc）' },
  { key: 'cjxl', label: 'JPEG XL（cjxl）' },
  { key: 'avifdec', label: 'AVIF 解码（avifdec，产物代片用）' },
];

/** 任意路径取父目录（POSIX 与 Windows 分隔符都认；没有父目录返回 null）。 */
export function parentDir(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut <= 0) return null;
  return path.slice(0, cut);
}

/** 导出对话框默认路径：设置过默认导出目录则定位到 <目录>/<文件名>，否则用纯文件名
 *（目录尾部多余的分隔符容忍，Windows 反斜杠目录同样可拼）。 */
export function exportDefaultPath(dir: string | null | undefined, fileName: string): string {
  const trimmed = dir?.trim();
  if (!trimmed) return fileName;
  return `${trimmed.replace(/[\\/]+$/, '')}/${fileName}`;
}

/** 文件打开对话框的默认位置：记录状态开启且记过最近目录才恢复（关 = 每次干净起点）；
 * 返回 undefined 表示交给系统默认行为。 */
export function openDefaultPath(
  settings: Pick<SettingsData, 'recordState' | 'recentDir'>,
): string | undefined {
  if (!settings.recordState) return undefined;
  return settings.recentDir ?? undefined;
}
