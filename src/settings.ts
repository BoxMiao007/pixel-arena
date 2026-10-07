// 设置（T23 设置中心）：数据形状与 src-tauri/src/settings.rs 的 serde camelCase
// 输出一一对应；纯函数（路径处理、恢复门控）在这里，可脱离 DOM 单测。

export type ThemePref = 'light' | 'dark' | 'system';

/** 跑分并发度档位（T24）：逻辑核数占比，quarter=1/4、half=1/2（默认）、
 * threequarters=3/4、full=全部；与 src-tauri/src/settings.rs 的 serde 小写落盘一致。 */
export type ScoreConcurrencyPref = 'quarter' | 'half' | 'threequarters' | 'full';

/** 产物文件名冲突策略（T30）：auto = 自动追加 _1/_2（默认，现状行为）；
 * ask = 产物写入前弹窗询问覆盖/跳过。仅作用于 GUI 产物写入（CLI 恒自动追加，
 * 决策 0017）；与 src-tauri/src/settings.rs 的 FileConflictPolicy serde 小写一致。 */
export type ConflictPolicyPref = 'auto' | 'ask';

export interface WindowSize {
  width: number;
  height: number;
}

/** 编码器可执行文件路径覆盖；null = 使用内置编码器（安装包捆绑或 tools/ 既有
 * 安装；运行期下载已移除，缺失见条目「官方发布页」链接，决策 0025）。 */
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
  /** 跑分并发度（T24）：默认 half = 只用一半逻辑核留余量。 */
  scoreConcurrency: ScoreConcurrencyPref;
  /** 产物文件名冲突策略（T30）：默认 auto = 自动追加 _1/_2。 */
  conflictPolicy: ConflictPolicyPref;
  defaultExportDir: string | null;
  recentDir: string | null;
  window: WindowSize | null;
  encoderOverrides: EncoderOverrides;
  /** FFmpeg 可执行文件路径覆盖（T29-2）：null = 使用应用内下载的内置 ffmpeg。 */
  ffmpegPath: string | null;
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

/** 选了文件之后要不要记最近目录（US27，审查修复 B7）：与恢复共用同一道记录状态
 * 门控——开关关闭时不再写最近目录（干净启动 = 既不读也不写），返回 null 表示
 * 本次不记录；开启时返回把 recentDir 更新为所选文件父目录后的新设置（其余设置
 * 项原样保留）。路径没有父目录（根路径/裸文件名）同样不记录。 */
export function nextRecentDir(settings: SettingsData, path: string): SettingsData | null {
  if (!settings.recordState) return null;
  const dir = parentDir(path);
  if (!dir) return null;
  return { ...settings, recentDir: dir };
}

// ---------- T29-2：设置页扩展（来源状态 / 重置默认值 / 关于） ----------

/** 工具来源状态四态（与 src-tauri/src/tool_status.rs 的 ToolSource serde 小写一一对应）。 */
export type ToolSourceState = 'builtin' | 'external' | 'unconfigured' | 'unavailable';

/** 单个工具（FFmpeg / 编码器 / avifdec）的状态条目，字段与 ToolStatus serde camelCase 一致。 */
export interface ToolStatus {
  key: string;
  source: ToolSourceState;
  overridePath: string | null;
  effectivePath: string | null;
  builtinVersion: string | null;
  builtinInstalled: boolean;
  detectedVersion: string | null;
  /** 该编码器项目的官方发布页（https；与核心库缺失报错、关于页库链接同一数据源）。
   * ffmpeg 走应用内下载，无发布页条目 → null。 */
  releasePage: string | null;
  hint: string | null;
}

/** 来源状态的中文标签（设置页每行的徽标文本，面向用户的展示契约）。 */
const TOOL_SOURCE_LABELS: Record<ToolSourceState, string> = {
  builtin: '内置',
  external: '外部',
  unconfigured: '未配置',
  unavailable: '不可用',
};

export function sourceLabel(state: ToolSourceState): string {
  return TOOL_SOURCE_LABELS[state];
}

/** 编码器条目的「官方发布页」跳转地址（决策 0025）：与核心库缺失报错、关于页库
 * 链接共用 release_page 单一数据源。走 isSafeLibraryUrl 白名单——https 返回地址
 *（调用方渲染 <a>），否则 null（调用方渲染纯文本，不产生可点击链接）。 */
export function releasePageHref(status: Pick<ToolStatus, 'releasePage'>): string | null {
  const url = status.releasePage;
  return url !== null && isSafeLibraryUrl(url) ? url : null;
}

/** 重置 = 恢复默认值（决策 D17）：清空全部外部路径（编码器覆盖 + FFmpeg）、
 * 恢复默认并发 / 主题 / 目录；与后端 Settings::default() 的语义一一对应。 */
export function defaultSettings(): SettingsData {
  return {
    formatVersion: 1,
    recordState: true,
    theme: 'dark',
    scoreConcurrency: 'half',
    conflictPolicy: 'auto',
    defaultExportDir: null,
    recentDir: null,
    window: null,
    encoderOverrides: {
      cjpeg: null,
      cwebp: null,
      avifenc: null,
      cjxl: null,
      avifdec: null,
    },
    ffmpegPath: null,
  };
}

/** 「关于」区块的单个库条目（与 AboutLibrary serde camelCase 一致）。 */
export interface AboutLibrary {
  name: string;
  version: string;
  url: string;
}

/** 「关于」区块数据（与 AboutInfo serde camelCase 一致）。 */
export interface AboutData {
  appName: string;
  appVersion: string;
  coreVersion: string;
  intro: string;
  license: string;
  repoUrl: string;
  libraries: AboutLibrary[];
}

/** 库名超链接的白名单校验：只把 https 链接渲染成 <a>（后端数据源可信，
 * 这里仍守住伪协议注入；http/空值降级为纯文本库名）。 */
export function isSafeLibraryUrl(url: string): boolean {
  return url.startsWith('https://');
}
