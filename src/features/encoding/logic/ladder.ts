// 一站式编码阶梯（原 src/onestop.ts 的重构版）：取点全部走核心库，前端不自持档位。
//
// 三种互斥方式（决策 0042）：
// - 单点：每个有损格式只压基准这一档（single_point_ladder）；
// - 阶梯：围绕基准取 3 档（quality_ladder）；
// - 目标大小：每个有损格式探测逼近目标，命中点与邻近档一起生成（size_search）。
// 无损对照默认不选，勾选后三种方式都原样追加。
//
// 本模块是纯逻辑：取点结果由调用方经 IPC 取好传入；生成顺序与失败语义由 runLadder
// 编排，编码动作由调用方注入。界面只消费 buildLadderPreview 的单一结果，保证
// 「预览就是要生成的清单」。

import { formatSize } from '../../../core/format';
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

/** 一站式勾选状态（界面会话态，重启归零）。格式用胶囊多选/移除。 */
export interface OnestopSelection {
  /** LOSSY_FORMATS 里 format 的子集 */
  lossyFormats: string[];
  /** LOSSLESS_FORMATS 里 format 的子集（无损对照组默认不在列、可勾选） */
  losslessFormats: string[];
}

/** 默认勾选：有损全选、无损不选（决策 0042；需要对照时手动点开）。 */
export function defaultSelection(): OnestopSelection {
  return {
    lossyFormats: LOSSY_FORMATS.map((f) => f.format),
    losslessFormats: [],
  };
}

/** 格式胶囊的选中切换（选中与取消），有损与无损共用。
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

/** 编码阶梯的三种互斥方式（决策 0042）。 */
export type LadderMode = 'single' | 'ladder' | 'size';

/** 阶梯方式取点：统一基准 0–100 映射到核心库完整阶梯（有损 4 格式各 3 点 + 无损对照组）。 */
export async function fetchQualityLadder(baseline: number): Promise<LadderItem[]> {
  return ipc.onestopQualityLadder(baseline);
}

/** 单点取点：每有损格式仅压基准质量 1 点（夹到格式范围）+ 无损对照组照常。 */
export async function fetchSinglePointLadder(baseline: number): Promise<LadderItem[]> {
  return ipc.onestopSinglePointLadder(baseline);
}

/** 按勾选过滤核心库阶梯（保序）：有损项只留勾选格式，无损项只留勾选的无损组。 */
export function filterLadder(
  ladder: readonly LadderItem[],
  selection: OnestopSelection,
): LadderItem[] {
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
  /** 命中点 + 邻近补点（升序 3 点，多点便于比较档位），每点带实测大小 */
  points: SizePoint[];
}

/** 目标大小方式单格式逼近搜索：探测编码在后端执行（探测产物落暂存目录即弃）。 */
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

/** 目标大小方式搜索结果 → 生成清单：命中点 + 邻近补点逐项展开（显示名取格式清单） */
export function sizeOutcomeLadder(outcome: SizeSearchOutcome): LadderItem[] {
  const label = LOSSY_FORMATS.find((f) => f.format === outcome.format)?.label ?? outcome.format;
  return outcome.points.map((point) => ({
    format: outcome.format,
    quality: point.quality,
    label: `${label} q${point.quality}`,
  }));
}

/** 目标大小方式的无损对照组清单项：大小固定不参与搜索，原样入清单（按勾选过滤） */
export function losslessLadder(selection: OnestopSelection): LadderItem[] {
  return LOSSLESS_FORMATS.filter((f) => selection.losslessFormats.includes(f.format)).map(
    (f) => ({ format: f.format, quality: null, label: f.label }),
  );
}

// ---------- 阶梯矩阵（预览与生成共用的唯一数据源） ----------

/** 矩阵里的一个档位格子（只读展示；生成清单由 plan 给出）。 */
export interface LadderCell {
  /** 同格式内唯一：`jpeg:75` / `png:lossless` */
  key: string;
  /** 格子主文本：`q75` / `无损` */
  text: string;
  /** 悬浮说明（完整格式名、实测字节、命中/不可达） */
  title: string;
  /** 目标大小方式的实测字节；质量/无损方式为 null */
  bytes: number | null;
  /** 目标大小方式的命中点 */
  hit: boolean;
}

