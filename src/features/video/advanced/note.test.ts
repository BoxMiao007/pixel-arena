// 轮备注纯逻辑单测：配置摘要 / 命令行 / 空内容 / 长内容折叠口径 / 文案边界。

import { describe, expect, it } from 'vitest';
import {
  NOTE_PREVIEW_LINES,
  VIDEO_NOTE_HEADER,
  buildVideoNote,
  noteLayout,
} from './note';
import type {
  AdvancedEntry,
  AdvancedParamRow,
  AdvancedSession,
  AdvancedVideoCatalog,
  VideoSpec,
} from './catalog';

const H264: VideoSpec = {
  id: 'h264',
  displayName: 'H.264（libx264）',
  ffmpegName: 'libx264',
  qualityFlag: '-crf',
  qualityDefault: 23,
  qualityMin: 0,
  qualityMax: 51,
  losslessSupported: false,
  losslessNote: '',
  losslessArgs: [],
  baseArgs: [],
  knownParams: [],
  note: '',
};

const catalog: AdvancedVideoCatalog = {
  ffmpegAvailable: true,
  ffmpegPath: '/usr/bin/ffmpeg',
  ffmpegError: null,
  encoderNames: ['libx264'],
  specs: [H264],
};

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

function session(patch: Partial<AdvancedSession> = {}): AdvancedSession {
  return {
    kind: 'video',
    referencePath: '/v/ref.mp4',
    entries: [entry({ rows: [row()] })],
    ...patch,
  };
}

describe('buildVideoNote（写进 round.note 的配置摘要 + 命令行）', () => {
  it('首行如实说明本版本不做自动编码与后续导入路径', () => {
    const note = buildVideoNote(catalog, session());
    expect(note.startsWith(VIDEO_NOTE_HEADER)).toBe(true);
    expect(note).toContain('本版本不做视频自动编码');
    expect(note).toContain('「添加跑分视频」导入');
    // 旧文案「链路将在后续版本提供」不再出现（能力边界要说现在，不画未来饼）
    expect(note).not.toContain('后续版本提供');
  });

  it('每项一行配置摘要 + 一行命令行', () => {
    expect(buildVideoNote(catalog, session())).toBe(
      [
        VIDEO_NOTE_HEADER,
        '1. H.264（libx264）：-crf 23 -preset slow',
        `   命令行：ffmpeg -y -i /v/ref.mp4 -c:v libx264 -crf 23 -preset slow '<产物>'`,
      ].join('\n'),
    );
  });

  it('多项按顺序编号；表外编码器与未选原视频按宽松口径输出', () => {
    const note = buildVideoNote(catalog, {
      kind: 'video',
      referencePath: null,
      entries: [
        entry({ id: 'a', rows: [row()] }),
        entry({ id: 'b', encoderId: 'my-enc', rows: [row({ flag: '-mode', value: 'fast' })] }),
      ],
    });
    expect(note).toContain('1. H.264（libx264）：-crf 23 -preset slow');
    expect(note).toContain('2. my-enc：-mode fast');
    expect(note).toContain(`2. my-enc：-mode fast\n   命令行：ffmpeg -y -i '<原图>' -c:v my-enc -mode fast '<产物>'`);
  });

  it('没有条目时也给明确文案（防御性：面板校验会先拦下）', () => {
    const note = buildVideoNote(null, { kind: 'video', referencePath: null, entries: [] });
    expect(note).toBe(`${VIDEO_NOTE_HEADER}\n（没有编码器条目）`);
  });
});

describe('noteLayout（默认展示前 6 行，其余折叠）', () => {
  it('空 / 空白备注返回 null（分区不出现）', () => {
    expect(noteLayout(null)).toBeNull();
    expect(noteLayout(undefined)).toBeNull();
    expect(noteLayout('')).toBeNull();
    expect(noteLayout('  \n\t\n')).toBeNull();
  });

  it('不超过 6 行不折叠', () => {
    const layout = noteLayout('一行\n二行\n三行');
    expect(layout).not.toBeNull();
    expect(layout?.folded).toBe(false);
    expect(layout?.head).toEqual(['一行', '二行', '三行']);
    expect(layout?.rest).toEqual([]);
    expect(layout?.totalLines).toBe(3);
  });

  it('恰好 6 行不折叠，第 7 行开始折叠', () => {
    const six = Array.from({ length: NOTE_PREVIEW_LINES }, (_, index) => `第 ${index + 1} 行`);
    const atLimit = noteLayout(six.join('\n'));
    expect(atLimit?.folded).toBe(false);

    const seven = [...six, '第 7 行'];
    const overLimit = noteLayout(seven.join('\n'));
    expect(overLimit?.folded).toBe(true);
    expect(overLimit?.head).toEqual(six);
    expect(overLimit?.rest).toEqual(['第 7 行']);
    expect(overLimit?.totalLines).toBe(7);
    // 复制出来的是完整内容
    expect(overLimit?.full).toBe(seven.join('\n'));
  });

  it('兼容 CRLF、去掉首尾空行、保留行内缩进', () => {
    const layout = noteLayout('\r\n第一行\r\n   命令行：ffmpeg\r\n\r\n');
    expect(layout?.lines).toEqual(['第一行', '   命令行：ffmpeg']);
    expect(layout?.full).toBe('第一行\n   命令行：ffmpeg');
  });

  it('headLines 可调（默认 6）', () => {
    const layout = noteLayout('a\nb\nc', 2);
    expect(layout?.head).toEqual(['a', 'b']);
    expect(layout?.rest).toEqual(['c']);
    expect(layout?.folded).toBe(true);
  });
});
