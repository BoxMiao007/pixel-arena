// 参数变体与增量跑分判定的纯逻辑（票 #76；票「变体并入当前轮」后改为按轮键控）。
//
// 术语与数据形状：
// - **参数变体**：本轮原图 + 它自己的一整套编码器配置，是「跑分图」列表里的一行；
//   产物入**当前评测轮**，与人工导入 / 一站式生成的跑分图同列表混合展示；
// - **编码器卡片**：变体里的编码器配置，数据形状就是 advanced.ts 的 AdvancedEntry（本模块
//   只引用、不改它）；
// - **跑分快照**：该变体最近一次**成功**跑分时记下的原图标识 + 逐卡参数指纹与产物路径；
// - **增量跑分**：只跑脏的编码器卡，未变更的复用上一轮结果。
//
// 三条设计约束（也是本模块能进 node 环境单测的原因）：
// 1. **零 DOM、零 IPC、零文件读取**。原图标识要读文件元数据，但读盘是调用方的事：调用方
//    先异步批量读好元数据，再把一个**同步查表函数**（ImageIdentityProbe）传进来。读不到
//    文件用 ImageIdentityReading 的失败分支显式表达，判定按「已变更」保守重跑。
// 2. **失败永远不算已跑分**：快照只接收成功结果；失败单独记在 ImageEntry.failures 里，
//    所以「失败条目永远保持待跑」由数据结构本身保证，不靠判定时额外判断。
// 3. **仅会话态**：变体、参数、快照全部活在模块级 Map 里（按组 → 轮两级键控），不写
//    workspace.json，重启归零（决策 0031：条目 / 参数 / 快照不进工作区格式）。

import { newEntry, newEntryId, type AdvancedEntry, type ImageSpec } from './advanced';

/** 编码器卡片：直接复用高级创建的条目形状（字段语义见 advanced.ts），不另造一套模型。 */
export type EncoderCard = AdvancedEntry;

// ---------- 原图标识与读取 ----------

/** 原图标识：路径 + 文件大小 + 修改时间（毫秒时间戳）。
 *
 * 不读文件内容：大图开销与「更换图片是显式按钮」的语义都指向这条口径。已知边界——
 * 外部工具原地覆写同名同大小文件时，只有修改时间能抓到。
 */
export interface ImageIdentity {
  path: string;
  sizeBytes: number;
  modifiedMs: number;
}

/** 读取原图标识的结果。失败是一支显式的类型，而不是 null 或抛错：文件被移走/不可读
 * 时判定必须走「已变更」的保守分支，这个语义要在类型上看得见。 */
export type ImageIdentityReading =
  | { kind: 'ok'; identity: ImageIdentity }
  | { kind: 'failed'; path: string; reason: string };

/** 读取原图标识的注入点（**必须是同步函数**：界面层先用异步 IPC 批量读好元数据，
 * 再把查表函数传进来；纯逻辑层不自己读盘）。 */
export type ImageIdentityProbe = (path: string) => ImageIdentityReading;

/**
 * 由调用方读到的文件元数据构造原图标识。metadata 缺失，或大小/修改时间不是有限数
 * （文件不可读、已被移走）时返回读取失败的一支——判定会按「已变更」保守重跑。
 */
export function imageIdentityFrom(
  path: string,
  metadata: { sizeBytes?: number; modifiedMs?: number } | null | undefined,
): ImageIdentityReading {
  if (!metadata) {
    return { kind: 'failed', path, reason: '读取原图信息失败：文件可能已被移走或不可读' };
  }
  const { sizeBytes, modifiedMs } = metadata;
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    typeof modifiedMs !== 'number' ||
    !Number.isFinite(modifiedMs)
  ) {
    return { kind: 'failed', path, reason: '读取原图信息失败：文件大小或修改时间不可用' };
  }
  return { kind: 'ok', identity: { path, sizeBytes, modifiedMs } };
}

/** 原图标识是否已变更（路径 / 大小 / 修改时间任一不同）。读取失败一律算已变更。 */
export function identityChanged(previous: ImageIdentity, current: ImageIdentityReading): boolean {
  if (current.kind === 'failed') return true;
  const next = current.identity;
  return (
    previous.path !== next.path ||
    previous.sizeBytes !== next.sizeBytes ||
    previous.modifiedMs !== next.modifiedMs
  );
}