/** 矩阵里的一行：一个编码格式。 */
export interface LadderRow {
  format: string;
  label: string;
  lossless: boolean;
  /** 是否勾选（行首胶囊是唯一勾选控件） */
  selected: boolean;
  cells: LadderCell[];
  /** 目标大小方式：已勾选但还没探测出结果 */
  pending: boolean;
  /** 目标大小方式：探测失败原因 */
  error: string | null;
  /** 目标大小方式：不可达标注（核心库原文） */
  note: string | null;
}

/** 预览与生成共用的完整结果。 */
export interface LadderPreview {
  /** 全部格式（含未勾选），用于矩阵稳定展示 */
  rows: LadderRow[];
  /** 真正要生成的清单（按格式顺序；与界面项数一致） */
  plan: LadderItem[];
  count: number;
  /** 目标大小方式：已勾选但还没探测的格式 */
  pendingFormats: string[];
  /** 目标大小方式：探测失败的格式 */
  failedFormats: string[];
  /** plan 里本轮已有相同编码参数的项数（仅提示，不阻止生成） */
  existingCount: number;
}

export interface LadderPreviewInput {
  mode: LadderMode;
  selection: OnestopSelection;
  /** 单点/阶梯取点结果；还没取到为 null */
  ladder: readonly LadderItem[] | null;
  sizeOutcomes: Readonly<Record<string, SizeSearchOutcome>>;
  sizeErrors: Readonly<Record<string, string>>;
  /** 本轮已有跑分图的编码参数文本（用于提示重复档位） */
  existingParams?: readonly string[];
}

/**
 * 构建矩阵与生成清单。
 *
 * 关键约束：`plan` 只由这里产出，界面渲染与生成入参都用它，因此「预览项数」与
 * 「实际生成项数」不可能漂移。未勾选的格式仍出现在 rows 里（灰显），避免取消后
 * 整行消失、再也勾不回来。
 */
export function buildLadderPreview(input: LadderPreviewInput): LadderPreview {
  const rows: LadderRow[] = [];
  const pendingFormats: string[] = [];
  const failedFormats: string[] = [];
  const lossyPlan: LadderItem[] = [];

  for (const format of LOSSY_FORMATS) {
    const selected = input.selection.lossyFormats.includes(format.format);

    if (input.mode === 'size') {
      const outcome = input.sizeOutcomes[format.format];
      const error = input.sizeErrors[format.format] ?? null;
      const cells: LadderCell[] = outcome
        ? outcome.points.map((point) => ({
            key: `${format.format}:${point.quality}`,
            text: `q${point.quality}`,
            title: `${format.label} q${point.quality}（${formatSize(point.bytes)}）${
              point.quality === outcome.hitQuality ? '，命中目标' : ''
            }`,
            bytes: point.bytes,
            hit: point.quality === outcome.hitQuality,
          }))
        : [];
      if (selected) {
        if (error !== null) failedFormats.push(format.format);
        else if (!outcome) pendingFormats.push(format.format);
        else lossyPlan.push(...sizeOutcomeLadder(outcome));
      }
      rows.push({
        format: format.format,
        label: format.label,
        lossless: false,
        selected,
        cells,
        pending: selected && outcome === undefined && error === null,
        error,
        note: outcome?.note ?? null,
      });
      continue;
    }

    const items = (input.ladder ?? []).filter(
      (item) => item.format === format.format && item.quality !== null,
    );
    rows.push({
      format: format.format,
      label: format.label,
      lossless: false,
      selected,
      cells: items.map((item) => ({
        key: ladderItemKey(item),
        text: `q${item.quality}`,
        title: item.label,
        bytes: null,
        hit: false,
      })),
      pending: selected && input.ladder === null,
      error: null,
      note: null,
    });
  }

  for (const format of LOSSLESS_FORMATS) {
    const selected = input.selection.losslessFormats.includes(format.format);
    rows.push({
      format: format.format,
      label: format.label,
      lossless: true,
      selected,
      cells: [
        {
          key: `${format.format}:lossless`,
          text: '无损',
          title: `${format.label}：无损对照（像素与原图逐位一致）`,
          bytes: null,
          hit: false,
        },
      ],
      pending: false,
      error: null,
      note: null,
    });
  }

  const plan =
    input.mode === 'size'
      ? [...lossyPlan, ...losslessLadder(input.selection)]
      : filterLadder(input.ladder ?? [], input.selection);
  const existing = new Set(input.existingParams ?? []);
  return {
    rows,
    plan,
    count: plan.length,
    pendingFormats,
    failedFormats,
    existingCount: plan.filter((item) => existing.has(item.label)).length,
  };
}

