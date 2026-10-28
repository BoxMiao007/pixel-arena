// FFmpeg 就绪状态：boot 后异步探测（后台跑 ffmpeg -version，5s 超时），
// 结果进 store；设置变更后强制重探。只影响视频跑分入口的提示与置灰，不阻塞图片流程。

import { ipc, type FFmpegCheck } from './ipc';
import { getState, setFfmpeg } from './store';

let inflight: Promise<FFmpegCheck> | null = null;

/** 当前探测结果（未探测前为 null，界面按「未知」处理，不提前报警）。 */
export function ffmpegStatus(): FFmpegCheck | null {
  return getState().ffmpeg;
}

/** FFmpeg 是否就绪；未探测完成前按 false（入口给提示但不禁用）。 */
export function ffmpegReady(): boolean {
  return getState().ffmpeg?.available === true;
}

/** 未就绪的中文原因（可直接展示）。 */
export function ffmpegReason(): string {
  const status = ffmpegStatus();
  if (!status) return '正在检测 FFmpeg…';
  return status.error ?? 'FFmpeg 未就绪：视频跑分前请先在设置页下载或指定路径。';
}

/** 重探 FFmpeg；并发调用复用同一次探测。 */
export async function refreshFfmpeg(): Promise<FFmpegCheck> {
  if (inflight) return inflight;
  inflight = (async () => {
    let result: FFmpegCheck;
    try {
      result = await ipc.ffmpegCheck();
    } catch (err) {
      // 检测 IPC 本身失败也按「未就绪」警示，但不编造后端原因
      console.warn('FFmpeg 检测失败:', err);
      result = { available: false, path: null, version: null, error: null };
    }
    setFfmpeg(result);
    return result;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
