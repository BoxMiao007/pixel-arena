// 单一状态源：工作区 / 设置 / FFmpeg 状态 / 长任务忙状态 / 状态栏。
//
// 单向数据流：任意动作 -> IPC -> 用返回的整份工作区替换 -> 通知订阅者 -> 各分区
// 调自己的 update()。不做前端乐观更新（后端是唯一真源），也不做局部拼装。
//
// 订阅者按分区注册：外壳、检视器、结果坞、舞台各订阅一份；每次通知都同步执行，
// 空闲时无开销。长任务进度（跑分逐项）会高频通知，分区 update() 必须廉价且幂等。

import { formatClock } from './format';
import type { Workspace } from './model';
import type { SettingsData } from './settings';
import type { FFmpegCheck } from './ipc';

/** 进行中的长任务（跑分 / 自动编码 / 视频跑分）。running 是逐项状态的路径集合。 */
export interface BusyEntry {
  /** 展示用动词，如「正在跑分」「正在自动编码」。 */
  label: string;
  /** 细节行，如「AVIF q75（5/12）」；空串表示只显示 label。 */
  detail: string;
  /** 正在处理、需要在行内显示「进行中」的路径集合。 */
  running: ReadonlySet<string>;
  /** 已知总量的确定进度（后端 Channel 回推的 completed/total）。 */
  completed?: number;
  total?: number;
}

export interface StatusEntry {
  text: string;
  /** 点击后弹出的完整内容（长错误、完整路径等）。 */
  detail: string;
  isError: boolean;
}

export interface AppState {
  workspace: Workspace | null;
  settings: SettingsData | null;
  ffmpeg: FFmpegCheck | null;
  coreVersion: string | null;
  /** 长任务表：id -> 条目。空表示空闲。 */
  busy: ReadonlyMap<string, BusyEntry>;
  status: StatusEntry;
  /** 最近一次保存成功的时刻（展示用）。 */
  savedAt: string | null;
}

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

const state: AppState = {
  workspace: null,
  settings: null,
  ffmpeg: null,
  coreVersion: null,
  busy: new Map(),
  status: { text: '', detail: '', isError: false },
  savedAt: null,
};

/** 当前状态（只读快照；不要就地改字段，走下面的 setter）。 */
export function getState(): AppState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch (err) {
      // 一个分区渲染失败不能连累其它分区（也不该冒泡成「工作区加载失败」）
      console.error('状态订阅者执行失败:', err);
    }
  }
}

/** 用后端返回的整份工作区替换本地状态；markSaved=false 用于启动时恢复（不是一次保存）。 */
export function setWorkspace(workspace: Workspace, options: { markSaved?: boolean } = {}): void {
  state.workspace = workspace;
  if (options.markSaved !== false) state.savedAt = formatClock();
  notify();
}

export function setSettings(settings: SettingsData): void {
  state.settings = settings;
  notify();
}

export function setFfmpeg(ffmpeg: FFmpegCheck): void {
  state.ffmpeg = ffmpeg;
  notify();
}

export function setCoreVersion(version: string): void {
  state.coreVersion = version;
  notify();
}

/** 状态栏：display 为单行展示文本，detail 为点击后弹出的完整内容。 */
export function setStatus(text: string, options: { detail?: string; isError?: boolean } = {}): void {
  state.status = {
    text,
    detail: options.detail ?? text,
    isError: options.isError ?? false,
  };
  notify();
}

/** 任一长任务在跑。 */
export function isBusy(): boolean {
  return state.busy.size > 0;
}

export function busyEntry(id: string): BusyEntry | undefined {
  return state.busy.get(id);
}

/** 路径是否正在被任何长任务处理（结果表 / 来源列表的行内状态）。 */
export function isPathRunning(path: string): boolean {
  for (const entry of state.busy.values()) {
    if (entry.running.has(path)) return true;
  }
  return false;
}

export function beginBusy(id: string, label: string, running: Iterable<string> = []): void {
  const next = new Map(state.busy);
  next.set(id, { label, detail: '', running: new Set(running) });
  state.busy = next;
  notify();
}

export function updateBusy(
  id: string,
  patch: {
    label?: string;
    detail?: string;
    running?: Iterable<string>;
    completed?: number;
    total?: number;
  },
): void {
  const current = state.busy.get(id);
  if (!current) return;
  const next = new Map(state.busy);
  next.set(id, {
    label: patch.label ?? current.label,
    detail: patch.detail ?? current.detail,
    running: patch.running ? new Set(patch.running) : current.running,
    completed: patch.completed ?? current.completed,
    total: patch.total ?? current.total,
  });
  state.busy = next;
  notify();
}

export function endBusy(id: string): void {
  if (!state.busy.has(id)) return;
  const next = new Map(state.busy);
  next.delete(id);
  state.busy = next;
  notify();
}

/** 统一收口「IPC 返回工作区」的动作；失败时把中文原因亮在状态栏并返回 null。 */
export async function runWorkspace(
  action: () => Promise<Workspace>,
  options: { success?: string } = {},
): Promise<Workspace | null> {
  try {
    const workspace = await action();
    setWorkspace(workspace);
    if (options.success) setStatus(options.success);
    return workspace;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`操作失败：${message}`, { isError: true, detail: message });
    return null;
  }
}
