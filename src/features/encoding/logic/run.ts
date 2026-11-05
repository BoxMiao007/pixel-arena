// 增量跑分编排（票 #79 / T5；票「变体并入当前轮」后不再建轮）：把 ScorePlan 变成
// 可执行批次，并在注入的执行器上跑完「只编码计划内的卡 → 只把本次新增产物纳入当前轮 →
// 只对本次新增产物跑分 → 按计划时指纹写回快照」。
//
// 三条设计约束：
// 1. **零 DOM、零 IPC**：动作层把 IPC 包进 QueueRunExecutor 注入进来，所以「只跑计划内」
//    「无待跑零调用」「失败不阻断」都能在 node 环境用假执行器真跑，不靠文本守卫。
// 2. **计划时指纹**：PlannedEncoder.fingerprint 是计划时快照，编码与写回都用它——
//    跑分中途用户改参数（延迟落库）不会把没跑过的参数记成已跑。
// 3. **子集跑分**：把本次新增产物的路径作为 paths 传给 round_score_candidates，
//    未参与变体的指标与失败原因由后端逐 bit 保持不变（T3 已用黄金基准钉住）。

import type { CandidateImage } from '../../../core/model';
import { ConflictSession, type ConflictAnswer } from './conflict';
import {
  applyRunResults,
  entryFailures,
  isPlanEmpty,
  planScore,
  planSummary,
  skipReasonLine,
  variantSummary,
  type EncoderRunOutcome,
  type EntryFailureView,
  type ImageEntry,
  type ImageIdentityProbe,
  type PlannedEncoder,
  type ScorePlan,
} from './entries';

// ---------- IPC 薄契约（与 actions.variantRuntimeDeps 共用） ----------

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
 * 「重跑改过的（N 张）」按钮文案：N = 待生成变体数 + 缺指标的跑分图数。
 *
 * 与计划同源（plan.runImageCount + candidatesNeedingScore 的长度），0 张时照样显示
 * 「（0 张）」——按钮可点，点开只弹「无需重跑」提示（票面验收），不靠置灰表达「没得跑」。
 */
export function rerunChangedButtonLabel(plan: ScorePlan, pendingCandidates = 0): string {
  return `重跑改过的（${plan.runImageCount + pendingCandidates} 张）`;
}

/** 汇总卡片正文行：标题（本次跑分 N 张，跳过 M 张）+ 逐张跳过原因。 */
export function summaryLines(plan: ScorePlan): string[] {
  const summary = planSummary(plan);
  return [summary.headline, ...summary.skipLines];
}

/**
 * 一次跑分里变体侧的失败计数（状态栏与汇总标题共用同一份口径，避免两处各数一遍）。
 *
 * failureCount 是**失败明细条数**：正常失败逐卡一条；系统级错误在 runOneImage 里已经
 * 折算成计划内每张卡一条，天然被数到。只有一种退化情形要兜底——跑分中途用户把卡删了，
 * applyRunResults 会把结果丢掉，此时 failures 为空但 error 还在；这种变体按一条失败计。
 */
export interface QueueRunFailureCounts {
  /** 失败条数（逐卡明细；系统级错误已折算进去）。 */
  failureCount: number;
  /** 出错变体数（变体级系统错误：纳产物 / 跑分调用本身失败）。 */
  errorVariantCount: number;
}

export function runFailureCounts(report: QueueRunReport): QueueRunFailureCounts {
  let failureCount = 0;
  let errorVariantCount = 0;
  for (const image of report.images) {
    const detailCount = image.failures.length;
    failureCount += detailCount;
    if (image.error !== null) {
      errorVariantCount += 1;
      if (detailCount === 0) failureCount += 1;
    }
  }
  return { failureCount, errorVariantCount };
}

