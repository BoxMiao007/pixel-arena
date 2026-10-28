// 图片条目流程的共享运行时（票 #82 / T10）：**面板与主界面共用同一份跑分编排**。
//
// 为什么要有这个文件：票 #79 起，跑一次增量跑分的编排（读新原图标识 → 算计划 →
// 惰性建轮 / 只编码计划内的卡 / 只对本次产物跑分 → 状态栏 → 提示或汇总卡片）住在
// 列表面板里。票 #82 让主界面也能「重跑改过的（N 张）」并点胶囊开参数弹窗，如果再
// 写第二份编排，两条入口的增量语义（无待跑零调用、子集跑分、失败不算已跑分）迟早
// 会漂移——所以这里收成一份，面板与主界面都调它。
//
// 三条边界：
// 1. **不碰 IPC**：宿主能力经 QueueRuntimeDeps 注入（main.ts 提供实现，测试注入假实现），
//    所以「无待跑零调用」这类断言能在 node 环境真跑，不靠源码文本守卫。
// 2. **卡片渲染可注入**：生产默认值是 showQueueNotice（src/modal-card.ts 的共享模态），
//    测试注入假实现断言标题与正文，不需要 jsdom。
// 3. **原图标识是文件元数据**：面板与主界面共用同一份缓存（同一份 image_identities
//    结果的单一来源），避免「面板说已跑分、主界面说将重跑」两套判定。

import { ConflictSession, type ConflictAnswer } from './conflict';
import type { AdvancedProductDto } from '../ipc';
import type { ImageSpec } from './advanced';
import {
  imageIdentityFrom,
  probeFromCache,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageIdentityReading,
  type RoundSummary,
} from './entries';
import {
  nothingToRunNotice,
  runScorePlan,
  summaryLines,
  type QueueRunExecutor,
  type QueueRunReport,
  type ScoredCandidate,
} from './run';
import { fileName } from '../../../core/util';

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
 * 跑分编排对宿主的依赖（面板与主界面共用）。IPC 实现在 main.ts（imageQueueHostDeps），
 * 测试注入假实现。
 */
