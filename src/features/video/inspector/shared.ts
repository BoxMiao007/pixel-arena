// 视频检视器三个分区共用的小工具：读当前轮、分区折叠态持久化、打开设置、
// 并发度文案。无 DOM 构建，只有取数与偏好读写。

import { getState } from '../../../core/store';
import type { Round } from '../../../core/model';
import { getPref, setPref } from '../../../core/ui-state';
import { runCommand } from '../../../shell/registry';
import { toast } from '../../../ui/toast';

/** 从单一状态源取当前轮；分组类型必须是 video，否则 null。 */
export function videoRound(groupId: string, roundId: string): Round | null {
  const workspace = getState().workspace;
  const group = workspace?.groups.find((item) => item.id === groupId);
  if (!group || group.kind !== 'video') return null;
  return group.rounds.find((item) => item.id === roundId) ?? null;
}

/** 分区默认展开；用户折叠后按分区 id 持久化（界面偏好，不算会话状态）。 */
export function sectionOpen(id: string): boolean {
  return getPref('sections')[id] ?? true;
}

export function persistSectionOpen(id: string, open: boolean): void {
  setPref('sections', { ...getPref('sections'), [id]: open });
}

/** 打开设置（设置域注册 open-settings 命令；未接入时给一句提示，不静默）。 */
export function openSettings(): void {
  void runCommand('open-settings').then((handled) => {
    if (!handled) toast('设置面板还没有接入', 'danger');
  });
}

const CONCURRENCY_LABELS: Record<string, string> = {
  quarter: '1/4 逻辑核',
  half: '1/2 逻辑核',
  threequarters: '3/4 逻辑核',
  full: '全部逻辑核',
};

/** 并发度档位 → 中文说明（设置未加载时返回「默认」）。 */
export function concurrencyLabel(pref: string | null | undefined): string {
  if (!pref) return '默认';
  return CONCURRENCY_LABELS[pref] ?? pref;
}
