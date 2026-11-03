// 设置域纯逻辑与工具状态加载的单测（node 环境，无 DOM）。
//
// 断言的都是「界面上能看到什么」的判定：徽标文案与配色档、生效路径的取舍、并发档
// 换算成实际任务数、下载进度的解析、恢复默认的影响范围、诊断文本的行结构。

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SettingsData, ToolStatus } from '../../core/settings';
import { defaultSettings } from '../../core/settings';
import {
  CONCURRENCY_CHOICES,
  SETTINGS_SECTIONS,
  TOOL_KEYS,
  concurrencyHint,
  concurrencyWorkers,
  defaultsImpact,
  describeTool,
  describeTools,
  diagnosticsText,
  licenseShort,
  parseDownloadProgress,
  toolLabel,
} from './model';
import { createToolsWatcher } from './tools';
import { displayPath } from './tool-row';

/** 一条工具状态的测试夹具：只写关心的字段，其余按「内置且可用」给默认。 */
function statusOf(patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    key: 'cjpeg',
    source: 'builtin',
    overridePath: null,
    effectivePath: 'C:/app/encoders/cjpeg.exe',
    builtinVersion: '4.1.5',
    builtinInstalled: true,
    detectedVersion: 'mozjpeg version 4.1.5 (build 20261005)',
    releasePage: 'https://github.com/mozilla/mozjpeg/releases',
    hint: null,
    ...patch,
  };
}

/** 一份「有两条外部路径」的设置，用于恢复默认的影响范围断言。 */
function settingsWithPaths(): SettingsData {
  const base = defaultSettings();
  return {
    ...base,
    encoderOverrides: { ...base.encoderOverrides, cjpeg: 'D:/tools/cjpeg.exe', cjxl: 'D:/tools/cjxl.exe' },
    ffmpegPath: 'D:/tools/ffmpeg.exe',
  };
}

describe('分区与选项', () => {
  it('六个分区按导航顺序排列，id 唯一', () => {
    expect(SETTINGS_SECTIONS.map((item) => item.id)).toEqual([
      'appearance',
      'recording',
      'scoring',
      'ffmpeg',
      'encoders',
      'about',
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((item) => item.id)).size).toBe(6);
  });

  it('并发四档与后端 serde 小写取值一一对应', () => {
    expect(CONCURRENCY_CHOICES.map((item) => item.value)).toEqual([
      'quarter',
      'half',
      'threequarters',
      'full',
    ]);
  });
});

describe('concurrencyWorkers（并发档位换算实际任务数）', () => {
  it('按逻辑核比例向下取整', () => {
    expect(concurrencyWorkers('half', 16)).toBe(8);
    expect(concurrencyWorkers('quarter', 16)).toBe(4);
    expect(concurrencyWorkers('threequarters', 16)).toBe(12);
    expect(concurrencyWorkers('full', 16)).toBe(16);
  });

  it('取整后至少 1 个、最多不超过核数（保住「有得跑」）', () => {
    expect(concurrencyWorkers('quarter', 2)).toBe(1); // floor(0.5)=0 → 夹到 1
    expect(concurrencyWorkers('half', 1)).toBe(1);
    expect(concurrencyWorkers('half', 3)).toBe(1); // floor(1.5)=1
    expect(concurrencyWorkers('full', 3)).toBe(3);
  });

  it('核数非法时按 1 处理，不产生 0 或 NaN', () => {
    expect(concurrencyWorkers('half', 0)).toBe(1);
    expect(concurrencyWorkers('full', Number.NaN)).toBe(1);
  });

  it('说明行把核数与实际任务数一起写出来', () => {
    expect(concurrencyHint('half', 16)).toBe('本机 16 个逻辑核，当前同时跑 8 个任务');
  });
});