export interface QueueRuntimeDeps {
  /** 异步批量读原图标识（IPC image_identities；读不到的行带 error）。 */
  probeIdentities(paths: string[]): Promise<ImageIdentityDto[]>;
  /** 惰性建轮 + 激活：宿主按「现有轮数 + 1」与图片文件名生成轮名（roundName）。 */
  createRound(groupId: string, sourcePath: string): Promise<{ groupId: string; roundId: string }>;
  setReference(groupId: string, roundId: string, path: string): Promise<void>;
  /** 单个编码任务（advanced_encode；参数合并 / 冲突协议与高级创建面板同一实现）。 */
  encode(
    groupId: string,
    roundId: string,
    referencePath: string,
    card: ImageEntry['encoders'][number],
    conflicts: ConflictSession,
  ): Promise<AdvancedProductDto>;
  /** 产物带 encodingParams 纳入本轮。 */
  addCandidates(groupId: string, roundId: string, paths: string[], params: string[]): Promise<void>;
  /** 删除评测轮（惰性建轮的回滚 + 删条目连带删轮）。 */
  deleteRound(groupId: string, roundId: string): Promise<void>;
  /** 只跑指定路径的跑分图（增量：paths = 本次新增产物），返回逐行结果供失败判定。 */
  scoreRound(groupId: string, roundId: string, paths: string[]): Promise<ScoredCandidate[]>;
  /** 当前工作区里某轮的名字与结果条数；轮已不在工作区时返回 null。 */
  describeRound(groupId: string, roundId: string): RoundSummary | null;
  /** 跑分期间置宿主忙标志（面板提供；主界面自己持有忙标志时可不提供）。 */
  withBusy?<T>(task: () => Promise<T>): Promise<T>;
  /** 提示 / 汇总卡片的渲染（缺省用 showQueueNotice；测试注入假实现）。 */
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
 * 原图标识缓存（模块级：标识是文件元数据，跨面板开关、跨主界面重渲染是同一份事实）。
 * 面板与主界面共用它——否则同一个条目在两处会得到两个判定。
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
 * 读一批原图的标识并写入缓存（面板打开 / 添加图片 / 换图 / 跑分前都走这里）。
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
 * 把宿主依赖包成编排层的执行器：查轮存活 / 惰性建轮 / 设原图 / 单卡编码 / 纳产物 /
 * 子集跑分。所有 IPC 细节留在宿主侧，src/image-queue-run.ts 只负责顺序与失败兜底。
 */
export function buildQueueRunExecutor(
  groupId: string,
  deps: QueueRuntimeDeps,
): QueueRunExecutor {
  return {
    // 跑分前确认条目记着的轮还在工作区（被主界面删掉时编排层丢弃 id、惰性重建轮）
    describeRound: (_entry, roundId) => deps.describeRound(groupId, roundId),
    createRound: async (entry) => {
      const created = await deps.createRound(groupId, entry.path);
      return created.roundId;
    },
    setReference: (entry, roundId) => deps.setReference(groupId, roundId, entry.path),
    encode: (entry, roundId, planned, conflicts) => {
      deps.setStatus(
        `正在生成「${fileName(entry.path)}」的 ${planned.encoder.encoderId} 产物…`,
      );
      return deps.encode(groupId, roundId, entry.path, planned.encoder, conflicts);
    },
    addCandidates: (_entry, roundId, products) =>
      deps.addCandidates(
        groupId,
        roundId,
        products.map((product) => product.path),
        products.map((product) => product.encodingParams),
      ),
    scoreCandidates: (_entry, roundId, paths) => deps.scoreRound(groupId, roundId, [...paths]),
    deleteRound: (_entry, roundId) => deps.deleteRound(groupId, roundId),
  };
}

/** 队列里没有任何图片条目时的提示（主界面按钮在条目被清空后也会走到这里）。 */
export const EMPTY_QUEUE_MESSAGE =
  '还没有图片条目：到检视器「高级」分区点「＋ 添加图片」添加图片条目（新条目自带一条 JPEG 有损配置）';

/** 一次增量跑分编排的界面回调（面板刷新列表、主界面重渲染都是调用方的事）。 */
export interface QueuePlanRunHooks {
  /** 开始跑一张图（显示进度文案）。 */
  onImageStart?(info: { path: string; index: number; total: number }): void;
  /** 一张图跑完（调用方原地刷新自己的界面）。 */
  onImageDone?(entry: ImageEntry): void;
  /** 产物命名冲突询问（缺省 askFileConflict，与高级创建面板同一套弹窗）。 */
  askConflict?(fileName: string): Promise<ConflictAnswer>;
}

/** 跑一次增量计划所需的全部输入。 */
export interface QueuePlanRunOptions {
  /** 条目所属跑分组 id（工作区写入都落在这个组）。 */
  groupId: string;
  /** 当前组的条目队列（面板与主界面的会话态是同一份）。 */
  entries: readonly ImageEntry[];
  deps: QueueRuntimeDeps;
  hooks?: QueuePlanRunHooks;
}

/** 宿主没提供忙标志广播时直接跑（主界面自己持有 scoring 忙标志）。 */
function withOptionalBusy<T>(deps: QueueRuntimeDeps, task: () => Promise<T>): Promise<T> {
  return deps.withBusy ? deps.withBusy(task) : task();
}

/**
 * 跑一次增量跑分计划（面板的「跑分 / 重跑」与主界面的「重跑改过的（N 张）」共用）。
 *
 * 顺序与口径（票面验收）：
 * 1. 没有条目：只提示、连原图标识都不读（没有可跑的东西，别制造 IPC 噪声）；
 * 2. 先把原图标识读新：计划与快照比对必须基于当前文件大小 / 修改时间；
 * 3. 交给 runScorePlan：计划为空时**不调用执行器的任何方法**，只弹提示卡片
 *    （内容按跳过原因分流：全部 clean ≠ 没有编码器配置）；
 * 4. 有待跑：逐图执行，每张跑完回调 onImageDone，最后弹汇总卡片（本次 N 张、
 *    跳过 M 张 + 逐张跳过原因）；
 * 5. 失败进状态栏（`跑分失败：…`）与条目的失败记录，不向上抛——调用方只负责
 *    把自己的界面刷新回来。
 *
 * 返回值：跑前的计划与逐图结果；没有条目或流程抛错时返回 null。
 */
export async function runQueuePlanOnce(
  options: QueuePlanRunOptions,
): Promise<QueueRunReport | null> {
  const { groupId, entries, deps } = options;
  // 提示卡片由调用方注入（本层保持零 DOM：node 单测不引入 jsdom）
  const showNotice = deps.showNotice ?? (() => undefined);

  if (entries.length === 0) {
    deps.setStatus(EMPTY_QUEUE_MESSAGE, true);
    showNotice([EMPTY_QUEUE_MESSAGE], { title: '无需重跑' });
    return null;
  }

  try {
    await refreshQueueIdentities(deps, entries.map((entry) => entry.path));
    const probe = queueIdentityProbe();
    const report = await withOptionalBusy(deps, () =>
      runScorePlan(entries, probe, buildQueueRunExecutor(groupId, deps), {
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
      deps.setStatus(`跑分完成：${report.plan.runImageCount} 张图片已更新`);
    } else {
      deps.setStatus(
        `跑分完成：${report.plan.runImageCount} 张图片已更新；${failedCount} 条失败` +
          (systemErrors > 0 ? `，${systemErrors} 张图出错` : '') +
          '（详情见列表徽章）',
        true,
      );
    }
    // 汇总卡片：本次跑分 N 张，跳过 M 张 + 逐张跳过原因
    showNotice(summaryLines(report.plan), { title: '跑分汇总' });
    return report;
  } catch (err) {
    deps.setStatus(`跑分失败：${String(err)}`, true);
    return null;
  }
}


/** 逐图编辑界面对宿主的依赖（本层只声明契约，DOM 由 features/encoding/overlay 实现）。 */
export interface ImageEntryEditorDeps {
  /** 拉图片编码器目录（advanced_image_catalog 的 ImageSpec[]）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  /** 系统文件对话框选一个图片（取消返回 null）。 */
  pickImage(): Promise<string | null>;
  /** 清掉某条目对应评测轮里的跑分行（round_clear_candidates）。 */
  clearCandidates(groupId: string, roundId: string): Promise<void>;
  /** 读某轮的名字与结果条数；轮已不在工作区返回 null。 */
  describeRound(roundId: string): RoundSummary | null;
  /** 读一次原图标识并写入判定缓存（换图后调用）。 */
  refreshIdentity(path: string): Promise<void>;
  /** 判定用的同步探针（列表与弹窗共用同一份标识缓存）。 */
  identityProbe(): ImageIdentityProbe;
  /** 弹窗内修改后同步列表（徽章/按钮计数立即更新）。 */
  onChanged(): void;
  setStatus(text: string, isError?: boolean): void;
}

// ---------- 逐图编辑弹窗的接线 ----------

/** 逐图编辑弹窗的宿主能力（面板 ImageQueueDeps 与主界面宿主依赖都满足这份形状）。 */
export interface QueueEditorHostDeps extends QueueRuntimeDeps {
  /** 拉图片编码器目录（advanced_image_catalog）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  /** 系统单选对话框选一张新图片（换图）；取消返回 null。 */
  pickReplacementImage(): Promise<string | null>;
  /** 清空某轮跑分图行（换图前清旧行；原图与轮保留，磁盘产物文件不删）。 */
  clearCandidates(groupId: string, roundId: string): Promise<void>;
}

/**
 * 逐图编辑弹窗的依赖（票 #82：面板点行与主界面点胶囊共用一份接线）。
 *
 * 共用是为了让「改参数 / 加删卡 / 换图 / 恢复默认」两条入口一字不差地落回同一个
 * 会话态条目对象：弹窗本身不写第二套逻辑，这里也不复制第二份 deps。
 */
export function queueEditorDeps(
  groupId: string,
  deps: QueueEditorHostDeps,
  onChanged: () => void,
): ImageEntryEditorDeps {
  return {
    loadImageCatalog: () => deps.loadImageCatalog(),
    pickImage: () => deps.pickReplacementImage(),
    clearCandidates: (groupIdOfCall, roundId) => deps.clearCandidates(groupIdOfCall, roundId),
    describeRound: (roundId) => deps.describeRound(groupId, roundId),
    refreshIdentity: (path) => refreshQueueIdentities(deps, [path]),
    identityProbe: () => queueIdentityProbe(),
    onChanged,
    setStatus: deps.setStatus,
  };
}