/**
 * 汇总标题行：没失败时与 planSummary(plan).headline 一字不差（`本次跑分 N 张，跳过 M 张`）；
 * 有失败时追加 `，X 条失败`。
 *
 * 为什么不让状态栏与卡片各自拼标题：同一次跑分在两处给出不同数字是最容易漂移的一类
 * 缺陷；数字口径（哪些算失败）只在这里定义。退化情形（明细被删卡丢掉、只剩系统错误）
 * 没有「条」可数，如实说「X 个变体出错」，不编一个 0 条失败。
 */
export function runSummaryHeadline(report: QueueRunReport): string {
  const headline = planSummary(report.plan).headline;
  const { failureCount, errorVariantCount } = runFailureCounts(report);
  if (failureCount > 0) return `${headline}，${failureCount} 条失败`;
  if (errorVariantCount > 0) return `${headline}，${errorVariantCount} 个变体出错`;
  return headline;
}

/**
 * 汇总卡片的完整正文行：`[标题, ...跳过原因行, ...失败明细行]`。
 *
 * 失败明细必须点名变体（variantSummary）并原样带上失败原因：只写「1 条失败」的卡片
 * 和不说明没区别，用户点开汇总仍不知道是谁、为什么挂。
 */
/** 汇总卡片的三个部分：标题、跳过原因（列表）、失败明细（原文块）。 */
export interface RunSummarySections {
  headline: string;
  skipLines: string[];
  /** 每行「变体（编码器）：原因」，界面把它们放进可复制/可选中的详情块。 */
  failureLines: string[];
}

/**
 * 汇总卡片的正文分段。失败明细单独成段，是因为它要按「原文」展示（保留换行、
 * 可整块复制、也可只选一段右键复制），而跳过原因只是短句列表——两者混在一个
 * 列表里会让长原文把卡片撑成一大段。
 */
export function runSummarySections(report: QueueRunReport): RunSummarySections {
  const failureLines: string[] = [];
  for (const image of report.images) {
    const label = variantSummary(image.entry);
    if (image.failures.length > 0) {
      for (const failure of image.failures) {
        failureLines.push(`${label}（${failure.encoderId}）：${failure.reason}`);
      }
    } else if (image.error !== null) {
      // 明细被删卡丢掉的退化情形：至少把变体级错误原文留给用户
      failureLines.push(`${label}：${image.error}`);
    }
  }
  return {
    headline: runSummaryHeadline(report),
    skipLines: planSummary(report.plan).skipLines,
    failureLines,
  };
}

/** 汇总卡片的纯文本正文（标题 + 跳过原因 + 失败明细；通知/日志与单测用）。 */
export function runSummaryLines(report: QueueRunReport): string[] {
  const { headline, skipLines, failureLines } = runSummarySections(report);
  return [headline, ...skipLines, ...failureLines];
}

// ---------- 执行编排 ----------

/** 编码产物（只需面板接线要用的两个字段，AdvancedProductDto 结构性兼容）。 */
export interface EncodedProduct {
  path: string;
  encodingParams: string;
}

/**
 * 跑分执行器：动作层用真实 IPC 实现，测试用记录调用的假实现。
 *
 * 所有方法都作用于**当前评测轮**：变体不再自己建轮（取消独立轮次），产物直接进这一轮。
 */
export interface QueueRunExecutor {
  /** 编码一张卡；抛错 = 编码失败（编排层折成失败结果，不中断其它卡）。 */
  encode(
    entry: ImageEntry,
    planned: PlannedEncoder,
    conflicts: ConflictSession,
  ): Promise<EncodedProduct>;
  /** 把本次新增产物纳入当前轮。 */
  addCandidates(entry: ImageEntry, products: readonly EncodedProduct[]): Promise<void>;
  /** 只跑指定路径的跑分图（本次新增产物），返回逐行结果。 */
  scoreCandidates(entry: ImageEntry, paths: readonly string[]): Promise<ScoredCandidate[]>;
}