/** 读一次标识，并把「探针自己抛错」也归一成失败分支（读盘失败的实现常常是抛异常）。 */
function readIdentity(probe: ImageIdentityProbe, path: string): ImageIdentityReading {
  try {
    return probe(path);
  } catch (err) {
    return { kind: 'failed', path, reason: `读取原图信息失败：${String((err as Error)?.message ?? err)}` };
  }
}

/**
 * 由界面层维护的「路径 → 读取结果」缓存构造同步探针（推荐用法：面板打开时、添加/换图后
 * 异步批量读取元数据并写入缓存，判定时同步查表）。
 *
 * 缓存里没有的路径按**读取失败**返回（判定会保守地判「已变更」）：宁可多跑一次，
 * 也不在没有文件元数据时错误地跳过一张图。
 */
export function probeFromCache(
  cache: ReadonlyMap<string, ImageIdentityReading>,
): ImageIdentityProbe {
  return (path) =>
    cache.get(path) ?? {
      kind: 'failed',
      path,
      reason: '尚未读取原图信息（文件可能已被移走或不可读）',
    };
}

// ---------- 快照与失败记录 ----------

/** 单张编码器卡在快照里的记录：它上次成功跑分时用的参数指纹与产物。 */
export interface EncoderSnapshot {
  /** 编码器卡 id（= AdvancedEntry.id，不是图片条目 id）。 */
  cardId: string;
  /** 参数指纹（只用于比对，不上屏、不落盘）。 */
  fingerprint: string;
  /** 上次成功的产物路径（复用时由调用方直接沿用，不重新编码）。 */
  artifactPath: string;
}

/** 跑分快照：该图片条目最近一次**成功**跑分时的原图标识 + 逐卡记录。
 * 只收成功；一次成功都没有时为 null（见 applyRunResults）。 */
export interface ScoreSnapshot {
  identity: ImageIdentity;
  encoders: EncoderSnapshot[];
}

/** 单张编码器卡上一次跑分失败的原因（不属于快照：失败永远不算已跑分）。 */
export interface EntryFailure {
  cardId: string;
  reason: string;
}

/** 一个参数变体（「跑分图」列表里的一行：一个待生成 / 已生成的图片）。
 *
 * 原图不是变体自带的属性：变体永远编码**本轮原图**（路径由 syncEntryReference 与本轮同步），
 * 所以同一轮的变体天然可横向对比；原图换了，变体的快照整体作废（replaced 置位）。
 */
export interface ImageEntry {
  /** 变体 id（会话内唯一）。 */
  id: string;
  /** 本轮原图路径（由 syncEntryReference 与工作区保持一致；编码输入与标识口径都用它）。 */
  path: string;
  /** 该变体的全部编码器卡（顺序参与指纹与产物生成顺序）。 */
  encoders: EncoderCard[];
  /** 最近一次成功跑分的快照；null = 从未成功跑分。 */
  snapshot: ScoreSnapshot | null;
  /** 上一次跑分的失败记录（只记当前仍存在的卡片，见 applyRunResults）。 */
  failures: EntryFailure[];
  /** 原图换过（或创建时即声明结果作废）：旧结果整体失效，跑分结果写入后清除。 */
  replaced: boolean;
}

/** 一个评测轮的参数变体会话态（仅内存，重启归零）。 */
export interface ImageQueueSession {
  /** 条目列表（顺序即列表面板顺序）。 */
  entries: ImageEntry[];
}

/**
 * 评测轮的最小信息（宿主从工作区读，会话态不自己持有工作区）：确认文案要点名轮名与
 * 结果条数。删条目确认（列表面板）与换图确认（逐图编辑弹窗）共用这一份形状，避免两处
 * 各自声明一个 `{ name, candidateCount }` 后漂移。
 */
export interface RoundSummary {
  name: string;
  candidateCount: number;
}

// ---------- 会话态（模块级 Map：切标签保留、重启归零，不写 workspace.json） ----------

/** 组 id → 轮 id → 该轮的变体列表（两级键控：关组时整组一次丢弃）。 */
const queues = new Map<string, Map<string, ImageQueueSession>>();

let nextImageId = 1;

/** 生成变体 id（会话内唯一即可）。 */
export function newImageEntryId(): string {
  return `img-${nextImageId++}`;
}

/** 取某个评测轮的参数变体列表；首次用到时建空列表。 */
export function imageQueueFor(groupId: string, roundId: string): ImageQueueSession {
  let rounds = queues.get(groupId);
  if (!rounds) {
    rounds = new Map<string, ImageQueueSession>();
    queues.set(groupId, rounds);
  }
  let session = rounds.get(roundId);
  if (!session) {
    session = { entries: [] };
    rounds.set(roundId, session);
  }
  return session;
}

