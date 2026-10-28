// 增量跑分编排（票 #79 / T5）：把 T2 的 ScorePlan 变成可执行批次，并在注入的执行器上
// 跑完「惰性建轮 → 设原图 → 只编码计划内的卡 → 只把本次新增产物纳入本轮 →
// 只对本次新增产物跑分 → 按计划时指纹写回快照」。
//
// 三条设计约束：
// 1. **零 DOM、零 IPC**：面板把 IPC 包进 QueueRunExecutor 注入进来，所以「只跑计划内」
//    「无待跑零调用」「失败不阻断」都能在 node 环境用假执行器真跑，不靠文本守卫。
// 2. **计划时指纹**：PlannedEncoder.fingerprint 是计划时快照，编码与写回都用它——
//    跑分中途用户改参数（延迟落库）不会把没跑过的参数记成已跑。
// 3. **子集跑分**：把本次新增产物的路径作为 paths 传给 round_score_candidates，
//    未参与条目的指标与失败原因由后端逐 bit 保持不变（T3 已用黄金基准钉住）。

import { ConflictSession, type ConflictAnswer } from './conflict';
import {
  applyRunResults,
  attachRound,
  entryFailures,
  isPlanEmpty,
  planScore,
  planSummary,
  skipReasonLine,
  type EncoderRunOutcome,
  type EntryFailureView,
  type ImageEntry,
  type ImageIdentityProbe,
  type PlannedEncoder,
  type RoundSummary,
  type ScorePlan,
} from './image-queue';

// ---------- IPC 薄契约（与 image-queue-panel 的 deps 共用） ----------

/** 一轮跑分后的逐行结果（面板据此把「编码成功但跑分失败」折成失败）。 */
export interface ScoredCandidate {
  path: string;
  error: string | null;
}

/** 跑分回包里找不到该产物行时的失败原因（单一来源，测试从这里取）。 */
export const MISSING_SCORE_ROW_REASON = '跑分结果里没有该产物的行，未确认指标';

/**
 * 把「编码成功但没跑出指标」的卡折成失败结果（**保守口径：缺行也算失败**）。
 *
 * 为什么需要它：编码成功只说明产物写出来了，跑分（解码 + 指标计算）仍可能失败，
 * 失败原因由核心库写进产物行的 error 字段；而回包里**根本没有该产物的行**时，
 * 同样意味着没有确认过指标（例如产物没进轮、回包被截断、轮被删）。T2 的
 * applyRunResults 只在成功时写快照，所以这两种情况都必须降级成失败——否则一张
 * 没真正跑出指标的图会被记成「已跑分」并被永久跳过（fail-open 是最贵的错误方向：
 * 多跑一次只是慢，误记已跑分会让用户永远看不到真实指标）。
 */
export function mergeScoreFailures(
  outcomes: EncoderRunOutcome[],
  scored: readonly ScoredCandidate[],
): EncoderRunOutcome[] {
  const errorByPath = new Map<string, string | null>();
  for (const row of scored) {
    errorByPath.set(row.path, row.error ?? null);
  }
  return outcomes.map((outcome) => {
    if (outcome.kind !== 'success') return outcome;
    if (!errorByPath.has(outcome.artifactPath)) {
      return { kind: 'failure', cardId: outcome.cardId, reason: MISSING_SCORE_ROW_REASON };
    }
    const reason = errorByPath.get(outcome.artifactPath);
    return reason === null || reason === undefined
      ? outcome
      : { kind: 'failure', cardId: outcome.cardId, reason };
  });
}

// ---------- 计划 → 执行批次 ----------

/** 一张图在本次跑分里的执行批次：按条目分组、只含计划内的编码器卡。 */
export interface RunBatch {
  imageId: string;
  path: string;
  /** 本次要跑的编码器卡（条目内顺序；携带计划时指纹）。 */
  encoders: PlannedEncoder[];
}

/** 把 ScorePlan 按图分组：只含至少有一条卡要跑的条目，并保留计划时指纹与原因。 */
export function planRunBatches(plan: ScorePlan): RunBatch[] {
  const batches = new Map<string, RunBatch>();
  for (const planned of plan.encoders) {
    let batch = batches.get(planned.imageId);
    if (!batch) {
      batch = { imageId: planned.imageId, path: planned.path, encoders: [] };
      batches.set(planned.imageId, batch);
    }
    batch.encoders.push(planned);
  }
  return [...batches.values()];
}

// ---------- 按钮文案与汇总 ----------

