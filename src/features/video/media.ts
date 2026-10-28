// 视频媒体服务：流地址、隐藏元素池、解码缓存、seek 汇聚。
//
// 为什么这么设计（规格 §5.1–5.3）：
// - Linux WebKitGTK 的媒体引擎不走 asset 自定义协议（SRC_NOT_SUPPORTED），视频统一从
//   应用内回环 HTTP 服务拉流（IPC video_stream_url）；
// - 部分内核对「不在文档里的媒体元素」解码不可靠，所以 <video> 常驻 body 下的离屏池，
//   永不脱离文档；
// - 逐帧对比永远暂停态，画面只随 seek 变化；多路同时 seek 必须等全部 seeked 到齐
//   再重绘，否则两路会错帧；超时（坏文件）返回 stale，由舞台如实标注而不是假装同步；
// - 会话级缓存 + 显式 releaseUnused/trim：候选被移除或超过上限时释放解码器，
//   长会话不会无限堆积 <video>。
//
// 本模块是进程内唯一的 <video> 持有者；舞台/检视器只读 snapshot 与 element。

import { streamErrorMessage } from './errors';
import { videoIpc, type VideoMeta } from './video-ipc';

export type MediaStatus = 'loading' | 'ready' | 'error';

/** 只读快照：调用方不得持有内部对象，避免与缓存生命周期耦合。 */
export interface VideoSnapshot {
  path: string;
  status: MediaStatus;
  width: number;
  height: number;
  duration: number;
  /** ffprobe 帧率；null = 未知（探测失败或仍在探测），逐帧步进禁用。 */
  fps: number | null;
  meta: VideoMeta | null;
  /** MediaError.code（0 = 未报错）。 */
  errorCode: number;
  /** 流地址失败的中文原因（与 MediaError 文案二选一展示）。 */
  errorText: string | null;
  /** ffprobe 失败的原因（不致命，只影响步进）。 */
  probeError: string | null;
}

interface Entry {
  path: string;
  status: MediaStatus;
  el: HTMLVideoElement | null;
  width: number;
  height: number;
  duration: number;
  fps: number | null;
  meta: VideoMeta | null;
  errorCode: number;
  errorText: string | null;
  probeError: string | null;
  /** 最近使用序号（trim 按最旧释放）。 */
  seq: number;
}

/** seek 判等阈值：小于 0.5ms 视为已在该时间点（含刚 seek 完）。 */
const SEEK_EPSILON = 5e-4;
/** seeked 迟迟不来（坏文件/长 GOP）时的兜底：超时按 stale 处理。 */
const SEEK_TIMEOUT_MS = 2000;
/** 会话内最多保留的解码实例数：候选多时只留最近用过的若干段。 */
export const MAX_DECODED_VIDEOS = 8;

const entries = new Map<string, Entry>();
const mediaListeners = new Set<() => void>();
let pool: HTMLDivElement | null = null;
let seqCounter = 0;

function notifyMedia(): void {
  for (const listener of [...mediaListeners]) {
    try {
      listener();
    } catch (err) {
      console.error('视频媒体状态通知失败:', err);
    }
  }
}

/** 订阅任何一路视频的状态变化（ready/error/探测完成）。 */
export function subscribeMedia(listener: () => void): () => void {
  mediaListeners.add(listener);
  return () => mediaListeners.delete(listener);
}

/** 离屏元素池：挂在 body 下、移出屏幕但不脱离文档（WebKitGTK 解码要求）。 */
function ensurePool(): HTMLDivElement {
  if (!pool || !pool.isConnected) {
    pool = document.createElement('div');
    pool.className = 'video-media-pool';
    pool.setAttribute('aria-hidden', 'true');
    document.body.appendChild(pool);
  }
  return pool;
}

function snapshotOf(entry: Entry): VideoSnapshot {
  return {
    path: entry.path,
    status: entry.status,
    width: entry.width,
    height: entry.height,
    duration: entry.duration,
    fps: entry.fps,
    meta: entry.meta,
    errorCode: entry.errorCode,
    errorText: entry.errorText,
    probeError: entry.probeError,
  };
}

/** 只读查询：该路径若已在加载/解码，返回快照；否则 null。 */
export function peekVideo(path: string): VideoSnapshot | null {
  const entry = entries.get(path);
  return entry ? snapshotOf(entry) : null;
}

/** 绘制用的原始 <video>（仅 status=ready 时非 null）。 */
export function videoElement(path: string): HTMLVideoElement | null {
  const entry = entries.get(path);
  return entry && entry.status === 'ready' ? entry.el : null;
}

function settleReady(entry: Entry): void {
  const el = entry.el;
  if (!el) return;
  entry.status = 'ready';
  // 元素尺寸优先；个别内核 loadeddata 时仍未给出尺寸，保留 ffprobe 先填的值。
  if (el.videoWidth > 0) {
    entry.width = el.videoWidth;
    entry.height = el.videoHeight;
  }
  const elementDuration = el.duration;
  entry.duration =
    Number.isFinite(elementDuration) && elementDuration > 0
      ? elementDuration
      : (entry.meta?.durationSecs ?? 0);
  notifyMedia();
}