/** 丢弃某个跑分组的全部变体（跑分组被删时调用；组 id 不复用）。 */
export function dropImageQueue(groupId: string): void {
  queues.delete(groupId);
}

/** 清空全部队列（「重启归零」语义的显式入口；测试用）。 */
export function clearImageQueues(): void {
  queues.clear();
}

// ---------- 默认配置 ----------

/** 新条目默认编码器：JPEG。 */
export const DEFAULT_IMAGE_ENCODER_ID = 'jpeg';

/** 新条目默认 JPEG 质量（与后端 image_specs 的 jpeg 默认质量一致）。 */
export const DEFAULT_JPEG_QUALITY = 75;

/** 默认目标大小（质量模式下用不到，仅作占位；与 advanced.newEntry 同值，保持两处默认一致）。 */
const DEFAULT_TARGET_BYTES = 200 * 1024;

/** 新建一张默认编码器卡（有损、质量优先、规格默认质量、无参数行）。
 * 字段取值与 advanced.newEntry 的默认一致，只是这里不依赖后端规格表。 */
function defaultJpegCard(): EncoderCard {
  return {
    id: newEntryId(),
    kind: 'image',
    encoderId: DEFAULT_IMAGE_ENCODER_ID,
    lossless: false,
    mode: 'quality',
    quality: DEFAULT_JPEG_QUALITY,
    targetBytes: DEFAULT_TARGET_BYTES,
    unit: 'KB',
    rows: [],
  };
}

/** 新条目自带的编码器配置：一条 JPEG 有损配置（添加完就能直接跑，不用先做配置）。 */
export function defaultImageEncoders(): EncoderCard[] {
  return [defaultJpegCard()];
}

/** 图片扩展名 → 编码器 id（认不出按默认 JPEG）。 */
const EXT_ENCODER: Record<string, string> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  avif: 'avif',
  jxl: 'jxl',
  png: 'png',
};

/**
 * 人工导入 / 一站式产出的图对应的「预设参数卡」：右键复制它时的起头参数。
 *
 * 这张图的真实参数没有暴露给工具（外部工具压的，encodingParams 只是展示文本），所以按
 * 同格式规格的默认值取；认不出格式或目录里没有该规格时退回默认 JPEG 卡——宁可给一个
 * 保守的默认，也不假装知道原图的参数。
 */
export function presetCardFor(imagePath: string, specs: readonly ImageSpec[]): EncoderCard {
  const ext = imagePath.split('.').pop()?.toLowerCase() ?? '';
  const encoderId = EXT_ENCODER[ext] ?? DEFAULT_IMAGE_ENCODER_ID;
  const spec = specs.find((item) => item.id === encoderId);
  return spec ? newEntry('image', spec.id, spec) : defaultJpegCard();
}

/** 新建一个参数变体（默认带一条 JPEG 有损配置，无快照、无失败记录）。 */
export function newImageEntry(path: string): ImageEntry {
  return {
    id: newImageEntryId(),
    path,
    encoders: defaultImageEncoders(),
    snapshot: null,
    failures: [],
    replaced: false,
  };
}

/**
 * 深拷贝一张编码器卡：新卡片 id，参数行逐条复制（含候选选项）。
 *
 * 复制出来的变体必须与原变体完全解耦——共享行对象会让「复制后调参」悄悄改掉原图。
 */
export function cloneCard(card: EncoderCard): EncoderCard {
  return {
    ...card,
    id: newEntryId(),
    rows: card.rows.map((row) => ({ ...row, options: [...row.options] })),
  };
}

/** 由一张编码器卡派生参数变体（右键「高级选项」的复制落点）。 */
export function variantFromCard(path: string, card: EncoderCard): ImageEntry {
  return {
    id: newImageEntryId(),
    path,
    encoders: [cloneCard(card)],
    snapshot: null,
    failures: [],
    replaced: false,
  };
}

/** 由一张编码器卡建一个「普通变体」：用预设参数填充，不复制任何已有记录。 */
export function newVariant(path: string, cards: EncoderCard[] = defaultImageEncoders()): ImageEntry {
  return {
    id: newImageEntryId(),
    path,
    encoders: cards,
    snapshot: null,
    failures: [],
    replaced: false,
  };
}

/** 按变体 id 删除；返回被删变体，找不到返回 null。 */
export function removeImageEntry(entries: ImageEntry[], imageId: string): ImageEntry | null {
  const index = entries.findIndex((entry) => entry.id === imageId);
  if (index < 0) return null;
  return entries.splice(index, 1)[0] ?? null;
}

