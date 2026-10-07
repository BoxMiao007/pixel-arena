// 高级创建（T29-3）：会话态数据模型 + 参数合并/冲突校验 + 命令行预览的纯函数。
//
// 与核心库 crates/pixel-arena-core/src/advanced.rs 的镜像关系（跨语言无法复用，
// 人工同步，两侧测试各自钉死行为）：
// - mergeArgs ↔ merge_args（决策 D10/D11：高级参数追加到基础命令行末尾，仅同标志
//   判冲突；未启用的行整体跳过）；
// - shellQuote ↔ naming::shell_quote（预览复制出来可直接在 shell 执行）；
// - 预览布局 ↔ layout_words（cjpeg 用 -outfile、cwebp 输入后跟 -o、其余位置参数）。
// 界面预览是即时估算；提交编码时后端会用同一套逻辑重新合并并权威校验，两边不一致
// 以后端报错为准。
//
// 会话态（决策 D19）：高级创建的编码器配置按跑分组存内存（Map），切标签保留、
// 重启归零；不写任何文件。产物与 encodingParams 经既有 round_add_candidates 随
// 评测轮持久化（由 advanced-ui 的创建流程负责）。

/** 后端 ParamValueKind 的 serde tag=type 输出（camelCase）。 */
export type ParamValueKind =
  | { type: 'bool' }
  | { type: 'number'; min: number; max: number; step: number; default: number }
  | { type: 'choice'; options: string[]; default: string }
  | { type: 'text' };

/** 编码器特有的一条推荐参数（添加参数行时预填名称/标志/说明与默认值）。 */
export interface KnownParam {
  name: string;
  flag: string;
  kind: ParamValueKind;
  note: string;
}

/** 快速参数相关规格（图片与视频通用子集，后端 camelCase DTO 一一对应）。 */
export interface QuickSpec {
  displayName: string;
  baseArgs: string[];
  losslessSupported: boolean;
  losslessNote: string;
  losslessArgs: string[];
  qualityFlag: string;
  qualityMin: number;
  qualityMax: number;
}

/** 图片编码器规格（advanced_image_catalog 的条目）。 */
export interface ImageSpec extends QuickSpec {
  id: string;
  toolKey: string;
  qualityDefault: number;
  qualityStep: number;
  inputPng: boolean;
  outputExt: string;
  knownParams: KnownParam[];
}

/** 视频编码器规格（advanced_video_catalog 的静态表条目，决策 D12/D13）。 */
export interface VideoSpec extends QuickSpec {
  id: string;
  ffmpegName: string;
  qualityDefault: number;
  knownParams: KnownParam[];
  note: string;
}

/** advanced_video_catalog 回传（决策 D14：-encoders 动态枚举 + 静态映射表）。 */
export interface AdvancedVideoCatalog {
  ffmpegAvailable: boolean;
  ffmpegPath: string | null;
  ffmpegError: string | null;
  /** 枚举到的全部视频编码器名（含表外的）。 */
  encoderNames: string[];
  specs: VideoSpec[];
}

/** 参数行的控件种类（布尔开关 / 数值 / 下拉 / 自由文本，票面验收 3）。 */
export type RowKind = 'bool' | 'number' | 'choice' | 'text';

/** 一条高级参数行。value 为字符串（'' = 布尔开关不带值）；enabled 是布尔行的
 * 勾选态，false = 整行不参与（不追加也不判冲突，与核心库语义一致）。 */
export interface AdvancedParamRow {
  name: string;
  flag: string;
  value: string;
  note: string;
  kind: RowKind;
  options: string[];
  enabled: boolean;
}

/** 高级创建的一个编码器条目（同一编码器可以出现多次）。 */
export interface AdvancedEntry {
  id: string;
  kind: 'image' | 'video';
  /** 图片 = 规格 id（jpeg/webp/avif/jxl）；视频 = ffmpeg 编码器名（表外也可选）。 */
  encoderId: string;
  lossless: boolean;
  mode: 'quality' | 'size';
  quality: number;
  /** 目标大小真值一律是字节（KB/MB 只是显示口径，与一站式同约定）。 */
  targetBytes: number;
  unit: 'KB' | 'MB';
  rows: AdvancedParamRow[];
}

/** 一个跑分组的高级创建会话态（D19：仅会话态，重启归零）。 */
export interface AdvancedSession {
  kind: 'image' | 'video';
  /** 图片高级创建的原图（创建时传给后端编码）。 */
  referencePath: string | null;
  entries: AdvancedEntry[];
}

// ---------- 会话态（模块级 Map：切标签保留、重启归零，不持久化） ----------

const sessions = new Map<string, AdvancedSession>();

let nextId = 1;

/** 生成条目 id（会话内唯一即可）。 */
export function newEntryId(): string {
  return `adv-${nextId++}`;
}

