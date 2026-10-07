// 高级创建（T29-3）纯函数与会话态的单测：参数合并/冲突（决策 D10/D11）、会话态
// 生命周期（决策 D19：仅会话态、重启归零）、命令行预览的 shell 引用。期望值来自
// 决策文本的字面推演与核心库同名实现的钉死行为，不复制实现表达式。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessionFor,
  dropSession,
  clearAdvancedSessions,
  addEntry,
  removeEntry,
  moveEntry,
  mergeArgs,
  quickBaseArgs,
  buildEntryArgs,
  buildEntryArgsLenient,
  validateEntry,
  shellQuote,
  formatCommandLine,
  previewImageCommand,
  previewVideoCommand,
  type AdvancedEntry,
  type AdvancedParamRow,
  type AdvancedSession,
  type ImageSpec,
  type VideoSpec,
} from './advanced';

function row(partial: Partial<AdvancedParamRow>): AdvancedParamRow {
  return {
    name: '',
    flag: '',
    value: '',
    note: '',
    kind: 'text',
    options: [],
    enabled: true,
    ...partial,
  };
}

// 与后端 image_specs() 关键值一致的精简规格（仅取测试关心的字段）
const jpegSpec: ImageSpec = {
  id: 'jpeg',
  displayName: 'JPEG（MozJPEG）',
  toolKey: 'cjpeg',
  baseArgs: [],
  losslessSupported: false,
  losslessNote: 'JPEG 编码器（MozJPEG）不支持无损，无损开关不可用',
  losslessArgs: [],
  qualityFlag: '-quality',
  qualityDefault: 75,
  qualityMin: 1,
  qualityMax: 100,
  qualityStep: 1,
  inputPng: false,
  outputExt: 'jpg',
  knownParams: [],
};

const webpSpec: ImageSpec = {
  ...jpegSpec,
  id: 'webp',
  displayName: 'WebP（libwebp）',
  toolKey: 'cwebp',
  baseArgs: ['-quiet'],
  losslessSupported: true,
  losslessNote: '',
  losslessArgs: ['-lossless'],
  qualityFlag: '-q',
  outputExt: 'webp',
};

const jxlSpec: ImageSpec = {
  ...jpegSpec,
  id: 'jxl',
  displayName: 'JPEG XL（libjxl）',
  toolKey: 'cjxl',
  baseArgs: ['--quiet'],
  losslessSupported: true,
  losslessArgs: ['-q', '100'],
  qualityMax: 95,
  outputExt: 'jxl',
};

const h264Spec: VideoSpec = {
  id: 'h264',
  displayName: 'H.264（libx264）',
  ffmpegName: 'libx264',
  baseArgs: [],
  losslessSupported: true,
  losslessNote: '',
  losslessArgs: ['-crf', '0'],
  qualityFlag: '-crf',
  qualityDefault: 23,
  qualityMin: 0,
  qualityMax: 51,
  knownParams: [],
  note: '',
};

function entry(partial: Partial<AdvancedEntry>): AdvancedEntry {
  return {
    id: 'e1',
    kind: 'image',
    encoderId: 'jpeg',
    lossless: false,
    mode: 'quality',
    quality: 75,
    targetBytes: 200 * 1024,
    unit: 'KB',
    rows: [],
    ...partial,
  };
}

beforeEach(() => {
  clearAdvancedSessions();
});

// ---------- 会话态（决策 D19：仅会话态；切标签保留、重启归零） ----------