/**
 * 让变体跟上本轮原图：路径不同即整体作废（快照 / 失败清掉、replaced 置位）。
 *
 * 为什么必须整体作废：产物是按旧原图编出来的，留在列表里就是「旧图产物 vs 新原图」
 * 的骗人对比；同时后端换原图本身也会清掉已有指标。
 * 返回是否有变体被改写（界面据此重绘）。
 */
export function syncEntryReference(
  entries: readonly ImageEntry[],
  referencePath: string | null,
): boolean {
  if (referencePath === null || referencePath === '') return false;
  let changed = false;
  for (const entry of entries) {
    if (entry.path === referencePath) continue;
    replaceImagePath(entry, referencePath);
    changed = true;
  }
  return changed;
}

/**
 * 更换原图：编码器配置与参数原样保留，旧结果整体作废。
 *
 * 为什么连快照一起清、还要多一个 replaced 标记：只靠「原图标识变了」判断换图会漏掉
 * 「换走又换回同一张、标识恰好相同」的情形；换图是**显式动作**，显式动作必须让旧结果
 * 无条件失效（父规格「已知边界」：指纹只是额外保险）。清掉快照是为了不留下指向旧图的
 * 产物路径；replaced 负责在清掉快照之后仍能报出「图片换了」。失败记录同样作废。
 */
export function replaceImagePath(entry: ImageEntry, path: string): void {
  entry.path = path;
  entry.snapshot = null;
  entry.failures = [];
  entry.replaced = true;
}

/**
 * 从变体快照里抹掉一条产物记录（这张跑分图被用户从本轮移除了）。
 *
 * 不抹掉的话判定仍会说「已跑分且无变更」，而它的产物已经不在本轮——增量跑分会永远跳过
 * 它，界面上也再没有它的行。抹掉后判定回到「从没跑过」，下次跑分重新生成。
 */
export function forgetArtifact(entry: ImageEntry, artifactPath: string): boolean {
  if (entry.snapshot === null) return false;
  const kept = entry.snapshot.encoders.filter((record) => record.artifactPath !== artifactPath);
  if (kept.length === entry.snapshot.encoders.length) return false;
  entry.snapshot = kept.length > 0 ? { identity: entry.snapshot.identity, encoders: kept } : null;
  return true;
}

/** 由一张跑分图反查产生它的编码器卡（右键「高级选项」要复制这张卡的参数）。 */
export function cardForArtifact(entry: ImageEntry, artifactPath: string): EncoderCard | null {
  const record = entry.snapshot?.encoders.find((item) => item.artifactPath === artifactPath);
  if (!record) return null;
  return entry.encoders.find((card) => card.id === record.cardId) ?? null;
}

// ---------- 展示文案 ----------

/** 编码器 id → 展示名（与编码器目录的 label 同口径；目录没加载时也能出文案）。 */
const ENCODER_LABELS: Record<string, string> = {
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  png: 'PNG',
};

export function encoderLabel(encoderId: string): string {
  return ENCODER_LABELS[encoderId] ?? encoderId.toUpperCase();
}

/** 一张编码器卡的一句话摘要（「JPEG q75」「WebP 无损」「AVIF 目标 200 KB」）。 */
export function cardSummary(card: EncoderCard): string {
  const label = encoderLabel(card.encoderId);
  if (card.lossless) return `${label} 无损`;
  if (card.mode === 'size') return `${label} 目标 ${Math.max(1, Math.round(card.targetBytes / 1024))} KB`;
  return `${label} q${card.quality}`;
}

/** 一个参数变体的一句话摘要（多卡时点名条数，不堆一长串）。 */
export function variantSummary(entry: ImageEntry): string {
  if (entry.encoders.length === 0) return '空配置';
  const first = cardSummary(entry.encoders[0]);
  return entry.encoders.length === 1 ? first : `${first} 等 ${entry.encoders.length} 条`;
}

// ---------- 参数指纹 ----------

/**
 * 编码器卡的参数指纹：由全部**决策字段**规范化而成，稳定可比对。
 *
 * 参与指纹（改了就必须重跑）：编码器 id、无损、模式、质量、目标大小、参数行序列——
 * 每行的 name/flag/value/kind/enabled。**参数行顺序参与**（顺序决定命令行词序）。
 * 不参与（不影响产物）：卡片自己的 id、参数行的说明 note、choice 的候选 options、
 * 目标大小的显示单位 unit（真值一律是字节，KB/MB 只是显示口径）。
 *
 * 规范化只做字段序/数值格式的归一（用固定结构的 JSON 序列化，而不是直接
 * JSON.stringify 原对象，避免对象字面量键序影响结果），不做语义校验与取整：
 * 宁可多跑一次，也不让指纹把两次实际不同的决策判成同一个。
 */
