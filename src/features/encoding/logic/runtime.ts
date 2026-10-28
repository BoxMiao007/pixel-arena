// 参数变体流程的共享运行时：**检视器分区与主界面共用同一份跑分编排**。
//
// 票「变体并入当前轮」后，增量跑分的编排（读新原图标识 → 算计划 → 只编码计划内的卡 →
// 只把本次产物纳入当前轮 → 只对本次产物跑分 → 状态栏 → 提示或汇总卡片）仍然只此一份：
// 「重跑改过的（N 张）」、分区里的「生成并跑分」与「开始跑分」都调它，两条入口的增量
// 语义（无待跑零调用、子集跑分、失败不算已跑分）不会漂移。
//
// 三条边界：
// 1. **不碰 IPC**：宿主能力经 QueueRuntimeDeps 注入（actions.ts 提供实现，测试注入假实现），
//    所以「无待跑零调用」这类断言能在 node 环境真跑，不靠源码文本守卫。
// 2. **卡片渲染可注入**：生产默认值是 showNoticeCard（overlay/notice.ts 的共享模态），
//    测试注入假实现断言标题与正文，不需要 jsdom。
// 3. **原图标识是文件元数据**：分区、编辑弹窗与主界面共用同一份缓存（同一份
//    image_identities 结果的单一来源），避免两处给出两套判定。

import { ConflictSession, type ConflictAnswer } from './conflict';
import type { AdvancedProductDto } from '../ipc';
import type { ImageSpec } from './advanced';
import {
  imageIdentityFrom,
  probeFromCache,
  variantSummary,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageIdentityReading,
} from './entries';
import {
  nothingToRunNotice,
  runScorePlan,
  summaryLines,
  type QueueRunExecutor,
  type QueueRunReport,
  type ScoredCandidate,
} from './run';

// ---------- 与后端的薄契约 ----------

/**
 * image_identities IPC 回包的一行（camelCase，与 src-tauri 的 ImageIdentityDto 一一对应）：
 * 读不到文件时 sizeBytes / modifiedMs 为 null、error 给出中文原因，前端据此走
 * 「读取失败 → 保守判已变更」的既有分支（T2 的 ImageIdentityReading）。
 */
export interface ImageIdentityDto {
  path: string;
  sizeBytes: number | null;
  modifiedMs: number | null;
  error: string | null;
}

/**
 * 跑分编排对宿主的依赖（分区、主界面与「开始跑分」共用）。IPC 实现在 actions.ts
 * （variantDeps），测试注入假实现。
 *
 * 变体不再建轮：roundId 由调用方给出（永远是当前评测轮），所有写入都落这一轮。
 */
export interface QueueRuntimeDeps {
  /** 异步批量读原图标识（IPC image_identities；读不到的行带 error）。 */
  probeIdentities(paths: string[]): Promise<ImageIdentityDto[]>;
  /** 单个编码任务（advanced_encode；参数合并 / 冲突协议与高级创建面板同一实现）。 */
  encode(
    groupId: string,
    roundId: string,
    referencePath: string,
    card: ImageEntry['encoders'][number],
    conflicts: ConflictSession,
  ): Promise<AdvancedProductDto>;
  /** 产物带 encodingParams 纳入当前轮。 */
  addCandidates(groupId: string, roundId: string, paths: string[], params: string[]): Promise<void>;
  /** 只跑指定路径的跑分图（增量：paths = 本次新增产物），返回逐行结果供失败判定。 */
  scoreRound(groupId: string, roundId: string, paths: string[]): Promise<ScoredCandidate[]>;
  /** 跑分期间置宿主忙标志（调用方提供；主界面自己持有忙标志时可不提供）。 */
  withBusy?<T>(task: () => Promise<T>): Promise<T>;
  /** 提示 / 汇总卡片的渲染（缺省用 showNoticeCard；测试注入假实现）。 */
  showNotice?(lines: readonly string[], options: QueueNoticeOptions): void;
  setStatus(text: string, isError?: boolean, title?: string): void;
}

// ---------- 标识回包适配（纯函数，node 环境可测） ----------

/**
 * 把 image_identities 的回包折成 T2 的「标识读取」缓存（喂 probeFromCache）。
 *
 * 有 error 的行原样透传后端原因；没有 error 的行走 imageIdentityFrom 的口径校验
 * （字段缺失或不是有限数一律算读取失败 → 判定保守重跑，绝不误跳过）。
 */
