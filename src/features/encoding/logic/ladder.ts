// 一站式编码阶梯（原 src/onestop.ts 的重构版）：取点全部走核心库，前端不自持档位。
//
// 与旧实现的两处差别（Phase B 重构要求）：
// 1. **不再反向依赖 main.ts**：编码 / 纳产物由调用方注入（LadderRunDeps），本模块只
//    负责「按清单逐项生成 → 收集失败 → 交付产物」的顺序与失败语义，可在 node 里真跑；
// 2. **IPC 收口**：取点与目录命令经 ../ipc 的薄包装（组件层不裸调 invoke）。
//
// 纯逻辑（过滤 / 展开 / 分组 / 进度文案 / 失败收集）与旧实现一致——旧单测
// （ladder.test.ts）搬过来只改 import 路径即可原样通过，这就是「原样复用」的验收。

import { ConflictSession, type ConflictAnswer } from './conflict';
import {
  ipc,
  type FormatEntry,
  type OnestopEncodeOutcome,
  type OnestopProduct,
  type SizePoint,
} from '../ipc';

export type { FormatEntry };

/** 有损格式清单（顺序即生成顺序）。启动时由 initOnestopCatalog 从核心库拉取。 */
export let LOSSY_FORMATS: FormatEntry[] = [];

/** 无损对照组清单（核心库保证像素逐位一致），来源同上。 */
export let LOSSLESS_FORMATS: FormatEntry[] = [];

/** 从后端拉取一站式目录：有损/无损格式清单。必须在首次渲染勾选区之前调用
 * （boot 里最先 await），失败时目录为空、状态栏报错，界面其余部分照常可用。 */
