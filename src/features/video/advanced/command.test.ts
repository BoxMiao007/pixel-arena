// 视频高级创建命令行纯逻辑单测：参数合并 / 冲突校验 / 预览 / 可用性。
//
// 这些行为与核心库 advanced.rs 的 merge_args / quick_base_args 一一镜像；改实现
// 前先看这里的期望值（尤其是输出顺序与中文错误文案），避免两边悄悄漂移。

import { describe, expect, it } from 'vitest';
import {
  availabilityErrors,
  buildEntryArgs,
  buildEntryArgsLenient,
  formatCommandLine,
  mergeArgs,
  previewVideoCommand,
  quickBaseArgs,
  shellQuote,
  validateEntry,
} from './command';
import type { AdvancedEntry, AdvancedParamRow, ToolStatusLite, VideoSpec } from './catalog';

const H264: VideoSpec = {
  id: 'h264',
  displayName: 'H.264（libx264）',
  ffmpegName: 'libx264',
  qualityFlag: '-crf',
  qualityDefault: 23,
  qualityMin: 0,
  qualityMax: 51,
  losslessSupported: false,
  losslessNote: 'H.264 不支持无损',
  losslessArgs: [],
  baseArgs: [],
  knownParams: [],
  note: '',
};

const VP9: VideoSpec = {
  id: 'vp9',
  displayName: 'VP9（libvpx-vp9）',
  ffmpegName: 'libvpx-vp9',
  qualityFlag: '-crf',
  qualityDefault: 31,
  qualityMin: 0,
  qualityMax: 63,
  losslessSupported: true,
  losslessNote: '无损 = -lossless 1',
  losslessArgs: ['-lossless', '1'],
  baseArgs: ['-b:v', '0'],
  knownParams: [],
  note: '',
};

function entry(patch: Partial<AdvancedEntry> = {}): AdvancedEntry {
  return {
    id: 'adv-1',
    kind: 'video',
    encoderId: 'libx264',
    lossless: false,
    mode: 'quality',
    quality: 23,
    targetBytes: 200 * 1024,
    unit: 'KB',
    rows: [],
    ...patch,
  };
}

function row(patch: Partial<AdvancedParamRow> = {}): AdvancedParamRow {
  return {
    name: '预设',
    flag: '-preset',
    value: 'slow',
    note: '',
    kind: 'text',
    options: [],
    enabled: true,
    ...patch,
  };
}

function status(
  key: string,
  source: ToolStatusLite['source'],
  hint: string | null = null,
): ToolStatusLite {
  return { key, source, hint };
}

describe('shellQuote / formatCommandLine（复制出来可直接执行）', () => {
  it('稳妥字符不加引号，空格与单引号按 POSIX 引用', () => {
    expect(shellQuote('-q')).toBe('-q');
    expect(shellQuote('my photo')).toBe(`'my photo'`);
    expect(shellQuote(`it's fine`)).toBe(`'it'\\''s fine'`);
  });

  it('逐词引用后拼一行', () => {
    expect(formatCommandLine('ffmpeg', ['-y', 'my video.mp4'])).toBe(
      `ffmpeg -y 'my video.mp4'`,
    );
  });
});

describe('mergeArgs（快速参数 + 高级参数，仅同标志判冲突）', () => {
  it('高级参数按行序追加到末尾；布尔行只追加标志', () => {
    expect(
      mergeArgs(['-crf', '23'], [
        row({ flag: '-preset', value: 'slow' }),
        row({ name: '快速启动', flag: '-tune', value: '' }),
      ]),
    ).toEqual(['-crf', '23', '-preset', 'slow', '-tune']);
  });

  it('未启用的行整体跳过（不追加也不判冲突）', () => {
    expect(mergeArgs(['-crf', '23'], [row({ flag: '-crf', value: '30', enabled: false })])).toEqual([
      '-crf',
      '23',
    ]);
  });

  it('同标志与基础参数冲突时抛中文错误并点名标志', () => {
    expect(() => mergeArgs(['-crf', '23'], [row({ flag: '-crf', value: '30' })])).toThrow(
      /参数标志冲突：-crf 重复出现/,
    );
  });

  it('缺少参数名或标志非法时报错', () => {
    expect(() => mergeArgs([], [row({ name: '', flag: '-x' })])).toThrow(
      '高级参数行缺少参数名，请填写后重试',
    );
    expect(() => mergeArgs([], [row({ name: '线程', flag: 'threads' })])).toThrow(
      /标志「threads」无效：标志必须以 - 开头/,
    );
  });
});

describe('quickBaseArgs / buildEntryArgs', () => {
  it('质量模式追加 qualityFlag + 质量值（四舍五入）', () => {
    expect(quickBaseArgs(H264, false, 22.6)).toEqual(['-crf', '23']);
  });

  it('无损模式追加 losslessArgs；不支持时抛中文错误', () => {
    expect(quickBaseArgs(VP9, true, 31)).toEqual(['-b:v', '0', '-lossless', '1']);
    expect(() => quickBaseArgs(H264, true, 23)).toThrow('H.264（libx264）：H.264 不支持无损');
  });

  it('质量越界报出有效范围', () => {
    expect(() => quickBaseArgs(H264, false, 60)).toThrow('有效范围 0–51');
  });

  it('buildEntryArgs = 基础参数 + 高级参数（顺序固定）', () => {
    expect(
      buildEntryArgs(H264, entry({ rows: [row({ flag: '-preset', value: 'slow' })] })),
    ).toEqual(['-crf', '23', '-preset', 'slow']);
  });
});

