// 逐图编辑的纯逻辑（原 src/image-entry-editor.ts 的上半段，Phase B 搬到 logic/）：
// 头部展示数据、换图计划与执行、卡片增删排序。零 DOM、零 IPC，node 环境真跑。
//
// 换图的两条不变量（来自票 #78，别在重写时丢掉）：
// 1. **先清行再换路径**：旧产物对应的是上一张原图，留在结果表里就是「旧图产物 vs 新原图」
//    的骗人对比；清行只摘评测记录，磁盘文件不动。
// 2. **选回同一路径也走完整流程**：用外部工具原地覆写同名同大小的文件时，这是唯一的
//    自救路径；显式换图一律置 replaced，旧结果整体作废。

import { newEntry, type AdvancedEntry, type ImageSpec } from './advanced';
import {
  DEFAULT_IMAGE_ENCODER_ID,
  badgeText,
  judgeImageEntry,
  replaceImagePath,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageVerdict,
  type RoundSummary,
} from './entries';
import { fileName, truncateFileName } from '../../../core/util';

// ---------- 头部 ----------

/** 编辑器头部与左栏共用的展示数据（文件名 + 当前状态的单一来源）。 */
export interface EditorHeader {
  /** 窗口/区块标题：「编辑图片：<中间截断的文件名>」。 */
  title: string;
  /** 文件名（中间截断，完整路径由调用方放 title）。 */
  fileName: string;
  /** 状态徽章文案（取四态单一来源，含「将重跑」原因括注）。 */
  status: string;
  /** 状态徽章 class（四态各一色）。 */
  statusClass: string;
}

/** 由条目与判定结论生成编辑器头部的展示数据。 */
export function editorHeader(entry: ImageEntry, verdict: ImageVerdict): EditorHeader {
  const name = truncateFileName(fileName(entry.path));
  return {
    title: `编辑图片：${name}`,
    fileName: name,
    status: badgeText(verdict.state, verdict.reasons),
    statusClass: `enc-badge enc-badge--${verdict.state}`,
  };
}

/** 当前判定（列表与编辑器共用同一份标识缓存）。 */
export function verdictOf(entry: ImageEntry, probe: ImageIdentityProbe): ImageVerdict {
  return judgeImageEntry(entry, probe);
}

// ---------- 换图 ----------

/** 换图编排的一步（顺序即执行顺序，纯数据便于断言）。 */
export type ReplaceImageStep =
  | { kind: 'clear-candidates'; roundId: string }
  | { kind: 'replace-path'; path: string };

/** 换图计划：要给用户看的口径 + 要执行的步骤序列。 */
export interface ReplaceImagePlan {
  fromPath: string;
  toPath: string;
  /** 要清跑分行的评测轮 id；null = 没有轮或轮已不在工作区，不清行。 */
  roundId: string | null;
  /** 执行步骤：先清行（有轮时），再换路径。 */
  steps: ReplaceImageStep[];
  /** 状态栏提示文案（写明配置保留与磁盘文件保留）。 */
  message: string;
}

/**
 * 算换图计划。
 *
 * 轮已不在工作区（用户在主界面删过）时不拿旧 id 去清：那会得到一个「找不到评测轮」的
 * 错误，而条目其实已经只活在会话里。
 */
export function planReplaceImage(
  entry: ImageEntry,
  newPath: string,
  round: RoundSummary | null,
): ReplaceImagePlan {
  const from = fileName(entry.path);
  const to = fileName(newPath);
  const samePath = newPath === entry.path;
  const roundId = entry.roundId !== null && round !== null ? entry.roundId : null;
  const steps: ReplaceImageStep[] = [];
  if (roundId !== null) steps.push({ kind: 'clear-candidates', roundId });
  steps.push({ kind: 'replace-path', path: newPath });
  const clearText =
    round !== null && round.candidateCount > 0
      ? `评测轮『${round.name}』里这张图的 ${round.candidateCount} 条跑分结果已清掉，下次跑分重新生成；`
      : `评测轮『${round?.name ?? ''}』里这张图还没有跑分结果；`;
  // 同一路径的文案说「重新读取」而不是「换成同一张」——后者读起来像没做事
  const lead = samePath ? `已按同一路径重新读取「${to}」：` : `已把「${from}」换成「${to}」：`;
  const message =
    roundId !== null && round !== null
      ? `${lead}编码器配置保留；${clearText}磁盘上的产物文件保留。`
      : `${lead}编码器配置保留；这条还没有评测轮，工作区未改动；磁盘上的产物文件保留。`;
  return { fromPath: entry.path, toPath: newPath, roundId, steps, message };
}

/** 换图执行时需要的宿主能力（纯逻辑层不碰 IPC / 文件系统）。 */
export interface ReplaceImageDeps {
  /** 清掉某轮已有的跑分行（只作用于评测记录，不删磁盘文件）。 */
  clearCandidates(roundId: string): Promise<void>;
  /** 读一次新原图的标识并写入判定缓存（换图后状态判定要用新文件的大小/修改时间）。 */
  refreshIdentity(path: string): Promise<void>;
}

/**
 * 按计划执行换图。失败即中止：清行失败时**不换路径**——否则会留下「新原图 + 旧跑分行」
 * 的骗人组合，比操作失败更糟。换完必须重读原图标识（判定拿新文件比快照）。
 */
export async function runReplaceImage(
  plan: ReplaceImagePlan,
  entry: ImageEntry,
  deps: ReplaceImageDeps,
): Promise<void> {
  for (const step of plan.steps) {
    if (step.kind === 'clear-candidates') {
      await deps.clearCandidates(step.roundId);
      continue;
    }
    replaceImagePath(entry, step.path);
  }
  if (plan.steps.length > 0) await deps.refreshIdentity(entry.path);
}

// ---------- 卡片增删排序 ----------

/**
 * 往条目里加一条默认编码器卡。默认格式优先 JPEG（与新条目自带配置同口径，加完就能跑）；
 * 目录里没有 JPEG 时退回第一条规格；目录为空返回 null。
 */
export function addEncoderCard(entry: ImageEntry, imageSpecs: readonly ImageSpec[]): AdvancedEntry | null {
  const spec = imageSpecs.find((item) => item.id === DEFAULT_IMAGE_ENCODER_ID) ?? imageSpecs[0];
  if (!spec) return null;
  const card = newEntry('image', spec.id, spec);
  entry.encoders.push(card);
  return card;
}

/** 卡片排序：把第 index 张卡上移/下移一位（越界不动）。 */
export function moveCard(entry: ImageEntry, index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (index < 0 || index >= entry.encoders.length) return;
  if (target < 0 || target >= entry.encoders.length) return;
  const [card] = entry.encoders.splice(index, 1);
  entry.encoders.splice(target, 0, card);
}
