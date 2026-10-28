// 界面偏好与「按轮隔离」的会话状态。
//
// 两类状态严格分开：
// - 界面偏好（栏宽、折叠态、查看器模式、分区展开）是全局的，存 localStorage；
// - 会话状态（排序、编码阶梯参数、逐模式选图）以评测轮 id 为键存在模块内 Map，
//   切轮不串扰、重启归零。
//
// 「记住上次状态」关闭时（settings.recordState === false）既不读也不写 localStorage，
// 与工作区文件的干净启动口径一致。

import { getState } from './store';

export interface UiPrefs {
  railCollapsed: boolean;
  inspectorCollapsed: boolean;
  dockCollapsed: boolean;
  /** 结果坞高度（px）。 */
  dockHeight: number;
  /** 检视器各分区的展开态，键为分区 id。 */
  sections: Record<string, boolean>;
  /** 查看器上次使用的模式（分屏 / 滑动 / …）。 */
  viewerMode: string;
  /** 结果表显示哪些列（null = 默认列集）。 */
  resultsColumns: string[] | null;
}

export const UI_DEFAULTS: UiPrefs = {
  railCollapsed: false,
  inspectorCollapsed: false,
  dockCollapsed: false,
  dockHeight: 232,
  sections: {},
  viewerMode: 'split',
  resultsColumns: null,
};

const PREFIX = 'pixel-arena.ui.';

/** 记录状态开启才允许读写本地界面偏好。设置尚未加载时按「允许」处理。 */
function canPersist(): boolean {
  const settings = getState().settings;
  return settings === null || settings.recordState;
}

function readRaw<T>(key: string, fallback: T): T {
  if (!canPersist()) return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  return readRaw<UiPrefs[K]>(key, UI_DEFAULTS[key]);
}

export function setPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
  if (!canPersist()) return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存储不可用（隐私模式 / 配额满）时界面照常工作，只是不记忆。
  }
}

// ---------- 按评测轮隔离的会话状态 ----------

const scoped = new Map<string, Map<string, unknown>>();

/** 取某轮某命名空间的状态；首次访问用 init 创建。 */
export function roundScoped<T>(namespace: string, roundId: string, init: () => T): T {
  let byRound = scoped.get(namespace);
  if (!byRound) {
    byRound = new Map();
    scoped.set(namespace, byRound);
  }
  if (!byRound.has(roundId)) byRound.set(roundId, init());
  return byRound.get(roundId) as T;
}

/** 丢弃某轮的全部会话状态（删除轮次时调用，避免 id 复用串味）。 */
export function dropRoundScoped(roundId: string): void {
  for (const byRound of scoped.values()) byRound.delete(roundId);
}

// ---------- 当前选中的跑分图（跨域联动：结果表行 / 胶片条 / 查看器） ----------

const activeCandidates = new Map<string, string | null>();

/** 本轮当前聚焦的跑分图（结果表行点击、胶片条点击都写这里）。 */
export function getActiveCandidate(roundId: string): string | null {
  return activeCandidates.get(roundId) ?? null;
}

export function setActiveCandidate(roundId: string, path: string | null): void {
  activeCandidates.set(roundId, path);
}
