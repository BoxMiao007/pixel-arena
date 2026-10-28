// 视频高级创建：会话态与编码器目录形状。
//
// 会话态（决策 D19）：按跑分组存模块内 Map，切标签保留、关面板保留、重启归零，
// 不写任何文件。创建成功后丢弃该组的会话（下次从干净配置开始）。
//
// 纯类型与状态容器，不碰 DOM / IPC：面板（panel.ts）、命令行纯逻辑（command.ts）、
// 轮备注（note.ts）与单测都从这里取。字段名与后端契约对齐：
// - src-tauri/src/lib.rs 的 AdvancedVideoCatalog（serde camelCase）；
// - crates/pixel-arena-core/src/advanced.rs 的 VideoEncoderSpec / KnownParam / ParamValueKind。
// 视频侧只有四条静态映射规格 + `ffmpeg -encoders` 枚举名；表外编码器没有推荐参数，
// 只支持手工参数行。
//
// 视频侧不 import features/encoding/**（video-spec §0.3 硬约束）：参数合并、命令行
// 预览等纯逻辑在 command.ts 里按旧实现复制一份，两边测试各自钉死行为。

import type { ToolStatus } from '../../../core/settings';

/** 后端 ParamValueKind 的 serde tag=type 输出（camelCase）。 */
export type ParamValueKind =
  | { type: 'bool' }
  | { type: 'number'; min: number; max: number; step: number; default: number }
  | { type: 'choice'; options: string[]; default: string }
  | { type: 'text' };

/** 编码器特有的一条推荐参数（添加参数行时预填名称/标志/说明与默认值）。 */
export interface KnownParam {
  name: string;
  flag: string;
  kind: ParamValueKind;
  note: string;
}

/** 快速参数规格（质量滑杆 / 无损开关 / 固定基础参数）。 */
export interface QuickSpec {
  displayName: string;
  baseArgs: string[];
  losslessSupported: boolean;
  losslessNote: string;
  losslessArgs: string[];
  qualityFlag: string;
  qualityMin: number;
  qualityMax: number;
}

/** 视频编码器规格（advanced_video_catalog 的静态表条目，决策 D12/D13）。 */
export interface VideoSpec extends QuickSpec {
  id: string;
  ffmpegName: string;
  qualityDefault: number;
  knownParams: KnownParam[];
  note: string;
}

/** advanced_video_catalog 回传（决策 D14：-encoders 动态枚举 + 静态映射表）。 */
export interface AdvancedVideoCatalog {
  ffmpegAvailable: boolean;
  ffmpegPath: string | null;
  ffmpegError: string | null;
  /** 枚举到的全部视频编码器名（含表外的）。 */
  encoderNames: string[];
  specs: VideoSpec[];
}

/** 参数行的控件种类（布尔开关 / 数值 / 下拉 / 自由文本）。 */
export type RowKind = 'bool' | 'number' | 'choice' | 'text';

/** 一条高级参数行。value 为字符串（'' = 布尔开关不带值）；enabled 是布尔行的
 * 勾选态，false = 整行不参与（不追加也不判冲突，与核心库语义一致）。 */
export interface AdvancedParamRow {
  name: string;
  flag: string;
  value: string;
  note: string;
  kind: RowKind;
  options: string[];
  enabled: boolean;
}

/** 高级创建的一个编码器条目（同一编码器可以出现多次）。 */
export interface AdvancedEntry {
  id: string;
  kind: 'image' | 'video';
  /** 视频 = ffmpeg 编码器名（表外也可选）。 */
  encoderId: string;
  lossless: boolean;
  mode: 'quality' | 'size';
  quality: number;
  /** 目标大小真值一律是字节（KB/MB 只是显示口径）。 */
  targetBytes: number;
  unit: 'KB' | 'MB';
  rows: AdvancedParamRow[];
}

