// encoding 域的 IPC 收口：一站式取点 / 生成、高级创建（image）编码、原图标识。
//
// 约定（与 core/ipc.ts 一致）：
// - 组件层不裸调 invoke，命令名与载荷形状只在这里出现一次；
// - 任何返回 Workspace 的命令都不在这里包（工作区写入统一走 core/ipc + store），
//   本模块只放「本域专有」的命令；
// - 返回结构按后端 serde camelCase 逐字段声明，字段语义见 src-tauri/src/lib.rs。

import { invoke } from '@tauri-apps/api/core';
import type { ToolStatus } from '../../core/settings';
import type { AdvancedEntry, ImageSpec } from './logic/advanced';

// ---------- 一站式 ----------

export interface FormatEntry {
  format: string;
  label: string;
}

/** onestop_catalog 的载荷（有损 / 无损格式清单；质量档不再由目录给出）。 */
export interface OnestopCatalog {
  lossyFormats: FormatEntry[];
  losslessFormats: FormatEntry[];
}

/** 阶梯项（onestop_quality_ladder / onestop_single_point_ladder 回包）。 */
export interface LadderItemDto {
  format: string;
  quality: number | null;
  label: string;
}

/** 目标大小方式的单点（质量 + 探测到的实际产物大小）。 */
export interface SizePoint {
  quality: number;
  bytes: number;
}

/** onestop_size_search 回包。 */
export interface SizeSearchDto {
  format: string;
  targetBytes: number;
  hit: SizePoint;
  note: string | null;
  points: SizePoint[];
}

/** onestop_encode 的产物（路径 + 编码参数文本，参数文本与 CLI 同源）。 */
export interface OnestopProduct {
  path: string;
  encodingParams: string;
}

/** onestop_encode 回包：done = 已生成；conflict = 「询问」策略下同名已存在、未写任何文件。 */
export type OnestopEncodeOutcome =
  | { kind: 'done'; product: OnestopProduct }
  | { kind: 'conflict'; proposedName: string };

// ---------- 高级创建（图片） ----------

/** advanced_encode 的单个编码任务（与核心库 AdvancedImageJob 一一对应）。 */
export interface AdvancedJobPayload {
  formatId: string;
  lossless: boolean;
  mode: 'quality' | 'size';
  quality: number;
  targetBytes: number;
  rows: {
    name: string;
    flag: string;
    value: string | null;
    note: string | null;
    enabled: boolean;
  }[];
}

/** advanced_encode 的产物。 */
export interface AdvancedProductDto {
  path: string;
  encodingParams: string;
  commandLine: string;
  note: string | null;
}

/** advanced_encode 回包（与 onestop_encode 同一套冲突协议）。 */
export type AdvancedEncodeOutcome =
  | { kind: 'done'; product: AdvancedProductDto }
  | { kind: 'conflict'; proposedName: string };

/** 把会话态的编码器条目转成后端任务载荷（单一转换点，避免各处手拼字段）。 */
export function jobPayloadOf(entry: AdvancedEntry): AdvancedJobPayload {
  return {
    formatId: entry.encoderId,
    lossless: entry.lossless,
    mode: entry.mode,
    quality: entry.quality,
    targetBytes: entry.targetBytes,
    rows: entry.rows.map((row) => ({
      name: row.name,
      flag: row.flag,
      value: row.value.trim() === '' ? null : row.value.trim(),
      note: row.note === '' ? null : row.note,
      enabled: row.enabled,
    })),
  };
}

// ---------- 原图标识 ----------

/** image_identities 回包的一行：读不到文件时 size/modified 为 null、error 给中文原因。 */
export interface ImageIdentityDto {
  path: string;
  sizeBytes: number | null;
  modifiedMs: number | null;
  error: string | null;
}

// ---------- 命令 ----------

export const ipc = {
  // -- 一站式 --
  onestopCatalog: (): Promise<OnestopCatalog> => invoke<OnestopCatalog>('onestop_catalog'),

  onestopQualityLadder: (baseline: number): Promise<LadderItemDto[]> =>
    invoke<LadderItemDto[]>('onestop_quality_ladder', { baseline }),

  onestopSinglePointLadder: (baseline: number): Promise<LadderItemDto[]> =>
    invoke<LadderItemDto[]>('onestop_single_point_ladder', { baseline }),

  onestopSizeSearch: (args: {
    groupId: string;
    roundId: string;
    referencePath: string;
    format: string;
    targetBytes: number;
  }): Promise<SizeSearchDto> =>
    invoke<SizeSearchDto>('onestop_size_search', {
      groupId: args.groupId,
      roundId: args.roundId,
      referencePath: args.referencePath,
      format: args.format,
      targetBytes: args.targetBytes,
    }),

  /** 生成一项产物；overwrite 只在冲突拍板后为 true。 */
  onestopEncode: (args: {
    groupId: string;
    roundId: string;
    referencePath: string;
    format: string;
    quality: number | null;
    overwrite?: boolean;
  }): Promise<OnestopEncodeOutcome> =>
    invoke<OnestopEncodeOutcome>('onestop_encode', {
      groupId: args.groupId,
      roundId: args.roundId,
      referencePath: args.referencePath,
      format: args.format,
      quality: args.quality,
      ...(args.overwrite ? { conflictDecision: 'overwrite' } : {}),
    }),

  // -- 高级创建（图片） --
  advancedImageCatalog: (): Promise<ImageSpec[]> => invoke<ImageSpec[]>('advanced_image_catalog'),

  /** 建轮 / 编码前的编码器可用性预检（与设置页 tool_status 同源）。 */
  advancedEncoderStatus: (keys: readonly string[]): Promise<ToolStatus[]> =>
    invoke<ToolStatus[]>('advanced_encoder_status', { keys: [...keys] }),

  advancedEncode: (args: {
    groupId: string;
    roundId: string;
    referencePath: string;
    job: AdvancedJobPayload;
    overwrite?: boolean;
  }): Promise<AdvancedEncodeOutcome> =>
    invoke<AdvancedEncodeOutcome>('advanced_encode', {
      groupId: args.groupId,
      roundId: args.roundId,
      referencePath: args.referencePath,
      conflictDecision: args.overwrite ? 'overwrite' : null,
      job: args.job,
    }),

  // -- 原图标识 --
  imageIdentities: (paths: readonly string[]): Promise<ImageIdentityDto[]> =>
    invoke<ImageIdentityDto[]>('image_identities', { paths: [...paths] }),
};