/** 取跑分组的高级创建会话；首次用到时建空会话（用户再加编码器条目）。 */
export function sessionFor(groupId: string, kind: 'image' | 'video'): AdvancedSession {
  let session = sessions.get(groupId);
  if (!session) {
    session = { kind, referencePath: null, entries: [] };
    sessions.set(groupId, session);
  }
  return session;
}

/** 丢弃跑分组的高级创建会话（创建成功后调用，下次从干净配置开始）。 */
export function dropSession(groupId: string): void {
  sessions.delete(groupId);
}

/** 清空全部会话（「重启归零」语义的显式入口；测试用）。 */
export function clearAdvancedSessions(): void {
  sessions.clear();
}

/** 新建一个默认编码器条目（质量优先、规格默认质量、无参数行）。 */
export function newEntry(kind: 'image' | 'video', encoderId: string, spec: QuickSpec & { qualityDefault?: number }): AdvancedEntry {
  return {
    id: newEntryId(),
    kind,
    encoderId,
    lossless: false,
    mode: 'quality',
    quality: spec.qualityDefault ?? 75,
    targetBytes: 200 * 1024,
    unit: 'KB',
    rows: [],
  };
}

// ---------- 条目增删排序（可同一编码器多次） ----------

/** 添加一个条目（同一编码器可多次添加，票面验收 1）。返回新条目。 */
export function addEntry(session: AdvancedSession, encoderId: string, spec: QuickSpec & { qualityDefault?: number }): AdvancedEntry {
  const entry = newEntry(session.kind, encoderId, spec);
  session.entries.push(entry);
  return entry;
}

/** 删除第 index 个条目；越界不动。 */
export function removeEntry(session: AdvancedSession, index: number): void {
  if (index < 0 || index >= session.entries.length) return;
  session.entries.splice(index, 1);
}

/** 排序：第 index 个条目上移（delta=-1）或下移（delta=1）；越界不动。 */
export function moveEntry(session: AdvancedSession, index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (index < 0 || index >= session.entries.length) return;
  if (target < 0 || target >= session.entries.length) return;
  const [entry] = session.entries.splice(index, 1);
  session.entries.splice(target, 0, entry);
}

// ---------- 参数合并（核心库 merge_args 的 TS 镜像，测试钉死行为） ----------

/** 是否为标志词：以 - 开头且第二个字符不是数字（容忍 -1 这类负数取值）。 */
export function isFlag(word: string): boolean {
  if (!word.startsWith('-')) return false;
  const rest = word.slice(1);
  return rest.length > 0 && !/^[0-9]/.test(rest);
}

/** 启用行的命令词：标志 + 值（值空白 = 布尔开关，只有标志）。未启用行返回 []。 */
export function rowWords(row: AdvancedParamRow): string[] {
  if (!row.enabled) return [];
  const flag = row.flag.trim();
  const value = row.value.trim();
  return value === '' ? [flag] : [flag, value];
}

/**
 * 快速参数基础命令行 + 高级参数行合并（决策 D10/D11）：高级参数按行序追加到
 * 基础参数末尾；任一标志重复（基础 ↔ 高级、高级行之间）抛中文错误点名标志。
 * 未启用的行整体跳过（既不追加也不参与冲突判定）。
 */
export function mergeArgs(baseArgs: string[], rows: AdvancedParamRow[]): string[] {
  const args = [...baseArgs];
  const seen = new Set(baseArgs.filter((word) => isFlag(word)));
  for (const row of rows) {
    if (!row.enabled) continue;
    const name = row.name.trim();
    if (name === '') {
      throw new Error('高级参数行缺少参数名，请填写后重试');
    }
    const flag = row.flag.trim();
    if (!isFlag(flag)) {
      throw new Error(`高级参数「${name}」的标志「${flag}」无效：标志必须以 - 开头（如 -threads 或 --sharpyuv）`);
    }
    if (seen.has(flag)) {
      throw new Error(
        `参数标志冲突：${flag} 重复出现。同一个标志只能在快速参数或高级参数里出现一处` +
          `（不同写法的同义参数不判冲突，请在命令行预览里自查）`,
      );
    }
    seen.add(flag);
    args.push(...rowWords(row));
  }
  return args;
}

/**
 * 快速参数 → 基础命令行（核心库 quick_base_args 的 TS 镜像）：无损模式追加
 * losslessArgs（不支持时报错）；质量模式追加 qualityFlag + 质量值（越界报错）。
 */
export function quickBaseArgs(spec: QuickSpec, lossless: boolean, quality: number): string[] {
  const args = [...spec.baseArgs];
  if (lossless) {
    if (!spec.losslessSupported) {
      throw new Error(`${spec.displayName}：${spec.losslessNote}`);
    }
    return [...args, ...spec.losslessArgs];
  }
  if (!Number.isFinite(quality) || quality < spec.qualityMin || quality > spec.qualityMax) {
    throw new Error(`${spec.displayName} 的质量 ${quality} 无效，有效范围 ${spec.qualityMin}–${spec.qualityMax}`);
  }
  return [...args, spec.qualityFlag, String(Math.round(quality))];
}

