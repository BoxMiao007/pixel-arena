// encoding 域的动作层：来源选择、跑分、一站式生成、参数变体的宿主接线。
//
// 分三层，谁也不跳层：
// - 本文件（动作）：读 store → 调 IPC → 写 store → 状态栏；不含 DOM 结构；
// - logic/*（纯逻辑）：计划 / 判定 / 编排，零 DOM、零 store；
// - sections/* 与 overlay/*（界面）：只组合原语并调用这里。
//
// 忙状态统一用 store.busy 的任务 id（`score:<轮>` / `ladder:<轮>`），
// 所有入口都先查 isBusy，避免长任务重复触发（后端不可取消，见规格 §5.1）。

import {
  beginBusy,
  endBusy,
  getState,
  isBusy,
  setStatus,
  setWorkspace,
  updateBusy,
} from '../../core/store';
import { ipc as coreIpc } from '../../core/ipc';
import { errorText } from '../../core/util';
import {
  addCandidates,
  chooseCandidates,
  chooseReference,
  removeCandidate,
  setRoundReference,
} from '../../core/actions';
import type { Group, Round, Workspace } from '../../core/model';
import type { ToolStatus } from '../../core/settings';
import {
  entryForArtifact,
  forgetArtifact,
  imageQueueFor,
  newVariant,
  planScore,
  removeImageEntry,
  syncEntryReference,
  variantSummary,
  type ImageEntry,
  type RoundSummary,
} from './logic/entries';
import type { ImageSpec } from './logic/advanced';
import {
  queueEditorDeps,
  queueIdentityProbe,
  refreshQueueIdentities,
  runQueuePlanOnce,
  type ImageEntryEditorDeps,
  type QueueEditorHostDeps,
  type QueueRuntimeDeps,
} from './logic/runtime';
import { candidatesNeedingScore, type ScoredCandidate } from './logic/run';
import {
  LOSSLESS_FORMATS,
  LOSSY_FORMATS,
  fetchQualityLadder,
  initOnestopCatalog,
  fetchSinglePointLadder,
  runLadder,
  searchSizeFormat,
  sizeOutcomeLadder,
  type LadderItem,
} from './logic/ladder';
import { ipc, jobPayloadOf } from './ipc';
import { runCommand } from '../../shell/registry';
import {
  ladderKeyOf,
  planItemsOf,
  sizeSearchComplete,
  syncLadderKey,
  type LadderUiState,
} from './session';
import { askConflictDialog } from './overlay/conflict';
import { showEncoderIssueCard } from './overlay/encoder-issue';
import { showNoticeCard } from './overlay/notice';

/** 一个评测轮的最小上下文（与 shell/registry 的 ViewCtx 同形）。 */
export interface RoundCtx {
  group: Group;
  round: Round;
}

/** 长任务 id（同一轮同一类任务只允许一个）。 */
export type BusyScope = 'score' | 'ladder';

export function busyIdOf(scope: BusyScope, key: string): string {
  return `${scope}:${key}`;
}

/** 统一状态栏出口：错误带 detail（点开看全文），成功只留一行。 */
export function status(text: string, isError = false, detail?: string): void {
  setStatus(text, { isError, detail: detail ?? text });
}

/** 该轮是否有会改数据的同类长任务在跑。 */
export function roundBusy(roundId: string): boolean {
  const busy = getState().busy;
  return busy.has(busyIdOf('score', roundId)) || busy.has(busyIdOf('ladder', roundId));
}

function findRound(workspace: Workspace | null, groupId: string, roundId: string): Round | null {
  return (
    workspace?.groups.find((group) => group.id === groupId)?.rounds.find((round) => round.id === roundId) ??
    null
  );
}


// ---------- 来源：原图 ----------

/** 点「选择 / 更换原图」：系统对话框 + 落库（最近目录与状态栏由 core/actions 处理）。 */
export async function pickReference(ctx: RoundCtx): Promise<void> {
  if (isBusy()) return;
  await chooseReference(ctx.group.id, ctx.round.id);
}