/** 一个视频跑分组的高级创建会话态（仅会话态，重启归零）。 */
export interface AdvancedSession {
  kind: 'video';
  /** 视频高级创建的原视频（命令行预览的输入路径；不参与自动编码）。 */
  referencePath: string | null;
  entries: AdvancedEntry[];
}

/** 后端 advanced_encoder_status 回传的结构子集（与 ToolStatus serde 小写来源一致）。 */
export type ToolStatusLite = Pick<ToolStatus, 'key' | 'source' | 'hint'>;

/** 目录拉取失败时的兜底规格：只支持参数行，与旧面板的退路一致。 */
export const FALLBACK_VIDEO_SPEC: QuickSpec = {
  displayName: 'libx264',
  baseArgs: [],
  losslessSupported: false,
  losslessNote: '编码器目录不可用',
  losslessArgs: [],
  qualityFlag: '-crf',
  qualityMin: 0,
  qualityMax: 51,
};

// ---------- 会话态（模块级 Map：切标签保留、关面板保留、重启归零） ----------

const sessions = new Map<string, AdvancedSession>();

let nextId = 1;

/** 生成条目 id（会话内唯一即可；整卡重建的折叠态按它键控，不复用）。 */
export function newEntryId(): string {
  return `adv-${nextId++}`;
}

/** 取跑分组的高级创建会话；首次用到时建空会话（用户再加编码器条目）。 */
export function sessionFor(groupId: string): AdvancedSession {
  let session = sessions.get(groupId);
  if (!session) {
    session = { kind: 'video', referencePath: null, entries: [] };
    sessions.set(groupId, session);
  }
  return session;
}

/** 丢弃跑分组的高级创建会话（创建成功后调用，下次从干净配置开始）。 */
export function dropSession(groupId: string): void {
  sessions.delete(groupId);
}

/** 清空全部会话（「重启归零」语义的显式入口；测试用）。 */
export function clearAdvancedSessions(): void {
  sessions.clear();
}

/** 新建一个默认编码器条目（质量优先、规格默认质量、无参数行）。 */
export function newEntry(
  encoderId: string,
  spec: QuickSpec & { qualityDefault?: number },
): AdvancedEntry {
  return {
    id: newEntryId(),
    kind: 'video',
    encoderId,
    lossless: false,
    mode: 'quality',
    quality: spec.qualityDefault ?? 75,
    targetBytes: 200 * 1024,
    unit: 'KB',
    rows: [],
  };
}

// ---------- 条目增删排序（同一编码器可多次） ----------

/** 添加一个条目（同一编码器可多次添加）。返回新条目。 */
export function addEntry(
  session: AdvancedSession,
  encoderId: string,
  spec: QuickSpec & { qualityDefault?: number },
): AdvancedEntry {
  const entry = newEntry(encoderId, spec);
  session.entries.push(entry);
  return entry;
}

/** 删除第 index 个条目；越界不动。 */
export function removeEntry(session: AdvancedSession, index: number): void {
  if (index < 0 || index >= session.entries.length) return;
  session.entries.splice(index, 1);
}

/** 排序：第 index 个条目上移（delta=-1）或下移（delta=1）；越界不动。 */
export function moveEntry(session: AdvancedSession, index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (index < 0 || index >= session.entries.length) return;
  if (target < 0 || target >= session.entries.length) return;
  const [entry] = session.entries.splice(index, 1);
  session.entries.splice(target, 0, entry);
}

// ---------- 目录查询 ----------

/** 按 ffmpeg 编码器名找规格；表外编码器返回 null。 */
export function videoSpec(
  catalog: AdvancedVideoCatalog | null,
  encoderId: string,
): VideoSpec | null {
  return catalog?.specs.find((spec) => spec.ffmpegName === encoderId) ?? null;
}

/** 条目展示名：命中规格用规格名，否则退回编码器 id。 */
export function entryLabel(
  catalog: AdvancedVideoCatalog | null,
  encoderId: string,
): string {
  return videoSpec(catalog, encoderId)?.displayName ?? encoderId;
}