/** 编排层的界面回调（保持本模块零 DOM：面板负责弹卡片、刷新列表）。 */
export interface QueueRunHooks {
  /** 计划为空：只该弹提示卡片（内容按跳过原因分流，见 nothingToRunNotice），
   * 未调用执行器任何方法。 */
  onNothingToRun?(plan: ScorePlan): void;
  /** 开始生成一个变体（下标从 0 起）。 */
  onImageStart?(info: { label: string; index: number; total: number }): void;
  /** 一个变体生成并跑完（面板用来原地刷新列表状态）。 */
  onImageDone?(entry: ImageEntry): void;
  /** 产物命名冲突询问（面板接 askFileConflict；缺省时冲突会按失败处理）。 */
  askConflict?(fileName: string): Promise<ConflictAnswer>;
}

/** 单个变体的跑分结果（供面板汇总状态栏与失败详情）。 */
export interface QueueRunImageResult {
  entry: ImageEntry;
  /** 变体级错误（纳产物 / 跑分调用本身失败），null = 没有系统级错误。 */
  error: string | null;
  /** 跑完后该变体仍有效的失败明细（编码失败 + 产物行内跑分失败）。 */
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
 * 执行一个变体的跑分批次：逐卡编码（失败收集、不中断）→ 纳入本次新增产物 →
 * 只对本次新增产物跑分 → 按计划时指纹回写快照。
 *
 * 兜底口径：
 * - 一条产物都没产出：不写快照，失败写回变体（徽章显示「上次失败」、下次自动重试）；
 * - 编码成功但后续步骤（纳产物 / 跑分调用）抛错：成功结果降级成失败（没跑出指标
 *   就不算已跑分），避免「产物存在但没指标」被误记成已跑分；
 * - 系统级错误：**计划内每张卡**都记一条失败（编码本身失败的卡保留它更具体的原因）。
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
  let error: string | null = null;

  try {
    const conflicts = new ConflictSession(
      hooks.askConflict ?? (() => Promise.reject(new Error('缺少产物冲突询问入口'))),
    );
    for (const planned of batch.encoders) {
      try {
        const product = await executor.encode(entry, planned, conflicts);
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
      applyRunResults(entry, outcomes, identity);
      return { entry, error, failures: entryFailures(entry) };
    }

    await executor.addCandidates(entry, products);
    const scored = await executor.scoreCandidates(
      entry,
      products.map((product) => product.path),
    );
    applyRunResults(entry, mergeScoreFailures(outcomes, scored), identity);
  } catch (err) {
    error = errorText(err);
    // 系统级错误（纳产物 / 跑分调用本身抛错）也要落成**计划内每张卡**的失败：
    // 徽章只读 entry.failures——一条都不写会让变体停在「未跑分」，用户既看不到原因，
    // 也不确定下次会不会重试。编码本身失败的卡保留它更具体的原因。
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
 * 非空时按变体逐批执行，每个变体跑完回调 onImageDone，最后返回跑前计划供汇总卡片使用。
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
    // 计划生成后变体被删：按「不再需要跑」处理，不制造幽灵调用
    if (!entry) continue;
    hooks.onImageStart?.({ label: variantSummary(entry), index, total: batches.length });
    images.push(await runOneImage(entry, batch, probe, executor, hooks));
    hooks.onImageDone?.(entry);
  }
  return { plan, ran: true, images };
}

/**
 * 本轮里还需要跑分的跑分图（混合列表的候选侧增量口径）：还没有指标，或上次失败。
 *
 * 人工导入 / 一站式生成的图没有参数快照，可跳过的唯一依据就是「已经有指标且没失败」；
 * 变体侧的可跳过性由 planScore 的参数指纹与原图标识决定，两边合起来就是「已跑分将跳过」。
 */
export function candidatesNeedingScore(candidates: readonly CandidateImage[]): CandidateImage[] {
  return candidates.filter((candidate) => candidate.metrics === null || candidate.error !== null);
}
