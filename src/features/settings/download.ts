// FFmpeg 应用内下载：模块级任务，独立于设置面板的生命周期。
//
// 为什么不是面板内的局部状态：下载约几十 MB，用户完全可能中途关掉面板去看别的。
// 旧实现把进度写进已脱离文档的节点，关面板后既看不到进度、主界面警告条也不会更新，
// 还能再点一次导致两个下载写同一个临时文件（后端无互斥）。这里把任务提到模块级：
// 单飞、进度进 store（外壳顶栏 busy 徽标 + 状态栏都能看到）、完成后重探 FFmpeg，
// 面板重新打开时读到的仍是真实状态。

import { refreshFfmpeg } from '../../core/ffmpeg';
import { ipc } from '../../core/ipc';
import { beginBusy, endBusy, setStatus, updateBusy } from '../../core/store';
import { toast } from '../../ui/toast';
import { parseDownloadProgress } from './model';

export type DownloadPhase = 'idle' | 'downloading' | 'failed';

export interface DownloadState {
  phase: DownloadPhase;
  /** 后端最近一条进度原文（idle 时是上一次的结果说明）。 */
  text: string;
  /** 0–1；未知为 null。 */
  ratio: number | null;
  error: string | null;
}

const BUSY_ID = 'ffmpeg-download';
const BUSY_LABEL = '正在下载内置 FFmpeg';

const listeners = new Set<(state: DownloadState) => void>();
let state: DownloadState = { phase: 'idle', text: '', ratio: null, error: null };
let inflight: Promise<void> | null = null;

export function downloadState(): DownloadState {
  return state;
}

export function subscribeDownload(listener: (state: DownloadState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(next: DownloadState): void {
  state = next;
  for (const listener of [...listeners]) listener(state);
}

/** 是否已有下载在跑（按钮据此禁用，避免并发写同一个临时文件）。 */
export function isDownloading(): boolean {
  return inflight !== null;
}

/** 开始下载；已有任务在跑时直接复用，不会重复触发。 */
export function startFfmpegDownload(): void {
  if (inflight) return;
  inflight = run().finally(() => {
    inflight = null;
  });
  void inflight.catch(() => undefined);
}

async function run(): Promise<void> {
  emit({ phase: 'downloading', text: '准备下载…', ratio: null, error: null });
  beginBusy(BUSY_ID, BUSY_LABEL);
  setStatus('正在下载内置 FFmpeg…');
  try {
    await ipc.ffmpegDownload((message) => {
      const progress = parseDownloadProgress(message);
      emit({ phase: 'downloading', text: message, ratio: progress.ratio, error: null });
      // 进度落两处：外壳 busy 徽标的细节行 + 状态栏（面板关着也看得见）
      updateBusy(BUSY_ID, { detail: message });
      setStatus(message);
    });
    emit({ phase: 'idle', text: '内置 FFmpeg 已就绪', ratio: null, error: null });
    setStatus('内置 FFmpeg 已就绪');
    toast('内置 FFmpeg 已就绪', 'ok');
    // 下载完立刻重探：主界面警告条与设置页状态都不依赖「关面板」这个时机
    await refreshFfmpeg();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ phase: 'failed', text: '', ratio: null, error: message });
    setStatus(`下载内置 FFmpeg 失败：${message}`, { isError: true, detail: message });
    toast('下载失败', 'danger', {
      action: { label: '重试', onSelect: () => startFfmpegDownload() },
    });
  } finally {
    endBusy(BUSY_ID);
  }
}
