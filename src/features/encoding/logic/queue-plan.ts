// 队列条目的删除计划（纯逻辑，原 src/image-queue-panel.ts 的 planDelete 搬来）：
// 要不要连带删轮、确认文案怎么写。DOM 与 IPC 由调用方负责。

import type { ImageEntry, RoundSummary } from './entries';
import { fileName } from '../../../core/util';

/** 删条目的计划：要不要连带删轮 + 二次确认文案。 */
export interface DeletePlan {
  entryId: string;
  /** 条目文件名（确认文案与状态栏用）。 */
  fileName: string;
  /** 要连带删除的评测轮 id；null = 不动工作区（从没建过轮，或轮已不在工作区）。 */
  roundId: string | null;
  /** 确认卡片正文（点名轮名与结果条数，写明磁盘产物不删）。 */
  message: string;
}

/**
 * 算删一个条目的计划。
 *
 * 轮信息由宿主从工作区读（`describeRound`）：roundId 指向的轮若已经不在工作区
 * （用户在主界面删过），就不拿旧 id 去删——否则会得到一个「找不到评测轮」的错误，
 * 而条目其实已经只存在于会话里了。
 */
export function planDelete(entry: ImageEntry, round: RoundSummary | null): DeletePlan {
  const name = fileName(entry.path);
  const roundId = entry.roundId !== null && round !== null ? entry.roundId : null;
  const message =
    roundId !== null && round !== null
      ? `删除图片条目「${name}」？\n\n评测轮『${round.name}』与它的 ${round.candidateCount} 条跑分结果会一并删除；磁盘上的产物文件保留。`
      : `删除图片条目「${name}」？\n\n这个条目没有对应的评测轮（还没跑过，或轮已被删除），删除不会改动工作区；磁盘上的产物文件保留。`;
  return { entryId: entry.id, fileName: name, roundId, message };
}
