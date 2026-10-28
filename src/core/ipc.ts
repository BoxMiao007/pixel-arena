// IPC 收口（核心域）：工作区、分组、轮次、设置、FFmpeg、版本。
// 各功能域的专属命令（一站式、高级创建、视频、导出）收口在各自目录的
// ipc 模块里，但同样禁止在组件里裸调 invoke——参数形状与返回类型集中在一处。
//
// 约定：任何返回 Workspace 的命令都代表「后端已落盘」，调用方统一喂给 store.setWorkspace。

import { Channel, invoke } from '@tauri-apps/api/core';
import type { GroupKind, Workspace } from './model';
import type { AboutData, SettingsData, ToolStatus } from './settings';

/** FFmpeg 探测结果（与后端 FFmpegDetection serde camelCase 一致）。 */
export interface FFmpegCheck {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
}

/** 整轮跑分的进度事件（后端逐项推送）。 */
export interface ScoreProgress {
  completed: number;
  total: number;
}

/** 跑分图片时可选地只重算指定路径子集；省略 paths = 整轮全量。 */
export interface ScoreCandidatesArgs {
  groupId: string;
  roundId: string;
  paths?: readonly string[];
  onProgress?: (progress: ScoreProgress) => void;
}

export const ipc = {
  coreVersion: (): Promise<string> => invoke<string>('core_version'),

  workspaceLoad: (): Promise<Workspace> => invoke<Workspace>('workspace_load'),

  groupCreate: (name: string, kind: GroupKind): Promise<Workspace> =>
    invoke<Workspace>('group_create', { name, kind }),
  groupRename: (id: string, name: string): Promise<Workspace> =>
    invoke<Workspace>('group_rename', { id, name }),
  groupClose: (id: string): Promise<Workspace> => invoke<Workspace>('group_close', { id }),
  groupActivate: (id: string): Promise<Workspace> => invoke<Workspace>('group_activate', { id }),

  roundCreate: (groupId: string, name: string): Promise<Workspace> =>
    invoke<Workspace>('round_create', { groupId, name }),
  roundRename: (groupId: string, roundId: string, name: string): Promise<Workspace> =>
    invoke<Workspace>('round_rename', { groupId, roundId, name }),
  roundDelete: (groupId: string, roundId: string): Promise<Workspace> =>
    invoke<Workspace>('round_delete', { groupId, roundId }),
  roundActivate: (groupId: string, roundId: string): Promise<Workspace> =>
    invoke<Workspace>('round_activate', { groupId, roundId }),

  roundSetReference: (groupId: string, roundId: string, path: string): Promise<Workspace> =>
    invoke<Workspace>('round_set_reference', { groupId, roundId, path }),
  roundAddCandidates: (
    groupId: string,
    roundId: string,
    paths: readonly string[],
    encodingParams?: readonly string[],
  ): Promise<Workspace> =>
    invoke<Workspace>('round_add_candidates', {
      groupId,
      roundId,
      paths: [...paths],
      ...(encodingParams ? { encodingParams: [...encodingParams] } : {}),
    }),
  roundRemoveCandidate: (
    groupId: string,
    roundId: string,
    candidatePath: string,
  ): Promise<Workspace> =>
    invoke<Workspace>('round_remove_candidate', { groupId, roundId, candidatePath }),
  roundClearCandidates: (groupId: string, roundId: string): Promise<Workspace> =>
    invoke<Workspace>('round_clear_candidates', { groupId, roundId }),
  roundSetNote: (groupId: string, roundId: string, note: string | null): Promise<Workspace> =>
    invoke<Workspace>('round_set_note', { groupId, roundId, note }),
  roundSetCandidateNote: (
    groupId: string,
    roundId: string,
    candidatePath: string,
    note: string | null,
  ): Promise<Workspace> =>
    invoke<Workspace>('round_set_candidate_note', { groupId, roundId, candidatePath, note }),

  /** 整轮（或子集）跑分；进度经 Channel 回推。 */
  roundScoreCandidates: (args: ScoreCandidatesArgs): Promise<Workspace> => {
    const channel = new Channel<ScoreProgress>();
    if (args.onProgress) channel.onmessage = args.onProgress;
    const payload: Record<string, unknown> = {
      groupId: args.groupId,
      roundId: args.roundId,
      onProgress: channel,
    };
    if (args.paths !== undefined) payload.paths = [...args.paths];
    return invoke<Workspace>('round_score_candidates', payload);
  },

  settingsLoad: (): Promise<SettingsData> => invoke<SettingsData>('settings_load'),
  settingsSave: (settings: SettingsData): Promise<SettingsData> =>
    invoke<SettingsData>('settings_save', { settings }),
  settingsToolStatus: (): Promise<ToolStatus[]> =>
    invoke<ToolStatus[]>('settings_tool_status'),
  aboutInfo: (): Promise<AboutData> => invoke<AboutData>('about_info'),

  ffmpegCheck: (): Promise<FFmpegCheck> => invoke<FFmpegCheck>('ffmpeg_check'),
  ffmpegDownload: (onProgress: (message: string) => void): Promise<string> => {
    const channel = new Channel<string>();
    channel.onmessage = onProgress;
    return invoke<string>('ffmpeg_download', { onProgress: channel });
  },
};
