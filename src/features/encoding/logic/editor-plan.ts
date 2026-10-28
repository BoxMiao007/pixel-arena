// 参数变体编辑区的纯逻辑：头部展示数据与卡片增删排序。零 DOM、零 IPC，node 环境真跑。
//
// 票「变体并入当前轮」后变体不再自带原图（永远编码本轮原图），所以旧的「更换图片 /
// 清跑分行」编排整体退场：换原图是**轮级动作**，由来源分区统一负责（后端会清掉本轮
// 已有指标，变体判定按原图标识变化自然置脏）。

import { newEntry, type AdvancedEntry, type ImageSpec } from './advanced';
import {
  DEFAULT_IMAGE_ENCODER_ID,
  badgeText,
  judgeImageEntry,
  variantSummary,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageVerdict,
} from './entries';
import { fileName, truncateFileName } from '../../../core/util';

// ---------- 头部 ----------

/** 编辑器头部与列表共用的展示数据（变体摘要 + 当前状态的单一来源）。 */
export interface EditorHeader {
  /** 区块标题：「参数变体：JPEG q75」。 */
  title: string;
  /** 变体摘要（「JPEG q75」，多条配置时点名条数）。 */
  fileName: string;
  /** 本轮原图文件名（中间截断；完整路径由调用方放 title）。 */
  referenceName: string;
  /** 状态徽章文案（取四态单一来源，含「将重跑」原因括注）。 */
  status: string;
  /** 状态徽章 class（四态各一色）。 */
  statusClass: string;
}

/** 由变体与判定结论生成编辑区的展示数据。 */
export function editorHeader(entry: ImageEntry, verdict: ImageVerdict): EditorHeader {
  const summary = variantSummary(entry);
  return {
    title: `参数变体：${summary}`,
    fileName: summary,
    referenceName: truncateFileName(fileName(entry.path)),
    status: badgeText(verdict.state, verdict.reasons),
    statusClass: `enc-badge enc-badge--${verdict.state}`,
  };
}

/** 当前判定（列表与编辑区共用同一份标识缓存）。 */
export function verdictOf(entry: ImageEntry, probe: ImageIdentityProbe): ImageVerdict {
  return judgeImageEntry(entry, probe);
}

// ---------- 卡片增删排序 ----------

/**
 * 往变体里加一条默认编码器卡。默认格式优先 JPEG（与新变体自带配置同口径，加完就能跑）；
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