describe('高级创建会话态', () => {
  it('首次取会话得到空配置（无条目、无原图），不触碰任何持久化通道', () => {
    const session = sessionFor('g1', 'image');
    expect(session.kind).toBe('image');
    expect(session.referencePath).toBeNull();
    expect(session.entries).toEqual([]);
  });

  it('同一跑分组的会话跨多次取用共享（切标签保留）；不同跑分组互不串扰', () => {
    const a1 = sessionFor('g1', 'image');
    addEntry(a1, 'jpeg', jpegSpec);
    const a2 = sessionFor('g1', 'image');
    expect(a2.entries).toHaveLength(1);
    expect(a2).toBe(a1);

    const b = sessionFor('g2', 'image');
    expect(b.entries).toHaveLength(0);
    expect(b.entries).not.toBe(a1.entries);
  });

  it('addEntry 支持同一编码器添加多次（票面验收 1）', () => {
    const session = sessionFor('g1', 'image');
    addEntry(session, 'avif', jpegSpec);
    addEntry(session, 'avif', jpegSpec);
    addEntry(session, 'webp', jpegSpec);
    expect(session.entries.map((e) => e.encoderId)).toEqual(['avif', 'avif', 'webp']);
    // 两次添加得到两个独立条目（各自参数互不影响）
    expect(session.entries[0].id).not.toBe(session.entries[1].id);
  });

  it('removeEntry 删除指定位置，越界不动', () => {
    const session: AdvancedSession = sessionFor('g1', 'image');
    addEntry(session, 'jpeg', jpegSpec);
    addEntry(session, 'webp', jpegSpec);
    removeEntry(session, 0);
    expect(session.entries.map((e) => e.encoderId)).toEqual(['webp']);
    removeEntry(session, 5);
    expect(session.entries).toHaveLength(1);
  });

  it('moveEntry 上移下移排序，边界不动（票面验收 3）', () => {
    const session = sessionFor('g1', 'image');
    addEntry(session, 'jpeg', jpegSpec);
    addEntry(session, 'webp', jpegSpec);
    addEntry(session, 'avif', jpegSpec);
    moveEntry(session, 2, -1); // avif 上移到中间
    expect(session.entries.map((e) => e.encoderId)).toEqual(['jpeg', 'avif', 'webp']);
    moveEntry(session, 0, -1); // 已在顶部，不动
    expect(session.entries.map((e) => e.encoderId)).toEqual(['jpeg', 'avif', 'webp']);
    moveEntry(session, 2, 1); // 已在底部，不动
    expect(session.entries.map((e) => e.encoderId)).toEqual(['jpeg', 'avif', 'webp']);
    moveEntry(session, 0, 1);
    expect(session.entries.map((e) => e.encoderId)).toEqual(['avif', 'jpeg', 'webp']);
  });

  it('dropSession 丢弃后回到空配置；clearAdvancedSessions 模拟重启归零', () => {
    const session = sessionFor('g1', 'image');
    addEntry(session, 'jpeg', jpegSpec);
    session.referencePath = '/tmp/a.png';
    dropSession('g1');
    expect(sessionFor('g1', 'image').entries).toHaveLength(0);
    expect(sessionFor('g1', 'image').referencePath).toBeNull();
  });
});

// ---------- 参数合并（决策 D10/D11：追加 + 仅同标志判冲突） ----------

describe('mergeArgs（高级参数追加与同标志冲突）', () => {
  it('高级参数按行序追加到基础参数末尾（决策 D10）', () => {
    const merged = mergeArgs(['-quiet', '-q', '75'], [
      row({ name: '线程数', flag: '-j', value: '4' }),
      row({ name: '渐进式', flag: '-progressive' }),
    ]);
    expect(merged).toEqual(['-quiet', '-q', '75', '-j', '4', '-progressive']);
  });

  it('同标志冲突（基础 ↔ 高级）抛中文错误并点名标志（票面验收 5）', () => {
    expect(() =>
      mergeArgs(['-q', '75'], [row({ name: '自定义质量', flag: '-q', value: '60' })]),
    ).toThrow(/-q/);
  });

  it('同标志冲突（高级行之间）同样报错', () => {
    expect(() =>
      mergeArgs([], [
        row({ name: '速度', flag: '-s', value: '4' }),
        row({ name: '再写一次速度', flag: '-s' }),
      ]),
    ).toThrow(/-s/);
  });

  it('不同写法的同义参数不判冲突，靠命令行预览自查（决策 D11）', () => {
    const merged = mergeArgs(['-quality', '75'], [row({ name: '质量别名', flag: '-q', value: '60' })]);
    expect(merged).toEqual(['-quality', '75', '-q', '60']);
  });

  it('未启用的行整体跳过（不追加、不冲突）', () => {
    const merged = mergeArgs(['-q', '75'], [
      row({ name: '未启用', flag: '-q', value: '60', enabled: false }),
      row({ name: '锐化', flag: '--sharpyuv', enabled: true }),
    ]);
    expect(merged).toEqual(['-q', '75', '--sharpyuv']);
  });

  it('布尔行（值为空）只追加标志；负数取值不算标志', () => {
    const merged = mergeArgs(['-t', '-1'], [row({ name: '锐化', flag: '-af' })]);
    expect(merged).toEqual(['-t', '-1', '-af']);
  });

  it('缺参数名 / 标志不以 - 开头：中文报错', () => {
    expect(() => mergeArgs([], [row({ name: '', flag: '-af' })])).toThrow(/参数名/);
    expect(() => mergeArgs([], [row({ name: '坏行', flag: 'sharpyuv' })])).toThrow(/sharpyuv/);
  });
});

