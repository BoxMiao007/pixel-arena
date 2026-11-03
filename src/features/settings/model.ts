// 设置域的纯逻辑：分区清单、选项文案、工具状态到展示模型的映射、并发换算、诊断文本。
//
// 这一层刻意不碰 DOM / IPC / 定时器：面板里所有「文案与判定」都在这里算好，
// sections/ 只负责把结果画出来；model.test.ts 在 node 环境直接对这些函数断言。

import {
  ENCODER_FIELDS,
  releasePageHref,
  sourceLabel,
  type AboutData,
  type SettingsData,
  type ScoreConcurrencyPref,
  type ToolSourceState,
  type ToolStatus,
} from '../../core/settings';
import { versionLabel } from '../../core/util';
import type { BadgeKind } from '../../ui/primitives';

// ---------- 分区 ----------

export type SectionId = 'appearance' | 'recording' | 'scoring' | 'ffmpeg' | 'encoders' | 'about';

export interface SectionMeta {
  id: SectionId;
  label: string;
}

/** 设置窗口左侧导航的分区顺序（也决定首次打开落在哪一区）。 */
export const SETTINGS_SECTIONS: readonly SectionMeta[] = [
  { id: 'appearance', label: '外观' },
  { id: 'recording', label: '记录' },
  { id: 'scoring', label: '跑分与导出' },
  { id: 'ffmpeg', label: 'FFmpeg' },
  { id: 'encoders', label: '编码器' },
  { id: 'about', label: '关于' },
];

export const DEFAULT_SECTION: SectionId = 'appearance';

export function sectionLabel(id: SectionId): string {
  return SETTINGS_SECTIONS.find((item) => item.id === id)?.label ?? id;
}

// ---------- 选项（值与后端 serde 小写常量一一对应） ----------

export const THEME_CHOICES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

/** 并发度按逻辑核占比表述（与核心库 parallel::concurrency_limit 同口径）。 */
export const CONCURRENCY_CHOICES = [
  { value: 'quarter', label: '1/4 逻辑核' },
  { value: 'half', label: '1/2 逻辑核' },
  { value: 'threequarters', label: '3/4 逻辑核' },
  { value: 'full', label: '全部逻辑核' },
] as const;

export const CONFLICT_CHOICES = [
  { value: 'auto', label: '自动追加序号' },
  { value: 'ask', label: '写入前询问' },
] as const;

const CONCURRENCY_FRACTION: Record<ScoreConcurrencyPref, number> = {
  quarter: 0.25,
  half: 0.5,
  threequarters: 0.75,
  full: 1,
};

/**
 * 并发度 → 实际并行任务数。与后端 parallel::concurrency_limit 同口径：
 * 先按逻辑核数乘比例向下取整，再夹到 [1, 核数]（核数非法时按 1 处理）。
 */
export function concurrencyWorkers(pref: ScoreConcurrencyPref, cores: number): number {
  const safeCores = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  const workers = Math.floor(safeCores * CONCURRENCY_FRACTION[pref]);
  return Math.max(1, Math.min(safeCores, workers));
}

/** 并发度下方的一行说明：让用户看到「这一档实际用几个」。 */
export function concurrencyHint(pref: ScoreConcurrencyPref, cores: number): string {
  return `本机 ${cores} 个逻辑核，当前同时跑 ${concurrencyWorkers(pref, cores)} 个任务`;
}

// ---------- 工具状态 → 展示模型 ----------

export type ToolPhase = 'loading' | 'ready' | 'timeout' | 'error';

export interface ToolView {
  key: string;
  label: string;
  badgeText: string;
  badgeKind: BadgeKind;
  /** 简化版本号（v4.1.5）；没有版本信息时为 ''。 */
  version: string;
  /** 实际生效的可执行文件路径；'' 表示没有生效路径。 */
  effectivePath: string;
  /** 中文补全说明（缺失原因、超时提示等）；'' 表示不必展示。 */
  note: string;
  /** 官方发布页（仅 https，已过白名单）；null = 不展示链接。 */
  releaseUrl: string | null;
}

/** 工具键的展示顺序 = settings_tool_status 的返回顺序。 */
export const TOOL_KEYS = ['ffmpeg', 'cjpeg', 'cwebp', 'avifenc', 'cjxl', 'avifdec'] as const;

const BADGE_BY_SOURCE: Record<ToolSourceState, BadgeKind> = {
  builtin: 'ok',
  external: 'accent',
  unconfigured: 'neutral',
  unavailable: 'danger',
};

/** 工具键的用户可读名：编码器标签取 core 的单一来源，ffmpeg 单独一条。 */
export function toolLabel(key: string): string {
  if (key === 'ffmpeg') return 'FFmpeg';
  return ENCODER_FIELDS.find((field) => field.key === key)?.label ?? key;
}

/**
 * 把一个工具的状态拼成界面要的展示模型。四种非正常态都在这里定文案：
 * - 没有结果且正在检测 → 「检测中…」
 * - 没有结果且检测超时 → 「检测超时」+ 重试提示（后端探测没有超时，必须给出口）
 * - 没有结果且 IPC 失败 → 「检测失败」+ 原因
 * - 有结果但有本次超时 → 保留上次结果，note 里说明是旧值
 */