/**
 * 拖入原图区：第一张设为原图，其余追加为跑分图（与外壳默认落点同一口径）。
 * 非图片文件已由外壳按 accept 过滤。
 */
export async function dropOnReference(ctx: RoundCtx, paths: readonly string[]): Promise<void> {
  if (isBusy() || paths.length === 0) return;
  await setRoundReference(ctx.group.id, ctx.round.id, paths[0]);
  const rest = paths.slice(1);
  if (rest.length === 0) return;
  await addCandidates(ctx.group.id, ctx.round.id, rest);
  status(`已设为原图，其余 ${rest.length} 张加为跑分图`);
}

// ---------- 来源：跑分图 ----------

/** 点「添加跑分图」：多选系统对话框。 */
export async function pickCandidates(ctx: RoundCtx): Promise<void> {
  if (isBusy()) return;
  await chooseCandidates(ctx.group.id, ctx.round.id);
}

/** 拖入跑分图区（或舞台）：全部追加为跑分图。 */
export async function dropOnCandidates(ctx: RoundCtx, paths: readonly string[]): Promise<void> {
  if (isBusy() || paths.length === 0) return;
  await addCandidates(ctx.group.id, ctx.round.id, paths);
}

/**
 * 移除一张跑分图（行内 ×）；只改评测记录，不删磁盘文件。
 *
 * 若这张图是某个参数变体的产物，同时抹掉变体的那条快照：否则判定仍说「已跑分且无变更」，
 * 增量跑分会永远跳过它，而它的行已经不在本轮了（变体也再没有入口能重新生成）。
 */
export async function removeCandidateAt(ctx: RoundCtx, path: string): Promise<void> {
  if (isBusy()) return;
  const owner = entryForArtifact(variantEntries(ctx.group.id, ctx.round.id), path);
  await removeCandidate(ctx.group.id, ctx.round.id, path);
  if (owner !== null && forgetArtifact(owner, path)) {
    status('已移除跑分图；对应参数变体回到待生成（磁盘文件保留）');
  }
}

// ---------- 跑分：整轮全量 ----------

/**
 * 整轮跑分（唯一全量入口）：先把脏参数变体生成出来，再对本轮原有跑分图整轮重算。
 *
 * 为什么先补生成：变体的产物必须先进本轮才能参与跑分（「参与下次跑分」）；新产物由
 * runQueuePlanOnce 的子集跑分当场出指标，原有行再整轮重算一次——每张图只算一次。
 * 进度与忙标志统一挂在 `score:<轮>` 上（跑分分区读同一个 id）。
 */