/** 无待跑条目时的提示文案（单一来源，面板与测试都从这里取）。 */
export const NOTHING_TO_RUN_MESSAGE = '所有图片已跑分且无变更，无需重跑';

/** 空计划、原因是「没有编码器配置」时的提示文案（单一来源）。 */
export const NO_ENCODERS_MESSAGE = '没有可跑的编码器配置，请先在编辑窗口里添加编码器卡';

/** 应用内提示卡片的正文来源：标题 + 正文行。 */
export interface NothingToRunNotice {
  title: string;
  lines: string[];
}

/**
 * 计划为空时该弹什么（标题 + 正文行）。
 *
 * 计划为空不止「已跑分且无变更」一种原因：条目没有编码器配置时同样没有待跑项，这时
 * 再说「所有图片已跑分且无变更」是失真提示（用户会以为它已经跑好了，实际它压根没配置
 * 可跑的东西）。按 plan.skippedImages 的原因分流：「没有编码器配置」优先（它要求用户
 * 动手），并逐张点名跳过原因（复用 skipReasonLine）；全部是 clean 时才用票面文案。
 */
export function nothingToRunNotice(plan: ScorePlan): NothingToRunNotice {
  const hasNoEncoders = plan.skippedImages.some((item) => item.reason.code === 'no-encoders');
  if (!hasNoEncoders) return { title: '无需重跑', lines: [NOTHING_TO_RUN_MESSAGE] };
  return {
    title: '没有可跑的编码器配置',
    lines: [NO_ENCODERS_MESSAGE, ...plan.skippedImages.map(skipReasonLine)],
  };
}

/**
 * 「跑分 / 重跑」按钮文案，N = 本次待跑张数（plan.runImageCount）。
 *
 * 只要计划里有一张图此前跑过（有成功快照、显式换过图或上次失败），这次就是「重跑」；
 * 全是新图才是「跑分」。计划为空时仍显示「跑分（0 张）」——按钮必须可点，点开只弹
 * 「无需重跑」提示卡片（票面：没有待跑时只提示、不执行）。
 */
export function scoreButtonLabel(plan: ScorePlan, entries: readonly ImageEntry[]): string {
  if (entries.length === 0) return '跑分';
  const plannedIds = new Set(plan.encoders.map((item) => item.imageId));
  const rerun = entries.some(
    (entry) =>
      plannedIds.has(entry.id) &&
      (entry.snapshot !== null || entry.replaced || entry.failures.length > 0),
  );
  if (plan.runImageCount === 0) return '跑分（0 张）';
  return `${rerun ? '重跑' : '跑分'}（${plan.runImageCount} 张）`;
}

/**
 * 主界面「重跑改过的（N 张）」按钮文案（票 #82），N 与计划同源（plan.runImageCount）。
 *
 * 与面板的 scoreButtonLabel 分开：那个按钮是「跑分 / 重跑」二选一的主动作，会随
 * 「这次是不是重跑」改词；主界面这个按钮的职责固定为**只重跑脏条目**（整轮全量留给
 * 旁边的「开始跑分」），所以文案恒定、只报张数。0 张时照样显示「（0 张）」——
 * 按钮可点，点开只弹「无需重跑」提示（票面验收），不靠置灰表达「没得跑」。
 */
export function rerunChangedButtonLabel(plan: ScorePlan): string {
  return `重跑改过的（${plan.runImageCount} 张）`;
}

/** 汇总卡片正文行：标题（本次跑分 N 张，跳过 M 张）+ 逐张跳过原因。 */
export function summaryLines(plan: ScorePlan): string[] {
  const summary = planSummary(plan);
  return [summary.headline, ...summary.skipLines];
}

// ---------- 执行编排 ----------

/** 编码产物（只需面板接线要用的两个字段，AdvancedProductDto 结构性兼容）。 */
export interface EncodedProduct {
  path: string;
  encodingParams: string;
}

/**
 * 跑分执行器：面板用真实 IPC 实现，测试用记录调用的假实现。
 * 所有方法只处理单张图条目；编排层负责顺序、失败兜底与结果回写。
 */
