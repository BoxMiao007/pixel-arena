// BD-rate 汇总的按轮缓存与数据指纹。
//
// 汇总依赖「本轮跑分图的文件大小 + PSNR + 原图」，任一变化都必须重算；用指纹比对
// 比在每次 workspace 变更时无脑重发 IPC 便宜得多，也避免切换页签就闪一次「计算中」。
// 缓存只活在内存里（重启重算），删轮时由调用方 forgetBdrate。

import type { Round } from '../../core/model';
import type { BdrateSummary } from './ipc';

interface CacheEntry {
  signature: string;
  summary: BdrateSummary;
}

const cache = new Map<string, CacheEntry>();

/** 本轮 BD-rate 的数据指纹：原图 + 每张跑分图的路径/字节数/PSNR。 */
export function bdrateSignature(round: Round): string {
  return JSON.stringify([
    round.referencePath,
    round.candidates.map((candidate) => [
      candidate.path,
      candidate.fileSize,
      candidate.metrics?.PSNR ?? null,
    ]),
  ]);
}

/** 取本轮缓存；指纹不匹配（跑分结果变了）时返回 null。 */
export function cachedBdrate(round: Round): BdrateSummary | null {
  const entry = cache.get(round.id);
  if (!entry || entry.signature !== bdrateSignature(round)) return null;
  return entry.summary;
}

/** 记住一次成功的汇总。 */
export function rememberBdrate(round: Round, summary: BdrateSummary): void {
  cache.set(round.id, { signature: bdrateSignature(round), summary });
}

/** 丢弃某轮缓存（删轮时调用，避免 id 复用串味）。 */
export function forgetBdrate(roundId: string): void {
  cache.delete(roundId);
}

/** 清空全部缓存（单测用）。 */
export function clearBdrateCache(): void {
  cache.clear();
}