export async function runFullScore(ctx: RoundCtx): Promise<boolean> {
  const groupId = ctx.group.id;
  const roundId = ctx.round.id;
  // 分区按钮传进来的 ctx 是挂载快照：先按 id 从 store 重取最新轮，
  // 否则同轮内刚加的原图/跑分图会被旧快照的校验误拒。
  const fresh = findRound(getState().workspace, groupId, roundId);
  if (fresh) ctx.round = fresh;
  const round = ctx.round;
  if (!round.referencePath) {
    status('先选择原图，再开始跑分', true);
    return false;
  }
  const entries = variantEntries(groupId, roundId);
  syncEntryReference(entries, round.referencePath);
  const plan = planScore(entries, queueIdentityProbe());
  const oldPaths = round.candidates.map((candidate) => candidate.path);
  if (oldPaths.length === 0 && plan.runImageCount === 0) {
    status('本轮还没有可跑的东西：先添加跑分图或参数变体', true);
    return false;
  }
  if (plan.encoders.length > 0 && !(await encodersReady(entries))) return false;

  const id = busyIdOf('score', roundId);
  beginBusy(id, '正在跑分', oldPaths);
  try {
    if (plan.runImageCount > 0) {
      // 变体编排自己会读标识、写状态栏；这里复用同一份 deps，但不重复占忙标志，
      // 也不弹「跑分汇总」卡片（整轮跑的收尾在下面一次说清）。
      const deps: QueueRuntimeDeps = {
        ...variantRuntimeDeps(groupId, roundId),
        showNotice: () => undefined,
      };
      await refreshQueueIdentities(deps, [round.referencePath]);
      await runQueuePlanOnce({
        groupId,
        roundId,
        entries,
        deps,
        hooks: {
          onImageStart: ({ label, index, total }) => {
            updateBusy(id, { completed: 0, total: 1, detail: `正在生成参数变体（${index + 1}/${total}）` });
            setStatus(`正在生成参数变体 ${index + 1}/${total}：${label}…`);
          },
          askConflict: askConflictDialog,
        },
      });
    }
    if (oldPaths.length > 0) {
      setStatus(`跑分中 0/${oldPaths.length}`);
      setWorkspace(
        await coreIpc.roundScoreCandidates({
          groupId,
          roundId,
          paths: oldPaths,
          onProgress: (progress) => {
            updateBusy(id, { completed: progress.completed, total: progress.total, detail: '正在计算指标' });
            setStatus(`跑分中 ${progress.completed}/${progress.total}`);
          },
        }),
      );
    }
    const after = findRound(getState().workspace, groupId, roundId);
    const total = after?.candidates.length ?? 0;
    const failed = (after?.candidates ?? []).filter((candidate) => candidate.error !== null).length;
    const generated = plan.runImageCount;
    if (failed > 0) {
      status(`跑分完成，本轮共 ${total} 张；${failed} 张失败（结果坞状态列可展开原因）`, true);
    } else if (generated > 0) {
      status(`跑分完成，本轮共 ${total} 张（新生成 ${generated} 个参数变体）`);
    } else {
      status(`跑分完成，共 ${total} 张`);
    }
    return true;
  } catch (err) {
    status(`跑分失败：${errorText(err)}`, true);
    return false;
  } finally {
    endBusy(id);
  }
}

// ---------- 参数变体：会话态、宿主依赖与动作 ----------

/** 本轮变体列表（会话态；分区渲染与动作入口共用同一份）。 */
export function variantEntries(groupId: string, roundId: string): ImageEntry[] {
  return imageQueueFor(groupId, roundId).entries;
}

/** 同轮活数据：ctx 是挂载快照，入口先按 id 重取（与分区 update 同一口径）。 */
function liveCtx(ctx: RoundCtx): RoundCtx {
  const fresh = findRound(getState().workspace, ctx.group.id, ctx.round.id);
  if (fresh) ctx.round = fresh;
  return ctx;
}

/** 让变体跟上本轮原图（原图换了 ⇒ 旧结果整体作废）；返回是否有变体被改写。 */
export function syncVariants(ctx: RoundCtx): boolean {
  const round = liveCtx(ctx).round;
  return syncEntryReference(variantEntries(ctx.group.id, round.id), round.referencePath);
}

/**
 * 读一次本轮原图的标识并写入判定缓存（分区挂载后自举用）。
 *
 * 没有这份自举，刚挂载的变体会因为「标识还没读过」被保守判成「将重跑」，徽章失真；
 * 跑分 / 新建变体等动作本来就会读，这里只是把界面首次呈现也变成事实。
 */
export async function refreshRoundIdentity(referencePath: string): Promise<void> {
  await refreshQueueIdentities(
    { probeIdentities: (paths) => ipc.imageIdentities(paths) },
    [referencePath],
  );
}

/** 跑分后把逐行结果摊成 {path,error}（编排层据此把「编码成功但没跑出指标」折成失败）。 */
function rowsOf(workspace: Workspace, groupId: string, roundId: string): ScoredCandidate[] {
  const round = findRound(workspace, groupId, roundId);
  return (round?.candidates ?? []).map((candidate) => ({
    path: candidate.path,
    error: candidate.error,
  }));
}

/**
 * 变体流程的宿主依赖（分区、编辑弹窗、整轮跑分与「重跑改过的」共用一份）。
 *
 * 这里的每个方法只做「IPC → setWorkspace」；增量语义（跑哪张、跳过哪张、失败怎么记）
 * 全部由 logic/run 的编排决定，不在这一层重写。
 */