export function identityReadingsOf(dtos: ImageIdentityDto[]): Map<string, ImageIdentityReading> {
  const readings = new Map<string, ImageIdentityReading>();
  for (const dto of dtos) {
    if (dto.error !== null && dto.error !== undefined) {
      readings.set(dto.path, { kind: 'failed', path: dto.path, reason: dto.error });
      continue;
    }
    readings.set(
      dto.path,
      imageIdentityFrom(dto.path, {
        sizeBytes: dto.sizeBytes ?? undefined,
        modifiedMs: dto.modifiedMs ?? undefined,
      }),
    );
  }
  return readings;
}

/**
 * 原图标识缓存（模块级：标识是文件元数据，跨分区开关、跨主界面重渲染是同一份事实）。
 * 分区与编辑弹窗共用它——否则同一个变体在两处会得到两个判定。
 */
const identityCache = new Map<string, ImageIdentityReading>();

/** 判定用的同步探针（缓存里没有的路径按读取失败处理 → 保守重跑）。 */
export function queueIdentityProbe(): ImageIdentityProbe {
  return probeFromCache(identityCache);
}

/** 清空标识缓存（测试用；生产里标识只会被更新，不需要清）。 */
export function clearImageQueueIdentities(): void {
  identityCache.clear();
}

/**
 * 读一批原图的标识并写入缓存（分区打开 / 新建变体 / 换原图 / 跑分前都走这里）。
 *
 * 读不到不是致命错误：probeFromCache 缺项一律按读取失败处理（保守重跑），
 * 所以这里只警告、不抛——把「读元数据失败」升级成「不能跑分」是过度反应。
 */
export async function refreshQueueIdentities(
  deps: Pick<QueueRuntimeDeps, 'probeIdentities'>,
  paths: readonly string[],
): Promise<void> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return;
  try {
    const dtos = await deps.probeIdentities(unique);
    for (const [path, reading] of identityReadingsOf(dtos)) identityCache.set(path, reading);
  } catch (err) {
    console.warn('读取原图信息失败（判定将按已变更保守处理）:', err);
  }
}

// ---------- 提示 / 汇总卡片 ----------

/** 卡片选项（标题；正文行由调用方给）。 */
export interface QueueNoticeOptions {
  /** 卡片标题（如「无需重跑」「跑分汇总」）。 */
  title: string;
}

// ---------- 执行器与跑一次计划 ----------

/**
 * 把宿主依赖包成编排层的执行器：单卡编码 / 纳产物 / 子集跑分。所有 IPC 细节留在
 * 宿主侧，本模块只负责顺序与失败兜底。roundId 是当前评测轮（变体不再建轮）。
 */
export function buildQueueRunExecutor(
  groupId: string,
  roundId: string,
  deps: QueueRuntimeDeps,
): QueueRunExecutor {
  return {
    encode: (entry, planned, conflicts) => {
      deps.setStatus(
        `正在生成「${variantSummary(entry)}」的 ${planned.encoder.encoderId} 产物…`,
      );
      return deps.encode(groupId, roundId, entry.path, planned.encoder, conflicts);
    },
    addCandidates: (_entry, products) =>
      deps.addCandidates(
        groupId,
        roundId,
        products.map((product) => product.path),
        products.map((product) => product.encodingParams),
      ),
    scoreCandidates: (_entry, paths) => deps.scoreRound(groupId, roundId, [...paths]),
  };
}

/** 本轮一个参数变体都没有时的提示（入口指引，不是错误）。 */
export const EMPTY_VARIANTS_MESSAGE =
  '本轮还没有参数变体：右键已跑分的图选「高级选项」，或在「跑分图」分区点「＋ 新建参数变体」';

/** 一次增量跑分编排的界面回调（分区刷新列表、主界面重渲染都是调用方的事）。 */
export interface QueuePlanRunHooks {
  /** 开始生成一个变体（显示进度文案）。 */
  onImageStart?(info: { label: string; index: number; total: number }): void;
  /** 一个变体跑完（调用方原地刷新自己的界面）。 */
  onImageDone?(entry: ImageEntry): void;
  /** 产物命名冲突询问（缺省 askFileConflict，与高级创建面板同一套弹窗）。 */
  askConflict?(fileName: string): Promise<ConflictAnswer>;
}

/** 跑一次增量计划所需的全部输入。 */
export interface QueuePlanRunOptions {
  /** 变体所属跑分组 id（工作区写入都落在这个组）。 */
  groupId: string;
  /** 当前评测轮 id（产物与跑分都落这一轮）。 */
  roundId: string;
  /** 本轮变体的会话态（与分区渲染同一份）。 */
  entries: readonly ImageEntry[];
  deps: QueueRuntimeDeps;
  hooks?: QueuePlanRunHooks;
}

/** 宿主没提供忙标志广播时直接跑（主界面自己持有 scoring 忙标志）。 */
function withOptionalBusy<T>(deps: QueueRuntimeDeps, task: () => Promise<T>): Promise<T> {
  return deps.withBusy ? deps.withBusy(task) : task();
}