describe('describeTool（四态与异常态 → 徽标与行文案）', () => {
  it('内置：绿档徽标 + 简化版本 + 实际生效路径', () => {
    const view = describeTool('cjpeg', statusOf(), 'ready', null);
    expect(view.badgeText).toBe('内置');
    expect(view.badgeKind).toBe('ok');
    expect(view.version).toBe('v4.1.5');
    expect(view.effectivePath).toBe('C:/app/encoders/cjpeg.exe');
    expect(view.releaseUrl).toBe('https://github.com/mozilla/mozjpeg/releases');
  });

  it('外部：琥珀档徽标，路径取覆盖后的生效路径', () => {
    const view = describeTool(
      'cjpeg',
      statusOf({ source: 'external', overridePath: 'D:/tools/cjpeg.exe', effectivePath: 'D:/tools/cjpeg.exe' }),
      'ready',
      null,
    );
    expect(view.badgeText).toBe('外部');
    expect(view.badgeKind).toBe('accent');
    expect(view.effectivePath).toBe('D:/tools/cjpeg.exe');
  });

  it('未配置：中性档，没有生效路径，hint 原文进说明行', () => {
    const view = describeTool(
      'cwebp',
      statusOf({
        key: 'cwebp',
        source: 'unconfigured',
        effectivePath: null,
        detectedVersion: null,
        builtinInstalled: false,
        releasePage: null,
        hint: '内置文件缺失：请从官方发布页下载编码器',
      }),
      'ready',
      null,
    );
    expect(view.badgeText).toBe('未配置');
    expect(view.badgeKind).toBe('neutral');
    expect(view.effectivePath).toBe('');
    expect(view.version).toBe('v4.1.5'); // 有锁定版本就显示锁定版本
    expect(view.note).toContain('官方发布页');
    expect(view.releaseUrl).toBeNull();
  });

  it('不可用：红档徽标', () => {
    const view = describeTool(
      'avifenc',
      statusOf({ key: 'avifenc', source: 'unavailable', hint: 'avifenc 路径无效（文件不存在）' }),
      'ready',
      null,
    );
    expect(view.badgeText).toBe('不可用');
    expect(view.badgeKind).toBe('danger');
    expect(view.note).toContain('文件不存在');
  });

  it('非 https 的发布页不渲染链接（白名单在 model 层过）', () => {
    const view = describeTool('cjpeg', statusOf({ releasePage: 'http://example.com/x' }), 'ready', null);
    expect(view.releaseUrl).toBeNull();
  });

  it('无结果 + 检测中：显示「检测中…」而不是空白', () => {
    const view = describeTool('ffmpeg', undefined, 'loading', null);
    expect(view.badgeText).toBe('检测中…');
    expect(view.effectivePath).toBe('');
  });

  it('无结果 + 超时：给出重试提示（后端探测本身没有超时）', () => {
    const view = describeTool('ffmpeg', undefined, 'timeout', null);
    expect(view.badgeText).toBe('检测超时');
    expect(view.badgeKind).toBe('danger');
    expect(view.note).toContain('重新检测');
  });

  it('无结果 + IPC 失败：显示原因并可重试', () => {
    const view = describeTool('ffmpeg', undefined, 'error', '检测任务执行失败');
    expect(view.badgeText).toBe('检测失败');
    expect(view.note).toContain('检测任务执行失败');
  });

  it('有旧结果 + 本次超时：保留旧徽标，说明这是上一次的结果', () => {
    const view = describeTool('cjpeg', statusOf(), 'timeout', null);
    expect(view.badgeText).toBe('内置');
    expect(view.note).toContain('上一次的结果');
  });

  it('六个工具的行顺序固定，ffmpeg 用专用标签', () => {
    const views = describeTools(null, 'loading', null);
    expect(views.map((view) => view.key)).toEqual([...TOOL_KEYS]);
    expect(toolLabel('ffmpeg')).toBe('FFmpeg');
    expect(toolLabel('cjpeg')).toBe('JPEG（cjpeg）');
  });
});

describe('parseDownloadProgress（后端进度原文 → 比例）', () => {
  it('解析「已下 / 总量 MB」并给出比例', () => {
    const progress = parseDownloadProgress('正在下载 ffmpeg（一次性，约 40 MB）… 12.0 / 40.0 MB');
    expect(progress.ratio).toBeCloseTo(0.3, 5);
    expect(progress.text).toContain('12.0 / 40.0 MB');
  });

  it('总量未知时比例是 null（界面走不确定态，不编百分比）', () => {
    expect(parseDownloadProgress('正在下载 ffmpeg（一次性）… 8.0 MB').ratio).toBeNull();
    expect(parseDownloadProgress('正在校验 ffmpeg 完整性…').ratio).toBeNull();
    expect(parseDownloadProgress('ffmpeg 就绪').ratio).toBeNull();
  });

  it('总量为 0 或文本损坏时不返回 NaN', () => {
    expect(parseDownloadProgress('正在下载 ffmpeg… 0.0 / 0.0 MB').ratio).toBeNull();
    expect(parseDownloadProgress('正在下载 ffmpeg… 1 / x MB').ratio).toBeNull();
  });

  it('原文永远原样带回（界面照显，不改写后端文案）', () => {
    const message = '正在解压 ffmpeg…';
    expect(parseDownloadProgress(message).text).toBe(message);
  });
});