export function variantRuntimeDeps(
  _groupId: string,
  roundId: string,
): QueueRuntimeDeps & QueueEditorHostDeps {
  return {
    probeIdentities: (paths) => ipc.imageIdentities(paths),
    encode: async (targetGroupId, targetRoundId, referencePath, card, conflicts) => {
      const encodeOnce = (overwrite: boolean) =>
        ipc.advancedEncode({
          groupId: targetGroupId,
          roundId: targetRoundId,
          referencePath,
          job: jobPayloadOf(card),
          overwrite,
        });
      const outcome = await encodeOnce(false);
      if (outcome.kind === 'done') return outcome.product;
      if ((await conflicts.decide(outcome.proposedName)) === 'skip') {
        throw new Error(`已跳过（${outcome.proposedName} 已存在）`);
      }
      const retry = await encodeOnce(true);
      if (retry.kind !== 'done') throw new Error('覆盖重调后不应再返回冲突');
      return retry.product;
    },
    addCandidates: async (targetGroupId, targetRoundId, paths, params) => {
      setWorkspace(await coreIpc.roundAddCandidates(targetGroupId, targetRoundId, paths, params));
    },
    scoreRound: async (targetGroupId, targetRoundId, paths) => {
      const workspace = await coreIpc.roundScoreCandidates({
        groupId: targetGroupId,
        roundId: targetRoundId,
        paths,
        onProgress: (progress) => {
          updateBusy(busyIdOf('score', roundId), {
            completed: progress.completed,
            total: progress.total,
            detail: '正在计算指标',
          });
          setStatus(`跑分中 ${progress.completed}/${progress.total}`);
        },
      });
      setWorkspace(workspace);
      return rowsOf(workspace, targetGroupId, targetRoundId);
    },
    showNotice: (lines, options) => showNoticeCard(options.title, lines),
    setStatus: status,
    loadImageCatalog: () => ipc.advancedImageCatalog(),
  };
}

/** 参数编辑区的依赖（分区就地展开与「从原图新建编码」弹窗共用一份接线）。 */
export function entryEditorDeps(
  groupId: string,
  roundId: string,
  onChanged: () => void,
): ImageEntryEditorDeps {
  return queueEditorDeps(variantRuntimeDeps(groupId, roundId), onChanged);
}

/**
 * 新建一个参数变体（「跑分图」分区的「＋ 从原图新建编码」与「高级」分区共用）。
 *
 * 变体永远编码本轮原图：没有原图就先拒绝并给下一步（选择原图），
 * 不制造「看起来能跑其实没有基准」的假入口。
 */
export async function addParamVariant(ctx: RoundCtx): Promise<ImageEntry | null> {
  if (isBusy()) return null;
  const live = liveCtx(ctx);
  const referencePath = live.round.referencePath;
  if (!referencePath) {
    status('先选择原图，再加参数变体', true);
    return null;
  }
  const entries = variantEntries(live.group.id, live.round.id);
  syncEntryReference(entries, referencePath);
  const entry = newVariant(referencePath);
  entries.push(entry);
  await refreshQueueIdentities(variantRuntimeDeps(live.group.id, live.round.id), [referencePath]);
  status(`已添加参数变体（${variantSummary(entry)}）：调完参数点「生成并跑分」，它就成了本轮的一张跑分图`);
  return entry;
}

/** 删除一个参数变体（只删会话态与列表行，磁盘产物保留；已被复制的原图不受影响）。 */
export function removeVariantAt(ctx: RoundCtx, entryId: string): boolean {
  if (isBusy()) return false;
  const removed = removeImageEntry(variantEntries(ctx.group.id, ctx.round.id), entryId);
  if (!removed) return false;
  status('已删除参数变体（磁盘上的产物文件保留）');
  return true;
}