/**
 * 跑一次增量跑分计划（分区的「生成并跑分」与主界面的「开始跑分 / 重跑改过的」共用）。
 *
 * 顺序与口径：
 * 1. 没有变体：直接返回 null（调用方负责给入口指引，不在本层弹卡片）；
 * 2. 先把原图标识读新：计划与快照比对必须基于当前文件大小 / 修改时间；
 * 3. 交给 runScorePlan：计划为空时**不调用执行器的任何方法**，只弹提示卡片
 *    （内容按跳过原因分流：全部 clean ≠ 没有编码器配置）；
 * 4. 有待跑：逐变体执行，每个跑完回调 onImageDone，最后弹汇总卡片
 *    （本次 N 个变体、跳过 M 个 + 逐个跳过原因）；
 * 5. 失败进状态栏（`跑分失败：…`）与变体的失败记录，不向上抛——调用方只负责
 *    把自己的界面刷新回来。
 *
 * 返回值：跑前的计划与逐变体结果；没有变体或流程抛错时返回 null。
 */
export async function runQueuePlanOnce(
  options: QueuePlanRunOptions,
): Promise<QueueRunReport | null> {
  const { groupId, roundId, entries, deps } = options;
  // 提示卡片由调用方注入（本层保持零 DOM：node 单测不引入 jsdom）
  const showNotice = deps.showNotice ?? (() => undefined);

  if (entries.length === 0) return null;

  try {
    await refreshQueueIdentities(deps, entries.map((entry) => entry.path));
    const report = await withOptionalBusy(deps, () =>
      runScorePlan(entries, queueIdentityProbe(), buildQueueRunExecutor(groupId, roundId, deps), {
        onImageStart: options.hooks?.onImageStart,
        onImageDone: options.hooks?.onImageDone,
        askConflict: options.hooks?.askConflict,
      }),
    );
    if (!report.ran) {
      // 无待跑：只弹提示卡片，runScorePlan 未执行任何编码/跑分调用。
      // 原因按 skippedImages 分流——「没有编码器配置」不等于「已跑分且无变更」。
      const notice = nothingToRunNotice(report.plan);
      deps.setStatus(notice.lines.join('；'));
      showNotice(notice.lines, { title: notice.title });
      return report;
    }
    const failedCount = report.images.reduce((sum, image) => sum + image.failures.length, 0);
    const systemErrors = report.images.filter((image) => image.error !== null).length;
    if (failedCount === 0 && systemErrors === 0) {
      deps.setStatus(`跑分完成：${report.plan.runImageCount} 个参数变体已更新`);
    } else {
      deps.setStatus(
        `跑分完成：${report.plan.runImageCount} 个参数变体已更新；${failedCount} 条失败` +
          (systemErrors > 0 ? `，${systemErrors} 个变体出错` : '') +
          '（详情见列表徽章）',
        true,
      );
    }
    // 汇总卡片：本次跑分 N 个，跳过 M 个 + 逐个跳过原因
    showNotice(summaryLines(report.plan), { title: '跑分汇总' });
    return report;
  } catch (err) {
    deps.setStatus(`跑分失败：${String(err)}`, true);
    return null;
  }
}

// ---------- 参数编辑区的依赖 ----------

/** 参数编辑区对宿主的依赖（本层只声明契约，DOM 由 features/encoding/overlay 实现）。 */
export interface ImageEntryEditorDeps {
  /** 拉图片编码器目录（advanced_image_catalog 的 ImageSpec[]）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  /** 判定用的同步探针（列表与编辑弹窗共用同一份标识缓存）。 */
  identityProbe(): ImageIdentityProbe;
  /** 修改后同步列表（徽章/按钮计数立即更新）。 */
  onChanged(): void;
  setStatus(text: string, isError?: boolean): void;
}

/** 参数编辑区的最小宿主能力（actions.ts 的 variantDeps 已满足）。 */
export interface QueueEditorHostDeps {
  /** 拉图片编码器目录（advanced_image_catalog）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  setStatus(text: string, isError?: boolean): void;
}

/**
 * 参数编辑区的依赖（分区就地展开与「高级选项」弹窗共用一份接线）。
 *
 * 共用是为了让「改参数 / 加删卡 / 恢复默认」两条入口一字不差地落回同一个会话态变体：
 * 编辑区本身不写第二套逻辑，这里也不复制第二份 deps。
 */
export function queueEditorDeps(
  deps: QueueEditorHostDeps,
  onChanged: () => void,
): ImageEntryEditorDeps {
  return {
    loadImageCatalog: () => deps.loadImageCatalog(),
    identityProbe: () => queueIdentityProbe(),
    onChanged,
    setStatus: deps.setStatus,
  };
}
