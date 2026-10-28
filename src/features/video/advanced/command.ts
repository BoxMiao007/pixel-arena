// 视频高级创建的纯逻辑：参数合并 / 冲突校验 / 命令行预览 / 编码器可用性汇总。
//
// 与核心库 crates/pixel-arena-core/src/advanced.rs 的镜像关系（跨语言无法复用，
// 人工同步，单测各自钉死行为）：
// - mergeArgs ↔ merge_args（决策 D10/D11：高级参数追加到基础命令行末尾，仅同标志
//   判冲突；未启用的行整体跳过）；
// - shellQuote ↔ naming::shell_quote（预览复制出来可直接在 shell 执行）；
// - 预览布局 ↔ 视频产物布局 `ffmpeg -y -i 输入 -c:v 编码器 参数 产物`。
//
// 本文件不碰 DOM / IPC，可直接单测。旧实现见 main 分支 src/advanced.ts；视频域按
// video-spec §0.3「可复用的纯逻辑复制进本域」保留一份等价实现。

import type {
  AdvancedEntry,
  AdvancedParamRow,
  QuickSpec,
  ToolStatusLite,
  VideoSpec,
} from './catalog';

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
      throw new Error(
        `高级参数「${name}」的标志「${flag}」无效：标志必须以 - 开头（如 -threads 或 --sharpyuv）`,
      );
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
export function quickBaseArgs(
  spec: QuickSpec,
  lossless: boolean,
  quality: number,
): string[] {
  const args = [...spec.baseArgs];
  if (lossless) {
    if (!spec.losslessSupported) {
      throw new Error(`${spec.displayName}：${spec.losslessNote}`);
    }
    return [...args, ...spec.losslessArgs];
  }
  if (!Number.isFinite(quality) || quality < spec.qualityMin || quality > spec.qualityMax) {
    throw new Error(
      `${spec.displayName} 的质量 ${quality} 无效，有效范围 ${spec.qualityMin}–${spec.qualityMax}`,
    );
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
export function buildEntryArgsLenient(
  spec: QuickSpec | null,
  entry: AdvancedEntry,
): string[] {
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

// ---------- 校验（必填缺失 / 范围 / 冲突，收集全部错误一次报出） ----------

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

// ---------- 编码器可执行文件可用性（建轮前批量前置校验） ----------

/**
 * 建轮前批量校验条目编码器的可执行文件是否可用（含设置页外部路径覆盖）。判定
 * 与设置页 tool_status 同源：external/builtin = 可用；unconfigured（内置文件缺失，
 * 运行期不再自动下载）与 unavailable（外部路径失效/探测失败/内置损坏）= 明确报错
 * 并指向设置页。ffmpeg 的 unconfigured 例外放行：它的就位方式是设置页「应用内
 * 下载」，跑分时报错已有专门指引，不在建轮入口拦。视频条目的工具键统一 ffmpeg
 * （表外编码器没有独立可执行文件，但 ffmpeg 仍是它真正的依赖）。
 * 返回 entryId → 错误文本（空 = 全部可用）。
 */
export function availabilityErrors(
  entries: AdvancedEntry[],
  toolKeyOf: (entry: AdvancedEntry) => string | null,
  statuses: ToolStatusLite[],
): Map<string, string> {
  const byKey = new Map(statuses.map((status) => [status.key, status]));
  const errors = new Map<string, string>();
  for (const entry of entries) {
    const key = toolKeyOf(entry);
    if (!key) continue;
    const status = byKey.get(key);
    if (!status) {
      errors.set(entry.id, `编码器 ${key} 的可用性检测失败（后端未返回该工具的状态），请重试`);
    } else if (status.source === 'unavailable') {
      errors.set(
        entry.id,
        `编码器 ${key} 不可用：${status.hint ?? '可执行文件无法执行'}。` +
          '请到「设置」更正或清空该工具的路径并保存后重试',
      );
    } else if (status.source === 'unconfigured' && key !== 'ffmpeg') {
      errors.set(
        entry.id,
        `编码器 ${key} 未就绪：${status.hint ?? '内置编码器文件缺失，运行期不再自动下载'}。` +
          '请到「设置 → 编码器」从官方发布页获取后指定外部路径，或重新安装应用',
      );
    }
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

/** 输入/输出占位（原视频未选或产物名要等用户自行编码才知道）。 */
const INPUT_PLACEHOLDER = '<原图>';
const OUTPUT_PLACEHOLDER = '<产物>';

/**
 * 视频条目的命令行预览：`ffmpeg -y -i 输入 -c:v 编码器 参数 产物`。表外编码器
 *（spec = null）没有推荐参数，只拼参数行（宽松合并，与卡片预览同口径）。
 * 占位符沿用旧实现（`<原图>` / `<产物>`），保证面板内预览与轮备注里的命令行一致。
 */
export function previewVideoCommand(
  spec: VideoSpec | null,
  entry: AdvancedEntry,
  inputPath: string | null,
): string {
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