/** 读某轮的名字与结果条数（轮已不在工作区返回 null）。 */
export function describeRound(roundId: string): RoundSummary | null {
  for (const group of getState().workspace?.groups ?? []) {
    const round = group.rounds.find((item) => item.id === roundId);
    if (round) return { name: round.name, candidateCount: round.candidates.length };
  }
  return null;
}

/** 「重跑改过的」与分区的「生成并跑分」共用：只补生成脏变体 + 只跑缺指标的跑分图。 */
export async function runChangedEntries(ctx: RoundCtx): Promise<void> {
  if (isBusy()) return;
  const live = liveCtx(ctx);
  const groupId = live.group.id;
  const roundId = live.round.id;
  const round = live.round;
  if (!round.referencePath) {
    status('先选择原图，再跑参数变体', true);
    return;
  }
  const entries = variantEntries(groupId, roundId);
  syncEntryReference(entries, round.referencePath);
  const deps: QueueRuntimeDeps = variantRuntimeDeps(groupId, roundId);
  await refreshQueueIdentities(deps, [round.referencePath]);
  const plan = planScore(entries, queueIdentityProbe());
  const pending = candidatesNeedingScore(round.candidates);
  if (plan.encoders.length === 0 && pending.length === 0) {
    const message = '没有需要跑的：参数变体与跑分图都已跑分且无变更';
    status(message);
    showNoticeCard('无需重跑', [message]);
    return;
  }
  if (plan.encoders.length > 0 && !(await encodersReady(entries))) return;

  const busy = busyIdOf('score', roundId);
  beginBusy(busy, '正在跑分', round.candidates.map((candidate) => candidate.path));
  try {
    if (plan.runImageCount > 0) {
      await runQueuePlanOnce({
        groupId,
        roundId,
        entries,
        deps,
        hooks: {
          onImageStart: ({ label, index, total }) => {
            updateBusy(busy, { completed: index, total, detail: `正在生成参数变体 ${index + 1}/${total}` });
            setStatus(`正在生成参数变体 ${index + 1}/${total}：${label}…`);
          },
          askConflict: askConflictDialog,
        },
      });
    }
    if (pending.length > 0) {
      setWorkspace(
        await coreIpc.roundScoreCandidates({
          groupId,
          roundId,
          paths: pending.map((candidate) => candidate.path),
          onProgress: (progress) => {
            updateBusy(busy, { completed: progress.completed, total: progress.total, detail: '正在计算指标' });
            setStatus(`跑分中 ${progress.completed}/${progress.total}`);
          },
        }),
      );
    }
    const after = findRound(getState().workspace, groupId, roundId);
    const failed = (after?.candidates ?? []).filter((candidate) => candidate.error !== null).length;
    const parts: string[] = [];
    if (plan.runImageCount > 0) parts.push(`${plan.runImageCount} 个参数变体已更新`);
    if (pending.length > 0) parts.push(`${pending.length} 张跑分图已更新`);
    if (failed > 0) parts.push(`${failed} 张失败`);
    status(`跑分完成${parts.length > 0 ? `：${parts.join('；')}` : ''}`, failed > 0);
  } catch (err) {
    status(`跑分失败：${errorText(err)}`, true);
  } finally {
    endBusy(busy);
  }
}

/**
 * 跑变体之前预检编码器：缺哪个当场说清楚（含发布页），不让 N 项各自失败一遍。
 * 返回 true 表示可以继续跑。
 */
async function encodersReady(entries: readonly ImageEntry[]): Promise<boolean> {
  let specs: ImageSpec[];
  try {
    specs = await ensureImageSpecs();
  } catch (err) {
    status(`加载编码器目录失败：${errorText(err)}`, true);
    return false;
  }
  const issue = await precheckEntries(entries, specs);
  if (!issue) return true;
  status(issue.message.split('\n')[0], true, issue.message);
  showEncoderIssueCard(issue, () => void openSettingsPage());
  return false;
}

/** 图片编码器目录只拉一次（advanced_image_catalog；工具键来自它的规格表）。 */
let imageSpecsPromise: Promise<ImageSpec[]> | null = null;