/** 合并快速参数与高级参数（抛错版）；创建时的权威校验用。 */
export function buildEntryArgs(spec: QuickSpec, entry: AdvancedEntry): string[] {
  return mergeArgs(quickBaseArgs(spec, entry.lossless, entry.quality), entry.rows);
}

/**
 * 预览用的宽松合并：跳过没填完/非法的行，不判冲突——预览要能跟着输入即时刷新
 *（半填的参数行不该把整个面板渲染打断），错误由创建时的 mergeArgs 权威报出。
 */
export function buildEntryArgsLenient(spec: QuickSpec | null, entry: AdvancedEntry): string[] {
  let base: string[];
  if (!spec) {
    base = [];
  } else {
    try {
      base = quickBaseArgs(spec, entry.lossless, entry.quality);
    } catch {
      base = [...spec.baseArgs];
    }
  }
  const args = [...base];
  for (const row of entry.rows) {
    if (!row.enabled) continue;
    const flag = row.flag.trim();
    if (!isFlag(flag)) continue; // 没填完/非法的行不进预览
    args.push(flag);
    const value = row.value.trim();
    if (value !== '') args.push(value);
  }
  return args;
}

// ---------- 校验（票面验收 5：必填缺失 / 范围 / 冲突，收集全部错误一次报出） ----------

/** 校验单个条目，返回中文错误列表（空 = 通过）。不抛错，方便面板汇总展示。
 * 参数行冲突对照快速参数的标志集合判（与核心库提交时的权威校验同口径）。 */
export function validateEntry(spec: QuickSpec | null, entry: AdvancedEntry): string[] {
  const errors: string[] = [];
  let baseArgs: string[] = [];
  if (spec) {
    try {
      baseArgs = quickBaseArgs(spec, entry.lossless, entry.quality);
    } catch (err) {
      errors.push(String((err as Error).message ?? err));
    }
    if (!entry.lossless && entry.mode === 'size' && !(entry.targetBytes >= 1)) {
      errors.push('目标大小无效：请输入大于 0 的数值');
    }
  }
  try {
    mergeArgs(baseArgs, entry.rows);
  } catch (err) {
    errors.push(String((err as Error).message ?? err));
  }
  return errors;
}

// ---------- 命令行预览（shell 引用，复制即可执行） ----------

/** POSIX shell 单词引用（核心库 naming::shell_quote 的 TS 镜像）。 */
export function shellQuote(word: string): string {
  const plain =
    word !== '' &&
    [...word].every((c) => /[A-Za-z0-9_.\-/:=@%+,]/.test(c));
  if (plain) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/** 命令行预览：可执行文件 + 词序列，逐词 shell 引用后拼一行。 */
export function formatCommandLine(executable: string, words: string[]): string {
  return [executable, ...words].map(shellQuote).join(' ');
}

/** 输入/输出占位（原图未选或产物名要等冲突去重才知道）。 */
const INPUT_PLACEHOLDER = '<原图>';
const OUTPUT_PLACEHOLDER = '<产物>';

/** 图片条目的命令行预览（布局与核心库 layout_words 一致：cjpeg 用 -outfile、
 * cwebp 输入后跟 -o、avifenc/cjxl 位置参数）。用宽松合并：参数行没填完时预览
 * 仍然可用（错误在创建时权威报出）。 */
export function previewImageCommand(spec: ImageSpec, entry: AdvancedEntry, inputPath: string | null): string {
  const args = buildEntryArgsLenient(spec, entry);
  const input = inputPath ?? INPUT_PLACEHOLDER;
  const executable = spec.toolKey;
  let words: string[];
  if (spec.id === 'jpeg') {
    words = [...args, '-outfile', OUTPUT_PLACEHOLDER, input];
  } else if (spec.id === 'webp') {
    words = [...args, input, '-o', OUTPUT_PLACEHOLDER];
  } else {
    words = [...args, input, OUTPUT_PLACEHOLDER];
  }
  return formatCommandLine(executable, words);
}

/** 视频条目的命令行预览：ffmpeg -y -i 输入 -c:v 编码器 参数 产物。表外编码器
 *（spec = null）没有推荐参数，只拼参数行（宽松合并，同图片侧）。 */
export function previewVideoCommand(spec: VideoSpec | null, entry: AdvancedEntry, inputPath: string | null): string {
  const input = inputPath ?? INPUT_PLACEHOLDER;
  const encoderName = spec?.ffmpegName ?? entry.encoderId;
  const quick = spec ? quickBaseArgs(spec, entry.lossless, entry.quality) : [];
  const words = [
    '-y',
    '-i',
    input,
    '-c:v',
    encoderName,
    ...quick,
    // 参数行走宽松合并（spec = null → 只拼参数行；非法行跳过，错误创建时报出）
    ...buildEntryArgsLenient(null, entry),
    OUTPUT_PLACEHOLDER,
  ];
  return formatCommandLine('ffmpeg', words);
}