export function paramFingerprint(card: EncoderCard): string {
  return JSON.stringify({
    encoderId: card.encoderId,
    lossless: card.lossless ? 1 : 0,
    mode: card.mode,
    quality: String(card.quality),
    targetBytes: String(card.targetBytes),
    rows: card.rows.map((row) => [
      row.name,
      row.flag,
      row.value,
      row.kind,
      row.enabled ? 1 : 0,
    ]),
  });
}

// ---------- 脏判定（编码器级；图片级状态由它汇总） ----------

/** 一个编码器卡需要（或不需要）跑分的原因。 */
export type DirtyReason =
  /** 这张卡从没成功跑过（新加的卡或从没跑过的条目）。 */
  | 'never'
  /** 参数指纹与快照不一致：只重编这一条。 */
  | 'params'
  /** 原图标识与快照不一致（含读不到文件）：该图全部条目重编。 */
  | 'image'
  /** 上一次跑分失败：重试。 */
  | 'failed';

/** 图片条目的四态（列表徽章的单一来源）。 */
export type ImageEntryState =
  /** 从未成功跑分。 */
  | 'unscored'
  /** 已跑分且无变更：跳过。 */
  | 'scored'
  /** 将重跑（原因见 reasons）。 */
  | 'stale'
  /** 上次失败（失败条目永远不算已跑分，下次自动重试）。 */
  | 'failed';

/** 四态的中文名（徽章文案的单一来源，界面与测试都从这里取）。 */
export const IMAGE_ENTRY_STATE_LABELS: Record<ImageEntryState, string> = {
  unscored: '未跑分',
  scored: '已跑分',
  stale: '将重跑',
  failed: '上次失败',
};

/** 跑分原因的中文名（「为什么它要重跑」）。 */
export const DIRTY_REASON_LABELS: Record<DirtyReason, string> = {
  never: '从没跑过',
  params: '参数改了',
  image: '图片换了',
  failed: '上次失败',
};

/** 单张编码器卡的判定结论。 */
export interface EncoderVerdict {
  /** 编码器卡 id（= AdvancedEntry.id）。 */
  cardId: string;
  /** 编码器 id（jpeg/webp/avif…），便于上屏与排查。 */
  encoderId: string;
  /** 是否需要重新编码 + 跑分。 */
  run: boolean;
  /** 要跑的原因（run=false 时为空）。 */
  reasons: DirtyReason[];
}

/** 一张图片条目的判定结论。 */
export interface ImageVerdict {
  imageId: string;
  path: string;
  /** 图片级四态。 */
  state: ImageEntryState;
  /** 图片级「为什么」：逐卡原因的并集（已跑分为空）。 */
  reasons: DirtyReason[];
  /** 逐卡结论，顺序与条目内编码器卡一致。 */
  encoders: EncoderVerdict[];
}

/**
 * 判定单张编码器卡，收集「为什么」：
 * - 显式换过图 → 图片换了（旧结果整体作废）；
 * - 没有该卡的成功记录 → 有失败记录报「上次失败」，否则报「从没跑过」；
 * - 有成功记录 → 逐项比对参数指纹与原图标识；
 * - 任何情况下该卡上次失败都补一条「上次失败」。
 * 任一原因成立就要跑；无原因即可跳过。
 */
function judgeCard(
  entry: ImageEntry,
  card: EncoderCard,
  identity: ImageIdentityReading,
): EncoderVerdict {
  const record = entry.snapshot?.encoders.find((item) => item.cardId === card.id) ?? null;
  const failure = entry.failures.find((item) => item.cardId === card.id) ?? null;
  const reasons: DirtyReason[] = [];
  if (entry.replaced) {
    // 显式换过图：旧结果整体作废（此时快照已被清掉，报「图片换了」而不是「从没跑过」）
    reasons.push('image');
  } else if (record === null) {
    reasons.push(failure === null ? 'never' : 'failed');
  }
  // 参数比对只对「有成功记录」的卡成立；原图比对对整张图成立（换图要重编全部条目）
  if (record !== null && record.fingerprint !== paramFingerprint(card)) reasons.push('params');
  if (!entry.replaced && entry.snapshot !== null && identityChanged(entry.snapshot.identity, identity)) {
    reasons.push('image');
  }
  if (failure !== null && !reasons.includes('failed')) reasons.push('failed');
  return {
    cardId: card.id,
    encoderId: card.encoderId,
    run: reasons.length > 0,
    reasons,
  };
}