export async function initOnestopCatalog(): Promise<void> {
  const catalog = await ipc.onestopCatalog();
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

/** 格式胶囊的选中切换（选中 ↔ 取消），有损与无损共用。
 * 返回新数组（移除时保持剩余项相对顺序，追加时排到末尾），不改入参。 */
export function toggleFormat(formats: string[], format: string): string[] {
  return formats.includes(format)
    ? formats.filter((f) => f !== format)
    : [...formats, format];
}

/** 一个待生成的阶梯项 */
export interface LadderItem {
  format: string;
  /** 无损组为 null */
  quality: number | null;
  /** 进度文本用显示名，如「AVIF q75」「无损 WebP」 */
  label: string;
}

/** 一站式模式：quality = 质量优先（拉杆定基准），size = 大小优先（目标大小逼近） */
export type OnestopMode = 'quality' | 'size';

/** 质量优先取点：统一基准 0–100 → 核心库完整阶梯（有损 4 格式各 ≥3 点 + 无损对照组）。 */
export async function fetchQualityLadder(baseline: number): Promise<LadderItem[]> {
  return ipc.onestopQualityLadder(baseline);
}

/** 单点模式取点：每有损格式仅压基准质量 1 点（夹到格式范围）+ 无损对照组照常。 */
export async function fetchSinglePointLadder(baseline: number): Promise<LadderItem[]> {
  return ipc.onestopSinglePointLadder(baseline);
}

/** 按勾选过滤核心库阶梯（保序）：有损项只留勾选格式，无损项只留勾选的无损组。 */
export function filterLadder(ladder: LadderItem[], selection: OnestopSelection): LadderItem[] {
  return ladder.filter((item) =>
    item.quality === null
      ? selection.losslessFormats.includes(item.format)
      : selection.lossyFormats.includes(item.format),
  );
}

export type { SizePoint };

/** onestop_size_search 回传的单格式搜索结果 */
export interface SizeSearchOutcome {
  format: string;
  targetBytes: number;
  /** 逼近目标选中的质量点（不可达时为最小/最高质量点） */
  hitQuality: number;
  hitBytes: number;
  /** 不可达标注（核心库 annotation_note 单一来源）；可达为 null */
  note: string | null;
  /** 命中点 + 邻近补点（升序 ≥3 点，多点便于比较档位），每点带实测大小 */
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
  // 后端回包是嵌套的 hit{quality,bytes}；这里摊平成界面用的 hitQuality/hitBytes，
  // 摊平规则只此一处（与旧实现一致，测试钉死）。
  const dto = await ipc.onestopSizeSearch(deps);
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

// ---------- 阶梯分组（界面按「格式一行、质量点一排」渲染预览网格） ----------

/** 一个格式在预览网格里的一行。 */
export interface LadderFormatRow {
  format: string;
  /** 格式显示名（如「JPEG」/「无损 WebP」） */
  label: string;
  /** 无损对照组（质量点恒为 1 个，不参与质量调参） */
  lossless: boolean;
  items: LadderItem[];
}

/**
 * 把阶梯按格式归组（保序：首次出现顺序即行顺序，行内保持核心库给定顺序）。
 *
 * 分组只用于展示与逐点勾选；生成清单仍以 LadderItem[] 为准（单一真源），
 * 因此这里不做过滤——勾选状态由调用方用 filterLadder / pickLadderItems 落到清单上。
 */
export function groupLadderByFormat(ladder: readonly LadderItem[]): LadderFormatRow[] {
  const rows: LadderFormatRow[] = [];
  const byFormat = new Map<string, LadderFormatRow>();
  for (const item of ladder) {
    let row = byFormat.get(item.format);
    if (!row) {
      const label =
        LOSSY_FORMATS.find((f) => f.format === item.format)?.label ??
        LOSSLESS_FORMATS.find((f) => f.format === item.format)?.label ??
        item.format;
      row = { format: item.format, label, lossless: item.quality === null, items: [] };
      byFormat.set(item.format, row);
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows;
}

/** 阶梯项的唯一键（预览网格里做逐点勾选用；同一格式内质量唯一）。 */
export function ladderItemKey(item: LadderItem): string {
  return `${item.format}:${item.quality === null ? 'lossless' : item.quality}`;
}

/** 从阶梯里按勾选键集合保留子集（保序）；keys 为 null 表示不按点过滤。 */
export function pickLadderItems(
  ladder: readonly LadderItem[],
  keys: ReadonlySet<string> | null,
): LadderItem[] {
  if (keys === null) return [...ladder];
  return ladder.filter((item) => keys.has(ladderItemKey(item)));
}

// ---------- 生成编排（纯顺序 + 失败收集，编码由调用方注入） ----------

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

export interface LadderRunDeps {
  /** 待生成清单（已按勾选过滤，顺序即生成顺序） */
  ladder: readonly LadderItem[];
  /** 生成一项产物；overwrite = 冲突拍板后带 overwrite 重调。实现方负责 IPC。 */
  encode: (item: LadderItem, overwrite: boolean) => Promise<OnestopEncodeOutcome>;
  /** 全部成功产物一次性纳入本轮（失败项不进来）。 */
  addCandidates: (products: readonly OnestopProduct[]) => Promise<void>;
  /** 阶段进度文案（如「正在生成 AVIF q75」）；N/M 由调用方以结构化进度提供。 */
  onProgress: (text: string) => void;
  /** 产物命名冲突询问（覆盖 / 跳过，含「本次全部」的批量语义）。 */
  onConflict: (fileName: string) => Promise<ConflictAnswer>;
}

/**
 * 跑完编码阶梯：逐项生成 → 产物纳入本轮。不含跑分（调用方接整轮 / 子集跑分）。
 *
 * 失败语义与旧实现一致：单项失败不回滚已成功项、继续其余项；中文原因收集后由
 * 调用方统一提示。冲突走 ConflictSession（一次跑分一个会话，「本次全部」只作用于本批）。
 */
export async function runLadder(deps: LadderRunDeps): Promise<OnestopResult> {
  const products: OnestopProduct[] = [];
  const formats: string[] = [];
  const failures: string[] = [];
  const conflicts = new ConflictSession(deps.onConflict);

  for (let i = 0; i < deps.ladder.length; i++) {
    const item = deps.ladder[i];
    deps.onProgress(`正在生成 ${item.label}`);
    try {
      let outcome = await deps.encode(item, false);
      if (outcome.kind === 'conflict') {
        const decision = await conflicts.decide(outcome.proposedName);
        if (decision === 'skip') {
          // 跳过：该产物不生成、不进轮，原因进失败清单（措辞与编码失败一致）
          failures.push(`${item.label}: 已跳过（${outcome.proposedName} 已存在）`);
          continue;
        }
        outcome = await deps.encode(item, true);
      }
      if (outcome.kind === 'done') {
        products.push(outcome.product);
        formats.push(item.format);
      }
    } catch (err) {
      // 后端返回的已是中文错误（编码器缺失 / 校验失败 / 编码失败），透传即可
      failures.push(`${item.label}: ${String(err)}`);
    }
  }

  if (products.length > 0) await deps.addCandidates(products);

  return {
    generated: products.length,
    failures,
    products: products.map((p, i) => ({ path: p.path, format: formats[i] })),
  };
}