export function ensureImageSpecs(): Promise<ImageSpec[]> {
  if (!imageSpecsPromise) {
    imageSpecsPromise = ipc.advancedImageCatalog().catch((err: unknown) => {
      imageSpecsPromise = null;
      throw err;
    });
  }
  return imageSpecsPromise;
}

/** 打开设置页（命令由设置域注册；没有就如实提示）。 */
export async function openSettingsPage(): Promise<void> {
  if (!(await runCommand('open-settings'))) {
    status('设置入口还没就绪：请从顶栏「设置」打开编码器区指定外部路径', true);
  }
}

// ---------- 编码器可用性预检（决策 0025：缺失时给设置页与发布页，不让 15 项各自失败） ----------

/** 一站式格式 → 需要的外部可执行文件键（PNG 由核心库内部写出，无独立二进制）。 */
const ONESTOP_TOOL_KEYS: Record<string, string> = {
  jpeg: 'cjpeg',
  webp: 'cwebp',
  avif: 'avifenc',
  jxl: 'cjxl',
  'webp-lossless': 'cwebp',
  'jxl-lossless': 'cjxl',
};

/** 预检结论：缺了哪些编码器 + 可直达的发布页 + 逐条中文原因。 */
export interface EncoderIssue {
  keys: string[];
  message: string;
  releasePages: string[];
}

function missingOf(statuses: readonly ToolStatus[]): EncoderIssue | null {
  const bad = statuses.filter(
    (item) => item.source === 'unavailable' || item.source === 'unconfigured',
  );
  if (bad.length === 0) return null;
  const detail = bad
    .map(
      (item) =>
        `${item.key}（${item.source === 'unavailable' ? '不可用' : '未配置'}）：${item.hint ?? '需要指定可执行文件'}`,
    )
    .join('\n');
  return {
    keys: bad.map((item) => item.key),
    releasePages: [
      ...new Set(
        bad
          .map((item) => item.releasePage)
          .filter((page): page is string => typeof page === 'string' && page.length > 0),
      ),
    ],
    message: `编码器未就绪：${bad.map((item) => item.key).join('、')}。到设置页指定外部路径，或从官方发布页下载后重试。\n${detail}`,
  };
}

/** 一站式清单的编码器预检（只查清单里真正会用到的格式）。 */
export async function precheckLadder(items: readonly LadderItem[]): Promise<EncoderIssue | null> {
  const keys = [...new Set(items.map((item) => ONESTOP_TOOL_KEYS[item.format]).filter(Boolean))];
  if (keys.length === 0) return null;
  try {
    return missingOf(await ipc.advancedEncoderStatus(keys));
  } catch (err) {
    return { keys, releasePages: [], message: `编码器可用性检测失败：${errorText(err)}` };
  }
}

/** 参数变体的编码器预检（工具键来自 advanced_image_catalog 的规格）。 */
export async function precheckEntries(
  entries: readonly ImageEntry[],
  specs: readonly ImageSpec[],
): Promise<EncoderIssue | null> {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const keys = [
    ...new Set(
      entries
        .flatMap((entry) => entry.encoders)
        .map((card) => byId.get(card.encoderId)?.toolKey)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    ),
  ];
  if (keys.length === 0) return null;
  try {
    return missingOf(await ipc.advancedEncoderStatus(keys));
  } catch (err) {
    return { keys, releasePages: [], message: `编码器可用性检测失败：${errorText(err)}` };
  }
}

// ---------- 一站式：取点与生成 ----------

/** 格式目录只拉一次（onestop_catalog）；失败不缓存，允许重试。 */
let catalogPromise: Promise<void> | null = null;

export function ensureLadderCatalog(): Promise<void> {
  if (!catalogPromise) {
    catalogPromise = initOnestopCatalog().catch((err: unknown) => {
      catalogPromise = null;
      throw err;
    });
  }
  return catalogPromise;
}

