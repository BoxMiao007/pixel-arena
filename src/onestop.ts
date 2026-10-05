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

/** 有损格式与界面显示名（顺序即生成顺序） */
export const LOSSY_FORMATS = [
  { format: 'jpeg', label: 'JPEG' },
  { format: 'webp', label: 'WebP' },
  { format: 'avif', label: 'AVIF' },
  { format: 'jxl', label: 'JPEG XL' },
] as const;

/** 有损质量档 */
export const QUALITIES = [60, 75, 90] as const;

/** 无损对照组与界面显示名（核心库保证像素逐位一致） */
export const LOSSLESS_FORMATS = [
  { format: 'png', label: 'PNG' },
  { format: 'webp-lossless', label: '无损 WebP' },
  { format: 'jxl-lossless', label: '无损 JXL' },
] as const;

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

/** 跑完编码阶梯：逐项生成 → 产物纳入本轮。不含跑分（主模块接现有循环）。 */
export async function runOnestop(deps: OnestopDeps): Promise<OnestopResult> {
  const products: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < deps.ladder.length; i++) {
    const item = deps.ladder[i];
    deps.onProgress(`正在生成 ${item.label}（${i + 1}/${deps.ladder.length}）`);
    try {
      const product = await invoke<string>('onestop_encode', {
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
    const updated = await invoke<Workspace>('round_add_candidates', {
      groupId: deps.groupId,
      roundId: deps.roundId,
      paths: products,
    });
    deps.onWorkspace(updated);
  }

  return { generated: products.length, failures };
}