function createEntry(path: string): Entry {
  const entry: Entry = {
    path,
    status: 'loading',
    el: null,
    width: 0,
    height: 0,
    duration: 0,
    fps: null,
    meta: null,
    errorCode: 0,
    errorText: null,
    probeError: null,
    seq: ++seqCounter,
  };
  entries.set(path, entry);

  const el = document.createElement('video');
  el.className = 'video-media';
  el.muted = true;
  el.preload = 'auto';
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('playsinline', '');
  entry.el = el;
  ensurePool().appendChild(el);

  const current = (): boolean => entries.get(path) === entry;

  el.addEventListener('loadeddata', () => {
    if (!current()) return;
    settleReady(entry);
  });
  el.addEventListener('error', () => {
    if (!current()) return;
    entry.errorCode = el.error?.code ?? 0;
    entry.status = 'error';
    notifyMedia();
  });

  // 流地址就绪后才开始加载（注册是同步 IPC，几十微秒级）；失败必须可见，
  // 否则元素会永远停在 loading（旧实现没有 catch，是真 bug）。
  void videoIpc
    .streamUrl(path)
    .then((url) => {
      if (!current()) return;
      el.src = url;
    })
    .catch((err: unknown) => {
      if (!current()) return;
      entry.status = 'error';
      entry.errorText = streamErrorMessage(path, err);
      notifyMedia();
    });

  // 帧率探测与加载并行；失败只记原因，不影响查看与时间轴（元信息可降级）。
  void videoIpc
    .probeMeta(path)
    .then((meta) => {
      if (!current()) return;
      entry.meta = meta;
      entry.fps = meta.fps > 0 ? meta.fps : null;
      // 元信息与元素解码两条路互补：元素还没 loadeddata（或内核不给 videoWidth）时，
      // 先用 ffprobe 的宽高填上，检视器才不会在解码完成前一直显示「—」。
      if (entry.width === 0 && meta.width > 0) entry.width = meta.width;
      if (entry.height === 0 && meta.height > 0) entry.height = meta.height;
      if (!(entry.duration > 0) && meta.durationSecs > 0) entry.duration = meta.durationSecs;
      notifyMedia();
    })
    .catch((err: unknown) => {
      if (!current()) return;
      entry.probeError = err instanceof Error ? err.message : String(err);
      notifyMedia();
    });

  return entry;
}

/** 释放一路解码实例（移除元素、断开流）。 */
function releaseEntry(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  entries.delete(path);
  const el = entry.el;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    // load() 让内核真正释放解码器与网络连接；不触发用户可见错误。
    try {
      el.load();
    } catch {
      // 个别内核对空 load 抛错，忽略即可。
    }
    el.remove();
  }
  notifyMedia();
}

/**
 * 媒体服务实例：一次舞台挂载一份，负责显式 acquire / seek / releaseUnused / destroy。
 * 解码缓存是进程级共享的（切轮回来不用重新解码），实例只管理自己的等待与订阅。
 */
export class MediaService {
  private disposed = false;
  private seekWaiters = new Set<() => void>();

  /** 确保该路径开始加载并返回当前快照。 */
  acquire(path: string): VideoSnapshot {
    const entry = entries.get(path) ?? createEntry(path);
    entry.seq = ++seqCounter;
    return snapshotOf(entry);
  }

  /** 多路同时 seek；全部 seeked 返回 ok，超时返回 stale（调用方如实标注）。 */
  seekAll(paths: readonly string[], time: number): Promise<'ok' | 'stale'> {
    if (this.disposed) return Promise.resolve('stale');
    const targets: HTMLVideoElement[] = [];
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry || entry.status !== 'ready' || !entry.el) continue;
      if (Math.abs(entry.el.currentTime - time) < SEEK_EPSILON) continue;
      targets.push(entry.el);
    }
    if (targets.length === 0) return Promise.resolve('ok');

    for (const el of targets) {
      try {
        el.currentTime = time;
      } catch {
        // 个别容器在未就绪时拒绝设置 currentTime：等下一次 ready 再对齐。
      }
    }

    return new Promise<'ok' | 'stale'>((resolve) => {
      let remaining = targets.length;
      let finished = false;
      const cleanupFns: (() => void)[] = [];

      const finish = (result: 'ok' | 'stale'): void => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        for (const fn of cleanupFns) fn();
        this.seekWaiters.delete(cancel);
        resolve(result);
      };
      // 舞台销毁时立即结束等待，避免 Promise 永远悬着。
      const cancel = (): void => finish('stale');
      this.seekWaiters.add(cancel);

      const timer = window.setTimeout(() => finish('stale'), SEEK_TIMEOUT_MS);
      for (const el of targets) {
        const onSeeked = (): void => {
          remaining -= 1;
          if (remaining <= 0) finish('ok');
        };
        el.addEventListener('seeked', onSeeked);
        cleanupFns.push(() => el.removeEventListener('seeked', onSeeked));
      }
    });
  }

  /** 释放不在 keep 里的解码实例（候选被移除、切轮）：解码器与流一并回收。 */
  releaseUnused(keep: readonly string[]): void {
    const kept = new Set(keep);
    for (const path of [...entries.keys()]) {
      if (!kept.has(path)) releaseEntry(path);
    }
  }

  /** 只保留最近用过的 max 个实例（按 seq 最旧优先释放，keep 里的永不动）。 */
  trim(max: number = MAX_DECODED_VIDEOS, keep: readonly string[] = []): void {
    const kept = new Set(keep);
    const candidates = [...entries.entries()]
      .filter(([path, entry]) => !kept.has(path) && entry.status !== 'loading')
      .sort((a, b) => a[1].seq - b[1].seq);
    let excess = entries.size - max;
    for (const [path] of candidates) {
      if (excess <= 0) return;
      releaseEntry(path);
      excess -= 1;
    }
  }

  /** 加载失败后的「重试」：丢掉缓存，下次 acquire 重新拉流/解码。 */
  invalidate(path: string): void {
    releaseEntry(path);
  }

  /** 舞台卸载：结束所有等待；解码缓存留给下次挂载复用（trim 在上层调用）。 */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.seekWaiters]) cancel();
    this.seekWaiters.clear();
  }
}