describe('defaultsImpact（恢复默认的影响范围）', () => {
  it('按当前非空路径算出会清掉几条', () => {
    expect(defaultsImpact(settingsWithPaths())).toBe(
      '将清空 2 条编码器路径与 FFmpeg 路径，并恢复默认主题、跑分并发度、文件名冲突策略与默认导出目录。此操作无法撤销。',
    );
  });

  it('没有外部路径时不提「清空 0 条」', () => {
    expect(defaultsImpact(defaultSettings())).toBe(
      '将恢复默认主题、跑分并发度、文件名冲突策略与默认导出目录。此操作无法撤销。',
    );
  });

  it('只有 FFmpeg 路径时只说 FFmpeg', () => {
    const settings = { ...defaultSettings(), ffmpegPath: 'D:/tools/ffmpeg.exe' };
    expect(defaultsImpact(settings)).toContain('将清空 FFmpeg 路径，并');
  });

  it('记录状态本来是关的：说明会被重新打开', () => {
    const settings = { ...defaultSettings(), recordState: false };
    expect(defaultsImpact(settings)).toContain('同时打开「记住上次状态」');
  });

  it('空白路径不算配置（后端保存时会把空白收成 null）', () => {
    const settings = { ...defaultSettings(), ffmpegPath: '   ' };
    expect(defaultsImpact(settings)).not.toContain('清空');
  });
});

describe('licenseShort（许可证列短标识）', () => {
  it('去掉括号补充条款：BSD-3-Clause（另含 IJG、zlib 条款）→ BSD-3-Clause', () => {
    expect(licenseShort('BSD-3-Clause（另含 IJG、zlib 条款）')).toBe('BSD-3-Clause');
  });

  it('已经是短标识的原样返回（GPL / MIT / BSD-2-Clause）', () => {
    expect(licenseShort('GPL')).toBe('GPL');
    expect(licenseShort('MIT')).toBe('MIT');
    expect(licenseShort('BSD-2-Clause')).toBe('BSD-2-Clause');
  });

  it('半角括号同样截断', () => {
    expect(licenseShort('MIT (see LICENSE)')).toBe('MIT');
  });

  it('空串不崩，返回原值', () => {
    expect(licenseShort('')).toBe('');
  });
});

describe('displayPath（Windows 扩展长度路径前缀）', () => {
  // 用 charCode 拼反斜杠：测试文件里不堆转义，读起来也不会数错
  const BS = String.fromCharCode(92);
  const EXT = BS + BS + '?' + BS;

  it('剥掉前缀后与普通路径一致', () => {
    const raw = EXT + 'C:' + BS + 'tools' + BS + 'ffmpeg.exe';
    expect(displayPath(raw)).toBe('C:' + BS + 'tools' + BS + 'ffmpeg.exe');
  });

  it('普通路径（Windows 与 POSIX）原样返回', () => {
    const normal = 'C:' + BS + 'tools' + BS + 'ffmpeg.exe';
    expect(displayPath(normal)).toBe(normal);
    expect(displayPath('/usr/local/bin/cjpeg')).toBe('/usr/local/bin/cjpeg');
  });

  it('恰好只有前缀（长度 4）不误剥，也不越界', () => {
    expect(displayPath(EXT)).toBe(EXT);
  });

  it('双反斜杠但不是前缀形状：不动', () => {
    const other = BS + BS + 'x' + BS + 'C:' + BS + 'a.exe';
    expect(displayPath(other)).toBe(other);
  });
});


