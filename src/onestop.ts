// 一站式模式第一竖切片（T10）：JPEG 编码阶梯（MozJPEG × 质量 60/75/90）。
//
// 交互约定（沿用 T06 逐张跑分的模式）：前端按档位逐次调用 onestop_encode_jpeg，
// 三次调用天然形成进度（「正在生成 JPEG q75（2/3）」）；全部生成成功的档位一次性
// 纳入本轮（round_add_candidates，核心库按路径去重，重复触发幂等），随后由主模块
// 复用现有逐张跑分循环出分。
//
// 失败语义：某档失败不回滚已成功的档位——继续尝试其余档位，中文原因收集后由
// 主模块统一提示（编码器首次使用要联网下载，下载失败时三档都会失败并各报一次）。

import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './main';

/** 本票的编码阶梯：JPEG 三个质量档（后续票扩格式与档位时在此扩展） */
export const JPEG_QUALITIES = [60, 75, 90] as const;

export interface OnestopDeps {
  groupId: string;
  roundId: string;
  referencePath: string;
  /** 阶段进度文本，主模块亮到状态栏 */
  onProgress: (text: string) => void;
  /** 产物纳入本轮后回传最新工作区，主模块替换状态并重渲染 */
  onWorkspace: (ws: Workspace) => void;
}

export interface OnestopResult {
  /** 成功生成并纳入本轮的档位数 */
  generated: number;
  /** 失败档位的中文原因（形如「q75: 原因」） */
  failures: string[];
}

/** 跑完 JPEG 编码阶梯：逐档生成 → 产物纳入本轮。不含跑分（主模块接现有循环）。 */
export async function runOnestopJpeg(deps: OnestopDeps): Promise<OnestopResult> {
  const products: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < JPEG_QUALITIES.length; i++) {
    const quality = JPEG_QUALITIES[i];
    deps.onProgress(`正在生成 JPEG q${quality}（${i + 1}/${JPEG_QUALITIES.length}）`);
    try {
      const product = await invoke<string>('onestop_encode_jpeg', {
        groupId: deps.groupId,
        roundId: deps.roundId,
        referencePath: deps.referencePath,
        quality,
      });
      products.push(product);
    } catch (err) {
      // 后端返回的已是中文错误（下载/校验/编码失败等），透传即可
      failures.push(`q${quality}: ${String(err)}`);
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
