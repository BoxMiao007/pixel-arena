// 设置的保存通道：字段级合并 + 全局串行队列 + 保存后应用主题。
//
// 后端 settings_save 是「整份覆盖」，而界面里有三方会写设置：设置面板、选图后的
// 最近目录记录、主题切换。若各自拿打开时的快照整份提交，后写者会把别人刚改的字段
// 退回旧值（settings Phase A 的 R1）。这里统一成「以 store 里的最新设置为底，只合并
// 本次要改的字段」，并把并发保存串成一条队列，保证顺序与最终值可预期。
//
// 校验失败（后端跑中文错误串）时只报状态栏、不改内存里的设置；调用方决定要不要就地
// 保留用户输入（设置面板会保留）。

import { ipc } from './ipc';
import { getState, setSettings, setStatus } from './store';
import { applyTheme } from './theme';
import type { SettingsData } from './settings';

export type SettingsPatch =
  | Partial<SettingsData>
  | ((current: SettingsData) => Partial<SettingsData>);

let queue: Promise<unknown> = Promise.resolve();
let saving = 0;

/** 是否有保存在进行中（设置面板据此禁用重复提交 / 显示状态）。 */
export function isSavingSettings(): boolean {
  return saving > 0;
}

function enqueue(task: () => Promise<SettingsData | null>): Promise<SettingsData | null> {
  saving += 1;
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => {
    saving -= 1;
  });
}

/** 只改指定字段；其它字段以上一次保存后的最新设置为准。 */
export function saveSettingsPatch(patch: SettingsPatch): Promise<SettingsData | null> {
  return enqueue(async () => {
    const current = getState().settings;
    if (!current) return null;
    const fields = typeof patch === 'function' ? patch(current) : patch;
    return persist({ ...current, ...fields });
  });
}

/** 整份保存（重置为默认值时用）。 */
export function saveSettings(next: SettingsData): Promise<SettingsData | null> {
  return enqueue(() => persist(next));
}

async function persist(next: SettingsData): Promise<SettingsData | null> {
  try {
    const saved = await ipc.settingsSave(next);
    setSettings(saved);
    applyTheme(saved.theme);
    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`保存设置失败：${message}`, { isError: true, detail: message });
    return null;
  }
}
