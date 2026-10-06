// 一站式编码阶梯（T11 补全）：决策 0003 的完整默认阶梯——
// 有损 JPEG/WebP/AVIF/JPEG-XL × 质量 60/75/90 + 无损对照组 PNG/无损 WebP/无损 JXL。
//
// 交互约定（沿用 T10 逐档进度的模式）：前端按（格式, 质量）逐次调用 onestop_encode，
// 每次调用天然形成进度（「正在生成 AVIF q75（5/12）」）；全部生成成功的项一次性
// 纳入本轮（round_add_candidates，核心库按路径去重，重复触发幂等），随后由主模块
// 复用现有逐张跑分循环出分。
//
// 失败语义：某项失败不回滚已成功的项——继续尝试其余项，中文原因收集后由
// 主模块统一提示（编码器首次使用要联网下载，下载失败时同一编码器的各档都会失败）。

import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './main';

/** 格式条目：规范格式串 + 界面显示名（显示名源头为核心库 OnestopFormat::display_name） */
export interface FormatEntry {
  format: string;
  label: string;
}

/** 有损格式清单（顺序即生成顺序）。T21 单源化：启动时由 initOnestopCatalog
 * 从核心库取点目录（onestop_default_ladder 命令）拉取，本文件不再自持档位常量。 */
export let LOSSY_FORMATS: FormatEntry[] = [];

/** 默认质量档 = 核心库质量优先取点（基准 75）的各格式并集（现行默认 60/75/90） */
export let QUALITIES: number[] = [];

/** 无损对照组清单（核心库保证像素逐位一致），来源同上 */
export let LOSSLESS_FORMATS: FormatEntry[] = [];

/** 一站式勾选目录（onestop_default_ladder 的载荷） */
interface OnestopCatalog {
  lossyFormats: FormatEntry[];
  qualities: number[];
  losslessFormats: FormatEntry[];
}

/** 从后端拉取一站式目录：格式清单 + 默认质量档，源头为核心库质量优先取点。
 * 必须在首次渲染勾选区之前调用（main.ts 的 boot 里最先 await），失败时目录为空、
 * 状态栏报错，界面其余部分照常可用。 */
export async function initOnestopCatalog(): Promise<void> {
  const catalog = await invoke<OnestopCatalog>('onestop_default_ladder');
  LOSSY_FORMATS = catalog.lossyFormats;
  QUALITIES = catalog.qualities;
  LOSSLESS_FORMATS = catalog.losslessFormats;
}

/** 一站式勾选状态（界面会话态，重启归零；默认全开 = 决策 0003 的默认阶梯） */
export interface OnestopSelection {
  /** LOSSY_FORMATS 里 format 的子集 */
  lossyFormats: string[];
  /** QUALITIES 的子集 */
  qualities: number[];
  /** LOSSLESS_FORMATS 里 format 的子集 */
  losslessFormats: string[];
}

export function defaultSelection(): OnestopSelection {
  return {
    lossyFormats: LOSSY_FORMATS.map((f) => f.format),
    qualities: [...QUALITIES],
    losslessFormats: LOSSLESS_FORMATS.map((f) => f.format),
  };
}

/** 一个待生成的阶梯项 */
export interface LadderItem {
  format: string;
  /** 无损组为 null */
  quality: number | null;
  /** 进度文本用显示名，如「AVIF q75」「无损 WebP」 */
  label: string;
}

/** 按勾选项展开为生成清单：先有损（格式 × 质量档），后无损组 */
export function buildLadder(selection: OnestopSelection): LadderItem[] {
  const items: LadderItem[] = [];
  for (const { format, label } of LOSSY_FORMATS) {
    if (!selection.lossyFormats.includes(format)) continue;
    for (const quality of selection.qualities) {
      items.push({ format, quality, label: `${label} q${quality}` });
    }
  }
  for (const { format, label } of LOSSLESS_FORMATS) {
    if (!selection.losslessFormats.includes(format)) continue;
    items.push({ format, quality: null, label });
  }
  return items;
}

export interface OnestopDeps {
  groupId: string;
  roundId: string;
  referencePath: string;
  ladder: LadderItem[];
  /** 阶段进度文本，主模块亮到状态栏 */
  onProgress: (text: string) => void;
  /** 产物纳入本轮后回传最新工作区，主模块替换状态并重渲染 */
  onWorkspace: (ws: Workspace) => void;
}

export interface OnestopResult {
  /** 成功生成并纳入本轮的项数 */
  generated: number;
  /** 失败项的中文原因（形如「AVIF q75: 原因」） */
  failures: string[];
}

/** 一站式单档产物：onestop_encode 回传的产物路径 + 编码参数文本
 *（参数文本后端与 CLI 同出核心库 OnestopFormat::encoding_params_text 一处，前端不自己拼）。 */
export interface OnestopProduct {
  path: string;
  encodingParams: string;
}

/** 跑完编码阶梯：逐项生成 → 产物纳入本轮。不含跑分（主模块接现有循环）。 */
export async function runOnestop(deps: OnestopDeps): Promise<OnestopResult> {
  const products: OnestopProduct[] = [];
  const failures: string[] = [];

  for (let i = 0; i < deps.ladder.length; i++) {
    const item = deps.ladder[i];
    deps.onProgress(`正在生成 ${item.label}（${i + 1}/${deps.ladder.length}）`);
    try {
      const product = await invoke<OnestopProduct>('onestop_encode', {
        groupId: deps.groupId,
        roundId: deps.roundId,
        referencePath: deps.referencePath,
        format: item.format,
        quality: item.quality,
      });
      products.push(product);
    } catch (err) {
      // 后端返回的已是中文错误（下载/校验/编码失败等），透传即可
      failures.push(`${item.label}: ${String(err)}`);
    }
  }

  if (products.length > 0) {
    // 编码参数与路径一一对应写入（外部导入模式不传该参数，见 round_add_candidates）
    const updated = await invoke<Workspace>('round_add_candidates', {
      groupId: deps.groupId,
      roundId: deps.roundId,
      paths: products.map((p) => p.path),
      encodingParams: products.map((p) => p.encodingParams),
    });
    deps.onWorkspace(updated);
  }

  return { generated: products.length, failures };
}