/** 取当前参数对应的阶梯（质量优先 / 单点模式）；失败写进状态栏。 */
export async function loadLadder(state: LadderUiState): Promise<void> {
  if (state.mode === 'size' && !state.singlePoint) return;
  const key = ladderKeyOf(state);
  try {
    const items = state.singlePoint
      ? await fetchSinglePointLadder(state.baseline)
      : await fetchQualityLadder(state.baseline);
    // 取点期间用户又拖了拉杆：这份结果已过期，丢弃
    if (ladderKeyOf(state) !== key) return;
    state.ladder = items;
    state.ladderKey = key;
  } catch (err) {
    status(`取点失败：${errorText(err)}`, true);
  }
}

/** 大小优先：对缺结果的勾选格式逐个逼近搜索（每次调用天然形成进度）。 */
export async function runSizeSearch(ctx: RoundCtx, state: LadderUiState): Promise<void> {
  // ctx 是挂载快照，入口先重取（分区按钮点击时同轮数据可能已变）
  const fresh = findRound(getState().workspace, ctx.group.id, ctx.round.id);
  if (fresh) ctx.round = fresh;
  const referencePath = ctx.round.referencePath;
  if (!referencePath) return;
  const sizeKey = String(state.targetBytes);
  if (state.sizeKey !== sizeKey) {
    state.sizeOutcomes = {};
    state.sizeKey = sizeKey;
  }
  const targets = LOSSY_FORMATS.filter(
    (format) =>
      state.selection.lossyFormats.includes(format.format) &&
      state.sizeOutcomes[format.format] === undefined,
  );
  if (targets.length === 0) return;
  const id = busyIdOf('ladder', ctx.round.id);
  beginBusy(id, '正在逼近目标大小');
  try {
    for (const [index, format] of targets.entries()) {
      // 目标在搜索期间被改了：停下，等下一次触发
      if (String(state.targetBytes) !== sizeKey) break;
      updateBusy(id, {
        completed: index,
        total: targets.length,
        detail: `正在逼近 ${format.label}`,
      });
      setStatus(`正在搜索 ${format.label} 逼近目标大小…`);
      state.sizeOutcomes[format.format] = await searchSizeFormat({
        groupId: ctx.group.id,
        roundId: ctx.round.id,
        referencePath,
        format: format.format,
        targetBytes: state.targetBytes,
      });
    }
  } catch (err) {
    status(`逼近搜索失败：${errorText(err)}`, true);
  } finally {
    endBusy(id);
  }
}

/** 预演：当前参数下最终会生成几项（「将生成 N 项」的唯一来源）。 */
export function plannedCount(state: LadderUiState): number {
  return planItemsOf(state).length;
}

/** 大小优先已完成搜索的清单（预览网格用；未搜到的格式先不显示）。 */
export function sizeLadderPreview(state: LadderUiState): LadderItem[] {
  return LOSSY_FORMATS.filter((f) => state.selection.lossyFormats.includes(f.format)).flatMap(
    (f) => {
      const outcome = state.sizeOutcomes[f.format];
      return outcome ? sizeOutcomeLadder(outcome) : [];
    },
  );
}

/**
 * 一站式：生成并跑分。
 *
 * 顺序 = 预检编码器 → 逐项 onestop_encode → 产物一次性入轮 → 整轮跑分。
 * 失败不回滚已成功项；失败项留在 state.failures 里由分区就地展开。
 */