// ---------- 快速参数 → 基础命令行（核心库 quick_base_args 镜像） ----------

describe('quickBaseArgs（快速参数映射，决策 D10）', () => {
  it('质量模式用编码器各自的质量标志', () => {
    expect(quickBaseArgs(jpegSpec, false, 75)).toEqual(['-quality', '75']);
    expect(quickBaseArgs(webpSpec, false, 75)).toEqual(['-quiet', '-q', '75']);
  });

  it('无损模式按能力追加无损参数（jxl = q100）', () => {
    expect(quickBaseArgs(webpSpec, true, 75)).toEqual(['-quiet', '-lossless']);
    expect(quickBaseArgs(jxlSpec, true, 75)).toEqual(['--quiet', '-q', '100']);
  });

  it('不支持无损的编码器打开无损开关：报错（开关应被禁用，这里是兜底）', () => {
    expect(() => quickBaseArgs(jpegSpec, true, 75)).toThrow(/无损/);
  });

  it('质量越界报错（jxl 有损上限 95）', () => {
    expect(() => quickBaseArgs(jxlSpec, false, 96)).toThrow(/质量/);
  });
});

// ---------- 校验（票面验收 5：收集全部错误一次报出） ----------

describe('validateEntry（必填缺失/范围/冲突的汇总报错）', () => {
  it('合法条目无错误', () => {
    const errors = validateEntry(jpegSpec, entry({ quality: 75 }));
    expect(errors).toEqual([]);
  });

  it('质量越界与目标大小非法同时收集', () => {
    const errors = validateEntry(jpegSpec, entry({ quality: 0, mode: 'size', targetBytes: 0 }));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/质量/);
    expect(errors[1]).toMatch(/目标大小/);
  });

  it('参数行缺参数名报中文错误', () => {
    const errors = validateEntry(jpegSpec, entry({ rows: [row({ name: '', flag: '-af' })] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/参数名/);
  });

  it('同标志冲突报中文错误', () => {
    const errors = validateEntry(
      jpegSpec,
      entry({ rows: [row({ name: '质量', flag: '-quality', value: '50' })] }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/-quality/);
  });
});

// ---------- 命令行预览（shell 引用；与核心库 layout_words 同布局） ----------

describe('命令行预览（可复制、可直接在 shell 执行）', () => {
  it('shellQuote：稳妥字符不加引号，空格与单引号按 POSIX 引用', () => {
    expect(shellQuote('-q')).toBe('-q');
    expect(shellQuote('my photo')).toBe(`'my photo'`);
    expect(shellQuote(`it's fine`)).toBe(`'it'\\''s fine'`);
  });

  it('formatCommandLine 逐词引用后拼一行', () => {
    expect(formatCommandLine('cjpeg', ['-quality', '75', 'my photo.png'])).toBe(
      `cjpeg -quality 75 'my photo.png'`,
    );
  });

  it('图片预览：cjpeg 用 -outfile 收尾（输入在最后）', () => {
    const line = previewImageCommand(jpegSpec, entry({ rows: [row({ name: '渐进式', flag: '-progressive' })] }), '/ref.png');
    expect(line).toBe(`cjpeg -quality 75 -progressive -outfile '<产物>' /ref.png`);
  });

  it('图片预览：cwebp 输入后跟 -o；未选原图用占位', () => {
    const line = previewImageCommand(webpSpec, entry({ encoderId: 'webp', quality: 80 }), null);
    expect(line).toBe(`cwebp -quiet -q 80 '<原图>' -o '<产物>'`);
  });

  it('视频预览：ffmpeg -y -i 输入 -c:v 编码器 参数 产物', () => {
    const line = previewVideoCommand(
      h264Spec,
      entry({
        kind: 'video',
        encoderId: 'libx264',
        quality: 23,
        rows: [row({ name: '速度档', flag: '-preset', value: 'slow' })],
      }),
      '/v/原.mp4',
    );
    expect(line).toBe(`ffmpeg -y -i '/v/原.mp4' -c:v libx264 -crf 23 -preset slow '<产物>'`);
  });

  it('视频预览：表外编码器（无规格）只拼参数行，编码器名取条目自身', () => {
    const line = previewVideoCommand(
      null,
      entry({ kind: 'video', encoderId: 'my-obscure-enc', rows: [row({ name: '模式', flag: '-mode', value: 'fast' })] }),
      null,
    );
    expect(line).toBe(`ffmpeg -y -i '<原图>' -c:v my-obscure-enc -mode fast '<产物>'`);
  });
});

// ---------- 端到端形状：buildEntryArgs = 快速 + 高级（后端合并前的前端估算） ----------

describe('buildEntryArgs（快速与高级参数合并）', () => {
  it('快速参数在前、高级参数追加在后（决策 D10 的完整口径）', () => {
    const args = buildEntryArgs(webpSpec, entry({
      encoderId: 'webp',
      quality: 80,
      rows: [row({ name: '锐化', flag: '-sharp-yuv' })],
    }));
    expect(args).toEqual(['-quiet', '-q', '80', '-sharp-yuv']);
  });
});

// ---------- 宽松预览合并（正在输入的参数行不打断面板渲染） ----------

describe('buildEntryArgsLenient（预览宽松合并）', () => {
  it('没填完/非法的参数行跳过，不抛错（面板可边输入边刷新预览）', () => {
    const args = buildEntryArgsLenient(webpSpec, entry({
      encoderId: 'webp',
      quality: 80,
      rows: [
        row({ name: '', flag: '' }), // 刚添加的自定义行：名与标志都还没填
        row({ name: '锐化', flag: '-sharp-yuv' }),
      ],
    }));
    expect(args).toEqual(['-quiet', '-q', '80', '-sharp-yuv']);
  });

  it('同标志冲突不抛错（预览照常显示，错误由创建时权威报出）', () => {
    const args = buildEntryArgsLenient(jpegSpec, entry({
      rows: [row({ name: '自定义质量', flag: '-quality', value: '50' })],
    }));
    expect(args).toEqual(['-quality', '75', '-quality', '50']);
  });

  it('未启用的行跳过；质量越界时预览退到基础参数', () => {
    const args = buildEntryArgsLenient(webpSpec, entry({
      encoderId: 'webp',
      quality: 999, // 越界：快速参数报错，预览退到 baseArgs
      rows: [row({ name: '锐化', flag: '-sharp-yuv', enabled: false })],
    }));
    expect(args).toEqual(['-quiet']);
  });

  it('图片预览带未填完的自定义行不抛错（回归：曾把整面板渲染打断）', () => {
    const line = previewImageCommand(jpegSpec, entry({ rows: [row({ name: '', flag: '' })] }), null);
    expect(line).toBe(`cjpeg -quality 75 -outfile '<产物>' '<原图>'`);
  });
});