/** 阶梯项的唯一键（同一格式内质量唯一；无损用稳定后缀）。 */
export function ladderItemKey(item: LadderItem): string {
  return `${item.format}:${item.quality === null ? 'lossless' : item.quality}`;
}

// ---------- 目标大小滑杆（对数刻度，纯函数） ----------

/** 滑杆左端：1 KB。 */
export const SIZE_SLIDER_MIN_BYTES = 1024;

/** 滑杆右端：20 MB（精确输入框可超出，滑杆只做粗调）。 */
export const SIZE_SLIDER_MAX_BYTES = 20 * 1024 * 1024;

/** 滑杆刻度数（0 到 1000，步长 1）。 */
export const SIZE_SLIDER_STEPS = 1000;

/** 滑杆位置（0 到 1000）换算成目标字节数；对数刻度让 KB 与 MB 两段都够用。 */
export function bytesFromSlider(position: number): number {
  const clamped = Math.min(SIZE_SLIDER_STEPS, Math.max(0, position));
  const ratio = clamped / SIZE_SLIDER_STEPS;
  const bytes = SIZE_SLIDER_MIN_BYTES * Math.pow(SIZE_SLIDER_MAX_BYTES / SIZE_SLIDER_MIN_BYTES, ratio);
  return Math.max(1, Math.round(bytes));
}

/** 目标字节数换算成滑杆位置；超出 1 KB 到 20 MB 时夹到两端。 */
export function sliderFromBytes(bytes: number): number {
  const clamped = Math.min(SIZE_SLIDER_MAX_BYTES, Math.max(SIZE_SLIDER_MIN_BYTES, bytes));
  const ratio =
    Math.log(clamped / SIZE_SLIDER_MIN_BYTES) / Math.log(SIZE_SLIDER_MAX_BYTES / SIZE_SLIDER_MIN_BYTES);
  return Math.round(ratio * SIZE_SLIDER_STEPS);
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
  /** 成功产物（路径 + 格式）：目标大小方式模式按格式挂不可达标注（结果表备注列）用 */
  products: OnestopProductResult[];
}

export interface LadderRunDeps {
  /** 待生成清单（已按勾选过滤，顺序即生成顺序） */
  ladder: readonly LadderItem[];
  /** 生成一项产物；overwrite = 冲突拍板后带 overwrite 重调。实现方负责 IPC。 */
  encode: (item: LadderItem, overwrite: boolean) => Promise<OnestopEncodeOutcome>;
  /** 全部成功产物一次性纳入本轮（失败项不进来）。 */
  addCandidates: (products: readonly OnestopProduct[]) => Promise<void>;
  /** 阶段进度文案（如「正在生成 AVIF q75」）；N/M 由调用方以结构化进度提供。
   * completed = 本项之前已处理的项数（首项为 0），只用于进度，不拼进文案。 */
  onProgress: (text: string, completed: number) => void;
  /** 产物命名冲突询问（覆盖 / 跳过，含「本次全部」的批量语义）。 */
  onConflict: (fileName: string) => Promise<ConflictAnswer>;
}

/**
 * 跑完编码阶梯：逐项生成 → 产物纳入本轮。不含跑分（调用方只对本次新产物跑分）。
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
    deps.onProgress(`正在生成 ${item.label}`, i);
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