export function describeTool(
  key: string,
  status: ToolStatus | undefined,
  phase: ToolPhase,
  error: string | null,
): ToolView {
  const label = toolLabel(key);
  if (!status) {
    if (phase === 'error') {
      return {
        key,
        label,
        badgeText: '检测失败',
        badgeKind: 'danger',
        version: '',
        effectivePath: '',
        note: `检测失败：${error ?? '未知原因'}。可点「重新检测」重试`,
        releaseUrl: null,
      };
    }
    if (phase === 'timeout') {
      return {
        key,
        label,
        badgeText: '检测超时',
        badgeKind: 'danger',
        version: '',
        effectivePath: '',
        note: '检测超时：外部工具可能无响应。可点「重新检测」重试',
        releaseUrl: null,
      };
    }
    return {
      key,
      label,
      badgeText: '检测中…',
      badgeKind: 'neutral',
      version: '',
      effectivePath: '',
      note: '',
      releaseUrl: null,
    };
  }

  const version = status.detectedVersion ?? status.builtinVersion;
  const staleNote =
    phase === 'timeout' ? '本次重新检测超时，下面是上一次的结果' : '';
  return {
    key,
    label,
    badgeText: sourceLabel(status.source),
    badgeKind: BADGE_BY_SOURCE[status.source],
    version: version === null ? '' : versionLabel(version),
    effectivePath: status.effectivePath ?? '',
    note: [status.hint, staleNote].filter(Boolean).join('；'),
    releaseUrl: releasePageHref(status),
  };
}

/** 所有工具行的展示模型（顺序固定，对应表格里的一行）。 */
export function describeTools(
  statuses: ReadonlyMap<string, ToolStatus> | null,
  phase: ToolPhase,
  error: string | null,
): ToolView[] {
  return TOOL_KEYS.map((key) => describeTool(key, statuses?.get(key), phase, error));
}

// ---------- 下载进度 ----------

export interface DownloadProgress {
  /** 0–1；总量未知时为 null（界面走不确定态）。 */
  ratio: number | null;
  /** 原文照显（包含「一次性」「约 N MB」等后端说明）。 */
  text: string;
}

/**
 * 解析后端进度文本里「12.3 / 40.0 MB」这一段；解析不出就只回原文。
 * 文本是后端 ffmpeg_setup::download_to_file 拼的，格式变动时退化为不确定态，不报错。
 */
export function parseDownloadProgress(message: string): DownloadProgress {
  const match = /([\d.]+)\s*\/\s*([\d.]+)\s*MB/.exec(message);
  if (!match) return { ratio: null, text: message };
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
    return { ratio: null, text: message };
  }
  return { ratio: Math.min(1, Math.max(0, done / total)), text: message };
}

// ---------- 恢复默认的影响范围 ----------

/**
 * 「全部恢复默认」确认框里的一句话：按当前设置算出真的会被清掉多少条外部路径，
 * 0 条时不提路径（避免「将清空 0 条」这种废话）。
 */
export function defaultsImpact(settings: SettingsData): string {
  const encoderCount = Object.values(settings.encoderOverrides).filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  ).length;
  const hasFfmpeg = typeof settings.ffmpegPath === 'string' && settings.ffmpegPath.trim() !== '';
  const cleared: string[] = [];
  if (encoderCount > 0) cleared.push(`${encoderCount} 条编码器路径`);
  if (hasFfmpeg) cleared.push('FFmpeg 路径');

  const parts: string[] = [];
  if (cleared.length > 0) parts.push(`清空 ${cleared.join('与 ')}`);
  // 「记住上次状态」默认是开的：本来是关的要说明会被重新打开（下次启动就会恢复）
  const recordTail = settings.recordState ? '' : '，同时打开「记住上次状态」';
  parts.push(`恢复默认主题、跑分并发度、文件名冲突策略与默认导出目录${recordTail}`);
  return `将${parts.join('，并')}。此操作无法撤销。`;
}

// ---------- 许可证 ----------

/**
 * 许可证短标识：后端给的协议文本可能带括号补充（如
 * `BSD-3-Clause（另含 IJG、zlib 条款）`），表格列只放前半段，全文留给悬停。
 */
export function licenseShort(license: string): string {
  const cut = license.search(/[（(]/);
  const short = cut >= 0 ? license.slice(0, cut) : license;
  const trimmed = short.trim();
  return trimmed === '' ? license : trimmed;
}

// ---------- 诊断信息 ----------

export interface DiagnosticInput {
  about: AboutData | null;
  tools: ReadonlyMap<string, ToolStatus> | null;
  phase: ToolPhase;
  error: string | null;
}

/**
 * 一键复制用的纯文本：应用与核心库版本 + 六个工具的来源/版本/实际生效路径。
 * 只用换行与两个空格对齐，不写中点分隔符，粘进 issue 也能读。
 */
export function diagnosticsText(input: DiagnosticInput): string {
  const lines: string[] = [];
  const about = input.about;
  if (about) {
    lines.push(`${about.appName} v${about.appVersion}（核心库 v${about.coreVersion}）`);
  } else {
    lines.push('Pixel Arena（关于信息未加载）');
  }
  for (const view of describeTools(input.tools, input.phase, input.error)) {
    const version = view.version === '' ? '版本未知' : view.version;
    const path = view.effectivePath === '' ? '无生效路径' : view.effectivePath;
    lines.push(`${view.label}  ${view.badgeText}  ${version}  ${path}`);
  }
  return lines.join('\n');
}