describe('diagnosticsText（一键复制的纯文本）', () => {
  it('首行是应用与核心库版本，其余每个工具一行（来源 / 版本 / 生效路径）', () => {
    const tools = new Map<string, ToolStatus>([['cjpeg', statusOf()]]);
    const text = diagnosticsText({
      about: {
        appName: 'Pixel Arena',
        appVersion: '0.1.0',
        coreVersion: '0.1.0',
        intro: '',
        license: 'MIT',
        repoUrl: 'https://github.com/BoxMiao007/pixel-arena',
        libraries: [],
      },
      tools,
      phase: 'ready',
      error: null,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Pixel Arena v0.1.0（核心库 v0.1.0）');
    expect(lines).toHaveLength(1 + 6);
    expect(lines[2]).toContain('cjpeg');
    expect(lines[2]).toContain('内置');
    expect(lines[2]).toContain('v4.1.5');
    expect(lines[2]).toContain('C:/app/encoders/cjpeg.exe');
  });

  it('没有结果的工具写「无生效路径」，不用空字符串占位', () => {
    const text = diagnosticsText({ about: null, tools: null, phase: 'timeout', error: null });
    expect(text.split('\n')[0]).toContain('关于信息未加载');
    expect(text).toContain('无生效路径');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('不含中点分隔符（排版铁律）', () => {
    const text = diagnosticsText({ about: null, tools: null, phase: 'loading', error: null });
    expect(text).not.toContain('·');
  });
});

describe('createToolsWatcher（8 秒软超时 + 晚到结果忽略）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('到点超时：状态切到 timeout，并给出可重试的 phase', async () => {
    vi.useFakeTimers();
    const watcher = createToolsWatcher({ load: () => new Promise<ToolStatus[]>(() => {}), timeoutMs: 8000 });
    watcher.refresh();
    expect(watcher.snapshot().phase).toBe('loading');
    await vi.advanceTimersByTimeAsync(8000);
    expect(watcher.snapshot().phase).toBe('timeout');
    watcher.destroy();
  });

  it('超时之后晚到的结果被丢弃，不会把界面从「检测超时」翻回结果', async () => {
    vi.useFakeTimers();
    let resolveLoad: (list: ToolStatus[]) => void = () => {};
    const watcher = createToolsWatcher({
      load: () => new Promise<ToolStatus[]>((resolve) => {
        resolveLoad = resolve;
      }),
      timeoutMs: 8000,
    });
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(8000);
    expect(watcher.snapshot().phase).toBe('timeout');
    resolveLoad([statusOf()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.snapshot().phase).toBe('timeout');
    expect(watcher.snapshot().statuses).toBeNull();
    watcher.destroy();
  });

  it('正常返回：状态 ready，按 key 建索引，并通知订阅者', async () => {
    let resolveLoad: (list: ToolStatus[]) => void = () => {};
    const watcher = createToolsWatcher({
      load: () => new Promise<ToolStatus[]>((resolve) => {
        resolveLoad = resolve;
      }),
    });
    const seen: string[] = [];
    watcher.subscribe((snapshot) => seen.push(snapshot.phase));
    watcher.refresh();
    resolveLoad([statusOf(), statusOf({ key: 'cwebp' })]);
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = watcher.snapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.statuses?.get('cjpeg')?.effectivePath).toBe('C:/app/encoders/cjpeg.exe');
    expect(snapshot.statuses?.get('cwebp')?.key).toBe('cwebp');
    expect(seen).toContain('loading');
    expect(seen).toContain('ready');
    watcher.destroy();
  });

  it('IPC 失败：保留旧结果并把原因带出来', async () => {
    let attempt = 0;
    const watcher = createToolsWatcher({
      load: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.resolve([statusOf()])
          : Promise.reject(new Error('检测任务执行失败'));
      },
    });
    watcher.refresh();
    await Promise.resolve().then(() => undefined);
    await Promise.resolve();
    expect(watcher.snapshot().phase).toBe('ready');
    watcher.refresh();
    await Promise.resolve().then(() => undefined);
    await Promise.resolve();
    expect(watcher.snapshot().phase).toBe('error');
    expect(watcher.snapshot().error).toContain('检测任务执行失败');
    expect(watcher.snapshot().statuses?.get('cjpeg')?.key).toBe('cjpeg');
    watcher.destroy();
  });

  it('destroy 之后在途结果不再写状态（关设置窗口不残留回调）', async () => {
    let resolveLoad: (list: ToolStatus[]) => void = () => {};
    let notified = 0;
    const watcher = createToolsWatcher({
      load: () => new Promise<ToolStatus[]>((resolve) => {
        resolveLoad = resolve;
      }),
    });
    watcher.subscribe(() => {
      notified += 1;
    });
    watcher.refresh();
    const before = notified;
    watcher.destroy();
    resolveLoad([statusOf()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toBe(before);
    expect(watcher.snapshot().phase).toBe('loading');
  });
});