export interface QueueRunExecutor {
  /**
   * 读该条目记着的评测轮是否还在工作区（只读）。轮被主界面删掉时返回 null——
   * 编排层据此丢弃失效 id、走惰性建轮，否则每次跑分都会报「评测轮不存在」。
   */
  describeRound(entry: ImageEntry, roundId: string): RoundSummary | null;
  /** 惰性建轮：只在 entry.roundId === null 时调用，返回新轮 id。 */
  createRound(entry: ImageEntry): Promise<string>;
  /** 设置该轮原图（实现方可在「已经是同一张」时跳过 IPC）。 */
  setReference(entry: ImageEntry, roundId: string): Promise<void>;
  /** 编码一张卡；抛错 = 编码失败（编排层折成失败结果，不中断其它卡）。 */
  encode(
    entry: ImageEntry,
    roundId: string,
    planned: PlannedEncoder,
    conflicts: ConflictSession,
  ): Promise<EncodedProduct>;
  /** 把本次新增产物纳入该轮。 */
  addCandidates(
    entry: ImageEntry,
    roundId: string,
    products: readonly EncodedProduct[],
  ): Promise<void>;
  /** 只跑指定路径的跑分图（本次新增产物），返回逐行结果。 */
  scoreCandidates(
    entry: ImageEntry,
    roundId: string,
    paths: readonly string[],
  ): Promise<ScoredCandidate[]>;
  /** 回滚本次新建、且一条产物都没进轮的空轮。 */
  deleteRound(entry: ImageEntry, roundId: string): Promise<void>;
}

/** 编排层的界面回调（保持本模块零 DOM：面板负责弹卡片、刷新列表）。 */
export interface QueueRunHooks {
  /** 计划为空：只该弹提示卡片（内容按跳过原因分流，见 nothingToRunNotice），
   * 未调用执行器任何方法。 */
  onNothingToRun?(plan: ScorePlan): void;
  /** 开始跑一张图（面板用来显示进度文案）。 */
  onImageStart?(info: { path: string; index: number; total: number }): void;
  /** 一张图跑完（面板用来原地刷新列表状态）。 */
  onImageDone?(entry: ImageEntry): void;
  /** 产物命名冲突询问（面板接 askFileConflict；缺省时冲突会按失败处理）。 */
  askConflict?(fileName: string): Promise<ConflictAnswer>;
}

/** 单张图的跑分结果（供面板汇总状态栏与失败详情）。 */
export interface QueueRunImageResult {
  entry: ImageEntry;
  /** 条目级错误（建轮 / 设原图 / 纳产物 / 跑分调用本身失败），null = 没有系统级错误。 */
  error: string | null;
  /** 跑完后该条目仍有效的失败明细（编码失败 + 产物行内跑分失败）。 */
  failures: EntryFailureView[];
}

