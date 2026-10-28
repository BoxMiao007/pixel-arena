// 工具状态（FFmpeg 与五个编码器）的加载与「软超时」。
//
// 后端 settings_tool_status 会对每个工具跑一次 `--version`/`-version` 子进程，而且
// 这条探测路径**没有超时**：外部路径指向挂死的程序时请求可以永不返回。设置面板
// 因此自己加一层 8 秒软超时——到点显示「检测超时，可重试」，并把这次请求作废，
// 晚到的结果直接丢弃（不覆盖用户已经看到的新状态）。

import { ipc } from '../../core/ipc';
import type { ToolStatus } from '../../core/settings';

export type ToolsPhase = 'loading' | 'ready' | 'timeout' | 'error';

export interface ToolsSnapshot {
  phase: ToolsPhase;
  /** 最近一次成功的结果；刷新中保留旧值，避免徽标在「检测中…」与结果之间来回闪。 */
  statuses: ReadonlyMap<string, ToolStatus> | null;
  /** IPC 失败原因（phase === 'error' 时有值）。 */
  error: string | null;
}

export interface ToolsWatcher {
  snapshot(): ToolsSnapshot;
  refresh(): void;
  subscribe(listener: (snapshot: ToolsSnapshot) => void): () => void;
  destroy(): void;
}

/** 软超时（毫秒）：超过就当作超时并在界面给出重试出口。 */
export const TOOL_STATUS_TIMEOUT_MS = 8000;

export interface ToolsWatcherOptions {
  /** 注入点（测试用）；默认走 IPC。 */
  load?: () => Promise<ToolStatus[]>;
  timeoutMs?: number;
}

/** 建一个工具状态观察器：面板打开时创建，关闭时 destroy（作废在途请求）。 */
export function createToolsWatcher(options: ToolsWatcherOptions = {}): ToolsWatcher {
  const load = options.load ?? (() => ipc.settingsToolStatus());
  const timeoutMs = options.timeoutMs ?? TOOL_STATUS_TIMEOUT_MS;

  let snapshot: ToolsSnapshot = { phase: 'loading', statuses: null, error: null };
  const listeners = new Set<(snapshot: ToolsSnapshot) => void>();
  /** 每次刷新 +1；在途请求与超时回调只在代数相同时才允许写状态。 */
  let attempt = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const emit = (next: ToolsSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener(snapshot);
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    globalThis.clearTimeout(timer);
    timer = null;
  };

  const refresh = (): void => {
    attempt += 1;
    const mine = attempt;
    clearTimer();
    emit({ phase: 'loading', statuses: snapshot.statuses, error: null });

    timer = globalThis.setTimeout(() => {
      if (mine !== attempt) return;
      attempt += 1; // 作废在途请求：晚到的结果不再写状态
      timer = null;
      emit({ phase: 'timeout', statuses: snapshot.statuses, error: null });
    }, timeoutMs);

    load().then(
      (list) => {
        if (mine !== attempt) return;
        clearTimer();
        emit({ phase: 'ready', statuses: new Map(list.map((item) => [item.key, item])), error: null });
      },
      (err: unknown) => {
        if (mine !== attempt) return;
        clearTimer();
        emit({
          phase: 'error',
          statuses: snapshot.statuses,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  };

  return {
    snapshot: () => snapshot,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      attempt += 1;
      clearTimer();
      listeners.clear();
    },
  };
}