/**
 * 判定一张图片条目：逐卡判定 + 汇总成图片级四态。
 *
 * 汇总规则（失败优先，因为维护者要先看见挂了的条目）：
 * - 当前配置里有卡上次失败 → failed；
 * - 没有编码器卡 → unscored（没配置就没什么可跑）；
 * - 所有卡都可跳过 → scored；
 * - 还有卡要跑，且该条目跑过（有快照或显式换过图）→ stale；
 * - 其余（从没成功跑分过）→ unscored。
 */
export function judgeImageEntry(entry: ImageEntry, probe: ImageIdentityProbe): ImageVerdict {
  const identity = readIdentity(probe, entry.path);
  const encoders = entry.encoders.map((card) => judgeCard(entry, card, identity));
  const reasons: DirtyReason[] = [];
  for (const verdict of encoders) {
    for (const reason of verdict.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  const failed = entry.encoders.some((card) =>
    entry.failures.some((failure) => failure.cardId === card.id),
  );
  let state: ImageEntryState;
  if (failed) {
    state = 'failed';
  } else if (encoders.length === 0) {
    state = 'unscored';
  } else if (encoders.every((verdict) => !verdict.run)) {
    state = 'scored';
  } else if (entry.snapshot !== null || entry.replaced) {
    state = 'stale';
  } else {
    state = 'unscored';
  }
  return { imageId: entry.id, path: entry.path, state, reasons, encoders };
}

/**
 * 批量判定（列表面板逐行渲染徽章用）：顺序与入参一致，同一路径共用一次标识读取。
 * 与 planScore 同一口径，避免「列表显示已跑分、点跑分却要重跑」这种两套判定。
 */
export function judgeEntries(entries: ImageEntry[], probe: ImageIdentityProbe): ImageVerdict[] {
  const cache = new Map<string, ImageIdentityReading>();
  const cachedProbe: ImageIdentityProbe = (path) => {
    const hit = cache.get(path);
    if (hit) return hit;
    const reading = readIdentity(probe, path);
    cache.set(path, reading);
    return reading;
  };
  return entries.map((entry) => judgeImageEntry(entry, cachedProbe));
}

/** 失败明细（界面「上次失败」悬浮/详情用）：只保留当前配置里还在的卡，带上编码器 id。 */
export interface EntryFailureView {
  cardId: string;
  encoderId: string;
  reason: string;
}

/** 取该条目当前有效的失败明细（已删掉的卡的陈旧记录不显示）。 */
export function entryFailures(entry: ImageEntry): EntryFailureView[] {
  const cards = new Map(entry.encoders.map((card) => [card.id, card]));
  const views: EntryFailureView[] = [];
  for (const failure of entry.failures) {
    const card = cards.get(failure.cardId);
    if (!card) continue;
    views.push({ cardId: failure.cardId, encoderId: card.encoderId, reason: failure.reason });
  }
  return views;
}

/** 徽章文案：四态名；「将重跑」括注原因（参数改了 / 图片换了 / 从没跑过 / 上次失败）。 */
export function badgeText(state: ImageEntryState, reasons: DirtyReason[]): string {
  const label = IMAGE_ENTRY_STATE_LABELS[state];
  if (state !== 'stale' || reasons.length === 0) return label;
  return `${label}（${reasons.map((reason) => DIRTY_REASON_LABELS[reason]).join('、')}）`;
}

// ---------- 跑分计划 ----------

/** 计划里要跑的一张编码器卡（含所属条目）。 */
export interface PlannedEncoder {
  imageId: string;
  path: string;
  encoder: EncoderCard;
  /**
   * **计划时**捕获的参数指纹。跑分开始时用它，写回快照时也必须用它——
   * 若跑分中途用户又改了参数，写回旧指纹才能让下一轮如实判成「参数改了」，
   * 而不是把没跑过的参数记成已跑（延迟落库的前提）。
   */
  fingerprint: string;
  reasons: DirtyReason[];
}

/** 跳过原因编码（稳定，供界面判断）；文案见 SKIP_REASON_LABELS。 */
export type SkipReasonCode = 'clean' | 'no-encoders';

/** 跳过原因（文案的单一来源）。 */
export const SKIP_REASON_LABELS: Record<SkipReasonCode, string> = {
  clean: '已跑分且无变更',
  'no-encoders': '没有编码器配置',
};

/** 计划里被整张跳过的参数变体（含原因）。 */
export interface SkippedImage {
  imageId: string;
  path: string;
  /** 变体的一句话摘要（如「JPEG q75」）：同一轮里各变体共用一张原图，跳过原因必须点名变体。 */
  label: string;
  /** 该变体下可复用、无需重跑的编码器卡条数。 */
  encoderCount: number;
  reason: { code: SkipReasonCode; text: string };
}

/**
 * 跑分计划。
 *
 * **计数口径一律是图片张数（条目数），不是编码器条数**：一张图里两条卡要跑，
 * runImageCount 仍是 1（编码器条数看 encoders.length）。字段名带 Image 就是为了
 * 在调用点杜绝把「张」和「条」混读。
 */
export interface ScorePlan {
  /** 要跑的编码器清单（含所属条目），按条目顺序与卡序展开。 */
  encoders: PlannedEncoder[];
  /** 完全不需要跑的条目清单（含原因）：这些图整张跳过、沿用已有结果。 */
  skippedImages: SkippedImage[];
  /** 本次要跑的**编码器条数**（= encoders.length；用于进度与排查）。 */
  runEncoderCount: number;
  /** 本次要跑的图片张数（去重后的条目数）。 */
  runImageCount: number;
  /** 本次跳过的图片张数。 */
  skippedImageCount: number;
}

function skipReasonOf(code: SkipReasonCode): { code: SkipReasonCode; text: string } {
  return { code, text: SKIP_REASON_LABELS[code] };
}

/**
 * 算出跑分计划：哪些编码器要跑、哪些图片整张跳过、各多少张。
 *
 * 同一条目里可能只有部分卡要跑（例如只改了一条参数），该条目算「要跑」而不是
 * 「跳过」；只有一张卡都不用跑的条目才进 skippedImages。
 * 同一路径的多个条目共用一次标识读取结果（按路径记忆），避免重复读盘。
 */
export function planScore(entries: ImageEntry[], probe: ImageIdentityProbe): ScorePlan {
  const verdicts = judgeEntries(entries, probe);
  const encoders: PlannedEncoder[] = [];
  const skippedImages: SkippedImage[] = [];
  const runImageIds = new Set<string>();

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const verdict = verdicts[index];
    if (entry.encoders.length === 0) {
      skippedImages.push({
        imageId: entry.id,
        path: entry.path,
        label: variantSummary(entry),
        encoderCount: 0,
        reason: skipReasonOf('no-encoders'),
      });
      continue;
    }
    const dirty = verdict.encoders.filter((item) => item.run);
    if (dirty.length === 0) {
      skippedImages.push({
        imageId: entry.id,
        path: entry.path,
        label: variantSummary(entry),
        encoderCount: entry.encoders.length,
        reason: skipReasonOf('clean'),
      });
      continue;
    }
    const byCardId = new Map(verdict.encoders.map((item) => [item.cardId, item]));
    for (const card of entry.encoders) {
      const cardVerdict = byCardId.get(card.id);
      if (!cardVerdict || !cardVerdict.run) continue;
      encoders.push({
        imageId: entry.id,
        path: entry.path,
        encoder: card,
        fingerprint: paramFingerprint(card),
        reasons: cardVerdict.reasons,
      });
    }
    runImageIds.add(entry.id);
  }

  return {
    encoders,
    skippedImages,
    runEncoderCount: encoders.length,
    runImageCount: runImageIds.size,
    skippedImageCount: skippedImages.length,
  };
}

/** 计划是否为空（没有任何编码器要跑）：后续票据此只弹「无需重跑」提示、不执行跑分。 */
export function isPlanEmpty(plan: ScorePlan): boolean {
  return plan.encoders.length === 0;
}

// ---------- 汇总文案 ----------

/** 汇总卡片标题行：「本次跑分 N 张，跳过 M 张」（N/M 都是图片张数）。 */
export function summaryHeadline(runImageCount: number, skippedImageCount: number): string {
  return `本次跑分 ${runImageCount} 张，跳过 ${skippedImageCount} 张`;
}

/** 逐张点名的跳过原因行：「JPEG q75（已跑分且无变更）」。 */
export function skipReasonLine(skipped: SkippedImage): string {
  return `${skipped.label}（${skipped.reason.text}）`;
}

/** 汇总文案（标题 + 逐张跳过原因）。 */
export interface ScoreSummary {
  headline: string;
  skipLines: string[];
}

/** 计划 → 汇总文案。 */
export function planSummary(plan: ScorePlan): ScoreSummary {
  return {
    headline: summaryHeadline(plan.runImageCount, plan.skippedImageCount),
    skipLines: plan.skippedImages.map(skipReasonLine),
  };
}

// ---------- 跑分结果回写 ----------

/** 一次编码 + 跑分的单卡结果：成功带产物路径与**计划时的参数指纹**，失败带中文原因。 */
export type EncoderRunOutcome =
  | { kind: 'success'; cardId: string; artifactPath: string; fingerprint: string }
  | { kind: 'failure'; cardId: string; reason: string };

/**
 * 把一次跑分的结果写回条目（**失败永远不算已跑分**）：
 * - 成功：写入/更新快照记录（参数指纹用结果里带回的**计划时指纹**，不是当前配置——
 *   跑分中途改参数时，下一轮必须如实判成「参数改了」），清掉该卡的失败记录；
 * - 失败：删掉该卡在快照里的旧记录（它已不代表当前可用结果），记下失败原因；
 * - 跑分期间被删掉的卡片：结果直接丢弃；
 * - 已删除卡片的陈旧记录一并清理；
 * - 快照只有「至少有一条成功记录」时才存在，否则为 null（下次判定回到待跑）；
 * - 原图标识以本次读到的为准（读不到时保留旧标识；连旧标识都没有就不写快照，保守重跑）；
 * - 跑过一次后 replaced 归零。
 *
 * 调用约定：outcomes 应覆盖本次计划的全部卡（界面层只会把计划里的卡送进来）。
 */
export function applyRunResults(
  entry: ImageEntry,
  outcomes: EncoderRunOutcome[],
  identity: ImageIdentityReading,
): void {
  if (outcomes.length === 0) return;
  const cards = new Map(entry.encoders.map((card) => [card.id, card]));
  const records = new Map<string, EncoderSnapshot>();
  for (const record of entry.snapshot?.encoders ?? []) {
    if (cards.has(record.cardId)) records.set(record.cardId, record);
  }
  const failures = new Map<string, EntryFailure>();
  for (const failure of entry.failures) {
    if (cards.has(failure.cardId)) failures.set(failure.cardId, failure);
  }

  for (const outcome of outcomes) {
    const card = cards.get(outcome.cardId);
    if (!card) continue; // 跑分期间被删掉的卡片：结果作废
    if (outcome.kind === 'success') {
      records.set(card.id, {
        cardId: card.id,
        fingerprint: outcome.fingerprint,
        artifactPath: outcome.artifactPath,
      });
      failures.delete(card.id);
    } else {
      records.delete(card.id);
      failures.set(card.id, { cardId: card.id, reason: outcome.reason });
    }
  }

  entry.failures = [...failures.values()];
  const snapshotIdentity = identity.kind === 'ok' ? identity.identity : entry.snapshot?.identity ?? null;
  entry.snapshot =
    records.size > 0 && snapshotIdentity !== null
      ? { identity: snapshotIdentity, encoders: [...records.values()] }
      : null;
  entry.replaced = false;
}

// ---------- 产物 → 条目反查（票 #82：主界面胶囊即参数入口） ----------

/**
 * 由一张跑分图的路径反查「产出它的图片条目」；找不到返回 null。
 *
 * 为什么只认快照里的 artifactPath（不按文件名前缀或编码参数猜）：快照是「这张产物由
 * 哪个条目、哪条编码器卡跑出来」的唯一权威记录（applyRunResults 写在成功结果上）。
 * 猜会张冠李戴——把 A 图的参数弹窗开到 B 图身上，比「点不开」危险得多。
 *
 * 因此以下情况一律返回 null（界面据此不挂点击、只说明原因）：
 * - 人工导入 / 一站式生成的跑分图：从未经过条目，快照里没有这条路径；
 * - 从未成功跑分的条目（快照为 null）；
 * - 换过图的条目：replaceImagePath 清掉了旧快照，旧产物已被清出评测轮。
 *
 * 命中多条时取列表里的第一条：产物路径在正常工作流里唯一，这条只用于让结果确定
 * （不随对象遍历顺序抖动），不代表支持「一张产物属于多个条目」。
 */
export function entryForArtifact(
  entries: readonly ImageEntry[],
  artifactPath: string,
): ImageEntry | null {
  for (const entry of entries) {
    const records = entry.snapshot?.encoders ?? [];
    if (records.some((record) => record.artifactPath === artifactPath)) return entry;
  }
  return null;
}