/** 一次增量跑分的报告。plan 是**跑之前**的计划（汇总计数与跳过原因都用它）。 */
export interface QueueRunReport {
  plan: ScorePlan;
  /** 是否真的执行了跑分；false = 计划为空，只触发了 onNothingToRun。 */
  ran: boolean;
  images: QueueRunImageResult[];
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/**
 * 执行一张图的跑分批次：
 * 惰性建轮 → 设原图 → 逐卡编码（失败收集、不中断）→ 纳入本次新增产物 →
 * 只对本次新增产物跑分 → 按计划时指纹回写快照。
 *
 * 兜底口径：
 * - 一条产物都没产出：本次新建的轮回滚（工作区不留空轮），失败写回条目；
 * - 已有轮全部失败：保留轮（里面可能还有上一轮结果，不能删）；
 * - 编码成功但后续步骤（纳产物 / 跑分调用）抛错：成功结果降级成失败（没跑出指标
 *   就不算已跑分，下次自动重试），避免「产物存在但没指标」被误记成已跑分；
 * - 系统级错误（建轮 / 设原图 / 纳产物 / 跑分调用本身抛错）：**计划内每张卡**都记一条
 *   失败（编码本身失败的卡保留它更具体的原因），徽章显示「上次失败」、下次自动重试。
 */
async function runOneImage(
  entry: ImageEntry,
  batch: RunBatch,
  probe: ImageIdentityProbe,
  executor: QueueRunExecutor,
  hooks: QueueRunHooks,
): Promise<QueueRunImageResult> {
  const identity = probe(entry.path);
  const outcomes: EncoderRunOutcome[] = [];
  const products: EncodedProduct[] = [];
  let roundId = entry.roundId;
  let createdNow = false;
  let added = false;
  let error: string | null = null;

  // 条目记着的轮可能已被主界面删掉：用旧 id 去设原图/跑分只会每次报「评测轮不存在」，
  // 条目再也跑不动。这里先只读确认一次，失效就丢弃 id 走惰性建轮。
  if (roundId !== null && executor.describeRound(entry, roundId) === null) {
    entry.roundId = null;
    roundId = null;
  }

  try {
    if (roundId === null) {
      roundId = await executor.createRound(entry);
      attachRound(entry, roundId);
      createdNow = true;
    }
    await executor.setReference(entry, roundId);
    const conflicts = new ConflictSession(
      hooks.askConflict ?? (() => Promise.reject(new Error('缺少产物冲突询问入口'))),
    );
    for (const planned of batch.encoders) {
      try {
        const product = await executor.encode(entry, roundId, planned, conflicts);
        products.push(product);
        outcomes.push({
          kind: 'success',
          cardId: planned.encoder.id,
          artifactPath: product.path,
          // 计划时指纹：跑分中途改参数时，下一轮必须如实判成「参数改了」
          fingerprint: planned.fingerprint,
        });
      } catch (err) {
        outcomes.push({ kind: 'failure', cardId: planned.encoder.id, reason: errorText(err) });
      }
    }

    if (products.length === 0) {
      // 一条产物都没产出：本次新建的轮没有意义，回滚掉（不能留下空轮）
      if (createdNow) {
        try {
          await executor.deleteRound(entry, roundId!);
          entry.roundId = null;
          roundId = null;
        } catch (rollbackErr) {
          console.warn('回滚空评测轮失败（工作区可能留下一个空轮）:', rollbackErr);
        }
      }
      applyRunResults(entry, outcomes, identity);
      return { entry, error, failures: entryFailures(entry) };
    }

    await executor.addCandidates(entry, roundId, products);
    added = true;
    const scored = await executor.scoreCandidates(entry, roundId, products.map((product) => product.path));
    applyRunResults(entry, mergeScoreFailures(outcomes, scored), identity);
  } catch (err) {
    error = errorText(err);
    // 产物还没进轮就把本次新建的轮回滚掉，避免残留空轮
    if (createdNow && !added && roundId !== null) {
      try {
        await executor.deleteRound(entry, roundId);
        entry.roundId = null;
      } catch (rollbackErr) {
        console.warn('回滚空评测轮失败（工作区可能留下一个空轮）:', rollbackErr);
      }
    }
    // 系统级错误（建轮 / 设原图 / 纳产物 / 跑分调用本身抛错）也要落成**计划内每张卡**
    // 的失败：面板提示「详情见列表徽章」，而徽章只读 entry.failures——一条都不写会让
    // 条目停在「未跑分」，用户既看不到原因，也不确定下次会不会重试。编码本身失败的卡
    // 保留它更具体的原因，其余（编码成功但没跑成、还没轮到编码）记系统错误文案。
    const systemReason = `本次未完成跑分：${error}`;
    const failures: EncoderRunOutcome[] = batch.encoders.map((planned) => {
      const outcome = outcomes.find((item) => item.cardId === planned.encoder.id);
      if (outcome !== undefined && outcome.kind === 'failure') return outcome;
      return { kind: 'failure', cardId: planned.encoder.id, reason: systemReason };
    });
    applyRunResults(entry, failures, identity);
  }

  return { entry, error, failures: entryFailures(entry) };
}

/**
 * 执行一次增量跑分计划。
 *
 * 先算计划：为空时**不调用执行器的任何方法**，只触发 onNothingToRun（面板据此弹
 * 提示卡片，内容由 nothingToRunNotice 按跳过原因分流：全部 clean ≠ 没有编码器配置）；
 * 非空时按图逐批执行，每张图跑完回调 onImageDone，最后返回跑前计划供汇总卡片使用。
 */
export async function runScorePlan(
  entries: readonly ImageEntry[],
  probe: ImageIdentityProbe,
  executor: QueueRunExecutor,
  hooks: QueueRunHooks = {},
): Promise<QueueRunReport> {
  const plan = planScore([...entries], probe);
  if (isPlanEmpty(plan)) {
    hooks.onNothingToRun?.(plan);
    return { plan, ran: false, images: [] };
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const batches = planRunBatches(plan);
  const images: QueueRunImageResult[] = [];
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const entry = byId.get(batch.imageId);
    // 计划生成后条目被删：按「不再需要跑」处理，不制造幽灵调用
    if (!entry) continue;
    hooks.onImageStart?.({ path: batch.path, index, total: batches.length });
    images.push(await runOneImage(entry, batch, probe, executor, hooks));
    hooks.onImageDone?.(entry);
  }
  return { plan, ran: true, images };
}
