// 视频域 IPC 收口。
//
// core/ipc.ts 只收通用命令；lead 授权视频的六个命令在这里统一 invoke（仍保持
// 「唯一收口」：本域任何 invoke 都只出现在这个文件里）。高级创建另有两个只读命令
// （编码器目录 / 编码器可用性）同属本域，一并收在这里，避免面板里出现裸 invoke。
// 返回 Workspace 的命令一律交给调用方用 store.runWorkspace 写入单一状态源；
// 轮次创建 / 激活 / 备注走 core/ipc 的 ipc.roundCreate / roundActivate / roundSetNote。
//
// 注意：核心库的 VideoMeta 没有 rename_all，时长键是 snake_case 的 duration_secs；
// 这里归一成 camelCase，兼容后端将来改名（两个键都认）。

import { Channel, invoke } from '@tauri-apps/api/core';
import type { ToolStatus } from '../../core/settings';
import type { Workspace } from '../../core/model';
import type { AdvancedVideoCatalog } from './advanced/catalog';

/** ffprobe 读到的视频元信息（fps / durationSecs 为 0 表示未知）。 */
export interface VideoMeta {
  width: number;
  height: number;
  fps: number;
  durationSecs: number;
}

/** 整轮跑分的进度（completed/total，无逐段信息）。 */
export interface VideoScoreProgress {
  completed: number;
  total: number;
}

/** 后端 VideoMeta 的原始形状（serde 直出，时长键为 snake_case）。 */
interface RawVideoMeta {
  width: number;
  height: number;
  fps: number;
  duration_secs?: number;
  durationSecs?: number;
}

export const videoIpc = {
  /** 选入/替换原视频（覆盖语义：旧跑分结果作废，体积比重算）。 */
  setReference(groupId: string, roundId: string, path: string): Promise<Workspace> {
    return invoke<Workspace>('round_set_video_reference', { groupId, roundId, path });
  },

  /** 追加若干段跑分视频（后端去重；任一文件不存在则整批失败）。 */
  addCandidates(groupId: string, roundId: string, paths: readonly string[]): Promise<Workspace> {
    return invoke<Workspace>('round_add_video_candidates', {
      groupId,
      roundId,
      paths: [...paths],
    });
  },

  /** 从本轮移除一段跑分视频。 */
  removeCandidate(
    groupId: string,
    roundId: string,
    candidatePath: string,
  ): Promise<Workspace> {
    return invoke<Workspace>('round_remove_video_candidate', {
      groupId,
      roundId,
      candidatePath,
    });
  },

  /** 整轮并行跑分；进度经 Channel 回推 N/M。 */
  scoreCandidates(options: {
    groupId: string;
    roundId: string;
    onProgress?: (progress: VideoScoreProgress) => void;
  }): Promise<Workspace> {
    const channel = new Channel<VideoScoreProgress>();
    if (options.onProgress) channel.onmessage = options.onProgress;
    return invoke<Workspace>('round_score_video_candidates', {
      groupId: options.groupId,
      roundId: options.roundId,
      onProgress: channel,
    });
  },

  /** ffprobe 读宽高/帧率/时长。后端保留 onProgress 参数（当前不产生消息），必须传通道。 */
  async probeMeta(path: string): Promise<VideoMeta> {
    const raw = await invoke<RawVideoMeta>('video_probe_meta', {
      path,
      onProgress: new Channel<string>(),
    });
    return {
      width: raw.width,
      height: raw.height,
      fps: raw.fps,
      durationSecs: raw.duration_secs ?? raw.durationSecs ?? 0,
    };
  },

  /** 把文件注册到应用内回环流服务，返回 <video> 可用的本地地址。 */
  streamUrl(path: string): Promise<string> {
    return invoke<string>('video_stream_url', { path });
  },

  /** 高级创建的视频编码器目录：ffmpeg 可用性 + 实际枚举 + 四条静态映射规格。 */
  advancedVideoCatalog(): Promise<AdvancedVideoCatalog> {
    return invoke<AdvancedVideoCatalog>('advanced_video_catalog');
  },

  /** 建轮前批量查编码器可执行文件可用性（与设置页 tool_status 同源）。 */
  advancedEncoderStatus(keys: readonly string[]): Promise<ToolStatus[]> {
    return invoke<ToolStatus[]>('advanced_encoder_status', { keys: [...keys] });
  },
};
