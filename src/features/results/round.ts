// 按轮取当前数据：结果坞里各页签都只认自己那一轮，避免状态通知打到别的轮上。
import type { Round } from '../../core/model';
import { getState } from '../../core/store';

export function liveRound(roundId: string): Round | null {
  const workspace = getState().workspace;
  if (!workspace) return null;
  for (const group of workspace.groups) {
    const round = group.rounds.find((item) => item.id === roundId);
    if (round) return round;
  }
  return null;
}