describe('previewVideoCommand（ffmpeg -y -i 输入 -c:v 编码器 参数 产物）', () => {
  it('有规格时拼快速参数与高级参数，输入路径按 shell 引用', () => {
    expect(
      previewVideoCommand(
        H264,
        entry({ rows: [row({ flag: '-preset', value: 'slow' })] }),
        '/v/原.mp4',
      ),
    ).toBe(`ffmpeg -y -i '/v/原.mp4' -c:v libx264 -crf 23 -preset slow '<产物>'`);
  });

  it('未选原视频时用占位符', () => {
    expect(previewVideoCommand(H264, entry(), null)).toBe(
      `ffmpeg -y -i '<原图>' -c:v libx264 -crf 23 '<产物>'`,
    );
  });

  it('表外编码器（无规格）只拼参数行，编码器名取条目自身', () => {
    expect(
      previewVideoCommand(
        null,
        entry({ encoderId: 'my-obscure-enc', rows: [row({ flag: '-mode', value: 'fast' })] }),
        null,
      ),
    ).toBe(`ffmpeg -y -i '<原图>' -c:v my-obscure-enc -mode fast '<产物>'`);
  });

  it('半填 / 非法参数行跳过，不打断预览', () => {
    expect(
      previewVideoCommand(
        H264,
        entry({ rows: [row({ name: '', flag: '', value: '' }), row({ flag: '-preset', value: 'slow' })] }),
        '/v/原.mp4',
      ),
    ).toBe(`ffmpeg -y -i '/v/原.mp4' -c:v libx264 -crf 23 -preset slow '<产物>'`);
  });
});

describe('validateEntry（汇总报错，不抛错）', () => {
  it('通过时返回空数组', () => {
    expect(validateEntry(H264, entry())).toEqual([]);
  });

  it('同时收集质量越界、目标大小非法与非法标志', () => {
    const errors = validateEntry(
      H264,
      entry({
        quality: 60,
        mode: 'size',
        targetBytes: 0,
        rows: [row({ name: '线程', flag: 'bad' })],
      }),
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('质量 60 无效');
    expect(errors[1]).toContain('目标大小无效');
    expect(errors[2]).toContain('标志「bad」无效');
  });

  it('基础参数与高级行同标志时也汇总冲突', () => {
    const errors = validateEntry(H264, entry({ rows: [row({ flag: '-crf', value: '30' })] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('参数标志冲突');
  });

  it('表外编码器（spec=null）只校验参数行', () => {
    expect(validateEntry(null, entry({ encoderId: 'x-enc', rows: [row({ flag: 'bad' })] }))).toHaveLength(
      1,
    );
  });
});

describe('availabilityErrors（建轮前批量校验）', () => {
  const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
  const allFfmpeg = (): string => 'ffmpeg';

  it('ffmpeg 可用时无错误', () => {
    expect(availabilityErrors(entries, allFfmpeg, [status('ffmpeg', 'builtin')])).toEqual(new Map());
  });

  it('unavailable 明确报错并指向设置页', () => {
    const errors = availabilityErrors([entry({ id: 'a' })], allFfmpeg, [
      status('ffmpeg', 'unavailable', '外部路径失效'),
    ]);
    expect(errors.get('a')).toContain('编码器 ffmpeg 不可用：外部路径失效');
    expect(errors.get('a')).toContain('「设置」');
  });

  it('ffmpeg 的 unconfigured 放行（就位方式是设置页应用内下载）', () => {
    expect(
      availabilityErrors([entry({ id: 'a' })], allFfmpeg, [status('ffmpeg', 'unconfigured')]),
    ).toEqual(new Map());
  });

  it('非 ffmpeg 工具的 unconfigured 报错（内置文件缺失）', () => {
    const errors = availabilityErrors([entry({ id: 'a' })], () => 'cjpeg', [
      status('cjpeg', 'unconfigured', '内置文件缺失'),
    ]);
    expect(errors.get('a')).toContain('编码器 cjpeg 未就绪：内置文件缺失');
  });

  it('后端没返回状态时报检测失败；工具键为 null 的条目跳过', () => {
    const errors = availabilityErrors([entry({ id: 'a' })], allFfmpeg, []);
    expect(errors.get('a')).toContain('可用性检测失败');
    expect(availabilityErrors([entry({ id: 'a' })], () => null, [])).toEqual(new Map());
  });
});

describe('buildEntryArgsLenient（预览用宽松合并）', () => {
  it('质量非法时退回基础参数，参数行照常追加', () => {
    expect(
      buildEntryArgsLenient(VP9, entry({ encoderId: 'libvpx-vp9', quality: 999, rows: [row()] })),
    ).toEqual(['-b:v', '0', '-preset', 'slow']);
  });
});
