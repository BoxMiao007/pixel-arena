// 一站式编码阶梯（T22 两种模式，取点全部走核心库，前端不自持任何档位定义）：
// - 质量优先：统一拉杆 0–100 定基准 → IPC onestop_quality_ladder（核心库
//   quality_ladder，每格式 ≥3 点 + 无损对照组）展开生成清单；
// - 大小优先：目标字节数 → 每格式逐次调 IPC onestop_size_search（核心库
//   size_search 逼近搜索，探测编码在后端完成），命中点 + 邻近补点入清单，
//   不可达时按核心库 annotation_note 的中文标注呈现（与 CLI note 列同源）。
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
 * 从核心库取点目录（onestop_catalog 命令）拉取，本文件不自持档位常量。 */
export let LOSSY_FORMATS: FormatEntry[] = [];

/** 无损对照组清单（核心库保证像素逐位一致），来源同上 */
export let LOSSLESS_FORMATS: FormatEntry[] = [];

/** 一站式勾选目录（onestop_catalog 的载荷；T22 起质量档不再由目录给出，
 * 由拉杆基准经 onestop_quality_ladder 取点） */
interface OnestopCatalog {
  lossyFormats: FormatEntry[];
  losslessFormats: FormatEntry[];
}

/** 从后端拉取一站式目录：有损/无损格式清单。必须在首次渲染勾选区之前调用
 * （main.ts 的 boot 里最先 await），失败时目录为空、状态栏报错，界面其余部分照常可用。 */
export async function initOnestopCatalog(): Promise<void> {
  const catalog = await invoke<OnestopCatalog>('onestop_catalog');
  LOSSY_FORMATS = catalog.lossyFormats;
  LOSSLESS_FORMATS = catalog.losslessFormats;
}

/** 一站式勾选状态（界面会话态，重启归零；默认全选）。格式用胶囊多选/移除。 */
export interface OnestopSelection {
  /** LOSSY_FORMATS 里 format 的子集 */
  lossyFormats: string[];
  /** LOSSLESS_FORMATS 里 format 的子集（无损对照组默认在列、可移除） */
  losslessFormats: string[];
}

export function defaultSelection(): OnestopSelection {
  return {
    lossyFormats: LOSSY_FORMATS.map((f) => f.format),
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

/** 一站式模式（T22）：quality = 质量优先（拉杆定基准），size = 大小优先（目标大小逼近） */
export type OnestopMode = 'quality' | 'size';

/** 质量优先取点：统一基准 0–100 → 核心库完整阶梯（有损 4 格式各 ≥3 点 + 无损对照组）。 */
export async function fetchQualityLadder(baseline: number): Promise<LadderItem[]> {
  return invoke<LadderItem[]>('onestop_quality_ladder', { baseline });
}

/** 按勾选过滤核心库阶梯（保序）：有损项只留勾选格式，无损项只留勾选的无损组。 */
export function filterLadder(ladder: LadderItem[], selection: OnestopSelection): LadderItem[] {
  return ladder.filter((item) =>
    item.quality === null
      ? selection.losslessFormats.includes(item.format)
      : selection.lossyFormats.includes(item.format),
  );
}

/** 大小优先：核心库搜索结果里的一个质量点（质量 + 探测到的实际字节数） */
export interface SizePoint {
  quality: number;
  bytes: number;
}

/** onestop_size_search 回传的单格式搜索结果 */
export interface SizeSearchOutcome {
  format: string;
  targetBytes: number;
  /** 逼近目标选中的质量点（不可达时为最小/最高质量点） */
  hitQuality: number;
  hitBytes: number;
  /** 不可达标注（核心库 annotation_note 单一来源）；可达为 null */
  note: string | null;
  /** 命中点 + 邻近补点（升序 ≥3 点，US23 保 BD-rate），每点带实测大小 */
  points: SizePoint[];
}

/** 大小优先单格式逼近搜索：探测编码在后端执行（探测产物落暂存目录即弃）。 */
export async function searchSizeFormat(deps: {
  groupId: string;
  roundId: string;
  referencePath: string;
  format: string;
  targetBytes: number;
}): Promise<SizeSearchOutcome> {
  const dto = await invoke<{
    format: string;
    targetBytes: number;
    hit: { quality: number; bytes: number };
    note: string | null;
    points: SizePoint[];
  }>('onestop_size_search', {
    groupId: deps.groupId,
    roundId: deps.roundId,
    referencePath: deps.referencePath,
    format: deps.format,
    targetBytes: deps.targetBytes,
  });
  return {
    format: dto.format,
    targetBytes: dto.targetBytes,
    hitQuality: dto.hit.quality,
    hitBytes: dto.hit.bytes,
    note: dto.note,
    points: dto.points,
  };
}

/** 大小优先搜索结果 → 生成清单：命中点 + 邻近补点逐项展开（显示名取格式清单） */
export function sizeOutcomeLadder(outcome: SizeSearchOutcome): LadderItem[] {
  const label = LOSSY_FORMATS.find((f) => f.format === outcome.format)?.label ?? outcome.format;
  return outcome.points.map((point) => ({
    format: outcome.format,
    quality: point.quality,
    label: `${label} q${point.quality}`,
  }));
}

/** 大小优先的无损对照组清单项：大小固定不参与搜索，原样入清单（按勾选过滤） */
export function losslessLadder(selection: OnestopSelection): LadderItem[] {
  return LOSSLESS_FORMATS.filter((f) => selection.losslessFormats.includes(f.format)).map(
    (f) => ({ format: f.format, quality: null, label: f.label }),
  );
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

export interface OnestopProductResult {
  /** 产物绝对路径（= 纳入本轮的跑分图路径） */
  path: string;
  format: string;
}

export interface OnestopResult {
  /** 成功生成并纳入本轮的项数 */
  generated: number;
  /** 失败项的中文原因（形如「AVIF q75: 原因」） */
  failures: string[];
  /** 成功产物（路径 + 格式）：大小优先模式按格式挂不可达标注（结果表备注列）用 */
  products: OnestopProductResult[];
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
  const formats: string[] = [];
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
      formats.push(item.format);
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

  return {
    generated: products.length,
    failures,
    products: products.map((p, i) => ({ path: p.path, format: formats[i] })),
  };
}