export async function generateLadder(ctx: RoundCtx, state: LadderUiState): Promise<void> {
  if (isBusy()) return;
  try {
    await ensureLadderCatalog();
  } catch (err) {
    status(`加载编码器目录失败：${errorText(err)}`, true);
    return;
  }
  // ctx 是挂载快照，入口先重取（分区按钮点击时同轮数据可能已变）
  const freshRound = findRound(getState().workspace, ctx.group.id, ctx.round.id);
  if (freshRound) ctx.round = freshRound;
  const referencePath = ctx.round.referencePath;
  if (!referencePath) {
    status('先选择原图，再让工具自动压一套阶梯', true);
    return;
  }
  if (state.mode === 'size' && !state.singlePoint) {
    if (!Number.isFinite(state.targetBytes) || state.targetBytes < 1) {
      status('目标大小无效：请输入大于 0 的数值', true);
      return;
    }
    if (!sizeSearchComplete(state)) await runSizeSearch(ctx, state);
    if (!sizeSearchComplete(state)) {
      status('逼近搜索没有完成，未生成任何产物', true);
      return;
    }
  } else if (state.ladder === null) {
    await loadLadder(state);
  }
  syncLadderKey(state);

  const items = planItemsOf(state);
  if (items.length === 0) {
    status('请先选择至少一个编码格式或无损组', true);
    return;
  }
  const issue = await precheckLadder(items);
  state.encoderIssue = issue?.message ?? null;
  if (issue) {
    status(issue.message.split('\n')[0], true, issue.message);
    return;
  }

  const id = busyIdOf('ladder', ctx.round.id);
  state.failures = [];
  beginBusy(id, '正在自动编码', items.map((item) => item.label));
  // 逐项进度：detail 以「已完成/总数」开头，分区据此画真实 N/M 进度条
  let started = 0;
  try {
    const result = await runLadder({
      ladder: items,
      encode: (item, overwrite) =>
        ipc.onestopEncode({
          groupId: ctx.group.id,
          roundId: ctx.round.id,
          referencePath,
          format: item.format,
          quality: item.quality,
          overwrite,
        }),
      addCandidates: async (products) => {
        setWorkspace(
          await coreIpc.roundAddCandidates(
            ctx.group.id,
            ctx.round.id,
            products.map((product) => product.path),
            products.map((product) => product.encodingParams),
          ),
        );
      },
      onProgress: (text) => {
        started += 1;
        const completed = Math.min(started, items.length);
        updateBusy(id, { completed, total: items.length, detail: text });
        setStatus(`${text}（${completed}/${items.length}）`);
      },
      onConflict: askConflictDialog,
    });

    if (state.mode === 'size' && !state.singlePoint) {
      await applySizeNotes(ctx, state, result.products);
    }
    state.failures = result.failures;

    if (result.generated === 0) {
      status(`自动编码全部失败：${result.failures.join('；') || '未知原因'}`, true);
      return;
    }
    // 产物已在轮里：整轮跑分（与手动入口同一份实现）
    const fresh = findRound(getState().workspace, ctx.group.id, ctx.round.id);
    if (fresh) ctx.round = fresh;
    const ok = await runFullScore(ctx);
    if (ok && result.failures.length > 0) {
      status(
        `跑分完成；${result.failures.length} 项生成失败（清单见编码阶梯分区）`,
        true,
        result.failures.join('\n'),
      );
    }
  } catch (err) {
    status(`自动编码失败：${errorText(err)}`, true);
  } finally {
    endBusy(id);
  }
}

/**
 * 大小优先的不可达标注：逐产物串行写 note，**最后一次回包才刷新界面**。
 *
 * 每写一条后端都回整份工作区；串行 + 只刷新一次，避免长任务期间界面被回包刷屏。
 */
async function applySizeNotes(
  ctx: RoundCtx,
  state: LadderUiState,
  products: readonly { path: string; format: string }[],
): Promise<void> {
  let last: Workspace | null = null;
  for (const product of products) {
    const note = state.sizeOutcomes[product.format]?.note ?? null;
    if (!note) continue;
    try {
      last = await coreIpc.roundSetCandidateNote(ctx.group.id, ctx.round.id, product.path, note);
    } catch (err) {
      status(`写入不可达标注失败：${errorText(err)}`, true);
    }
  }
  if (last) setWorkspace(last);
}

/** 勾选的无损组显示名（预览网格的无损行用）。 */
export function selectedLosslessLabels(state: LadderUiState): string[] {
  return LOSSLESS_FORMATS.filter((f) => state.selection.losslessFormats.includes(f.format)).map(
    (f) => f.label,
  );
}
