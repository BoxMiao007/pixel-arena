// 视频错误文案（纯函数，无 DOM）。
//
// 两类来源：
// - <video> 的 MediaError.code：读不到 / 缺解码器 / 格式不支持；
// - 流地址或 ffprobe 失败：后端返回的中文原因（原样展示，不吞）。
//
// 文案口径（规格 §1.9）：code 2 指向文件，code 3/4 指向系统解码能力；两者给出的
// 下一步不同，不能混成一句「加载失败」。

import { fileName } from '../../core/util';

/** MediaError.code → 中文提示（可直接展示）。 */
export function videoLoadErrorMessage(code: number, path: string): string {
  const name = fileName(path);
  switch (code) {
    case 2:
      return `视频加载失败：${name} 无法读取，可能已被移动、重命名或删除`;
    case 3:
      return `视频解码失败：${name} 的编码格式系统缺少解码器（如 H.264 需安装 gst-libav）`;
    case 4:
      return `视频格式不支持：${name} 不是有效的视频文件，或文件已被移动`;
    default:
      return `视频加载失败：${name} 格式可能不受支持或已被移动、删除`;
  }
}

/** 流地址获取失败（video_stream_url 报错）：后端原因原样附在后面。 */
export function streamErrorMessage(path: string, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `视频无法打开：${fileName(path)} 的本地流地址获取失败（${detail}）`;
}

/** ffprobe 不可用时的降级说明：告诉用户去哪儿补，而不是只把按钮灰掉。 */
export function probeUnavailableHint(): string {
  return '帧率未知：逐帧步进需要 ffprobe，请在「设置 → FFmpeg（视频跑分）」应用内下载或指定路径';
}

/** 探测失败的简短原因（附在提示后，避免吞掉后端中文错误）。 */
export function probeFailureHint(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `读取视频信息失败：${detail}`;
}
