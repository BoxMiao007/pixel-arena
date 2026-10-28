// encoding 域的注册入口：5 个检视器分区 + 5 个命令 + 分组关闭时的会话态清理。
//
// 外壳只认 shell/registry 的注册表；本域不 import 外壳的界面代码，只调注册函数。
// 注册幂等：main 显式调用与模块副作用各一次都不会重复挂。
//
// 命令 id 与外壳的 runKindCommand 约定一致（前缀 + `-<groupKind>`）：
// runKindCommand('pick-reference', 'image') → pick-reference-image。

import { onGroupRemoved } from '../../core/actions';
import { activeRound } from '../../core/model';
import { getState, isBusy } from '../../core/store';
import { registerCommand, registerPanelSection } from '../../shell/registry';
import {
  generateLadder,
  pickCandidates,
  pickReference,
  runChangedEntries,
  runFullScore,
  type RoundCtx,
} from './actions';
import { dropImageQueue } from './logic/entries';
import { ladderStateFor } from './session';
import { advancedSection } from './sections/advanced';
import { candidatesSection } from './sections/candidates';
import { ladderSection } from './sections/ladder';
import { referenceSection } from './sections/reference';
import { scoreSection } from './sections/score';

/** 当前激活轮；没有（空工作区 / 组里没有轮）时返回 null。 */
function current(): RoundCtx | null {
  const session = activeRound(getState().workspace);
  return session === null ? null : { group: session.group, round: session.round };
}

function hasReference(): boolean {
  return current()?.round.referencePath != null;
}

function hasCandidates(): boolean {
  return (current()?.round.candidates.length ?? 0) > 0;
}

let registered = false;

/** 注册本域全部分区与命令（幂等）。 */
export function registerEncoding(): void {
  if (registered) return;
  registered = true;

  registerPanelSection(referenceSection);
  registerPanelSection(candidatesSection);
  registerPanelSection(scoreSection);
  registerPanelSection(ladderSection);
  registerPanelSection(advancedSection);

  registerCommand({
    id: 'pick-reference-image',
    run: () => {
      const ctx = current();
      if (ctx) return pickReference(ctx);
    },
  });

  registerCommand({
    id: 'pick-candidates-image',
    run: () => {
      const ctx = current();
      if (ctx) return pickCandidates(ctx);
    },
  });

  registerCommand({
    id: 'run-score-image',
    enabled: () => !isBusy() && hasReference() && hasCandidates(),
    run: () => {
      const ctx = current();
      if (ctx) void runFullScore(ctx);
    },
  });

  registerCommand({
    id: 'rerun-changed-image',
    enabled: () => !isBusy(),
    run: () => {
      const ctx = current();
      if (ctx) void runChangedEntries(ctx.group.id);
    },
  });

  registerCommand({
    id: 'generate-ladder-image',
    enabled: () => !isBusy() && hasReference(),
    run: () => {
      const ctx = current();
      if (ctx) void generateLadder(ctx, ladderStateFor(ctx.round.id));
    },
  });

  // 跑分组关闭：丢弃该组的条目队列（组 id 不复用，留着只会白占内存）
  onGroupRemoved((groupId) => dropImageQueue(groupId));
}

registerEncoding();
