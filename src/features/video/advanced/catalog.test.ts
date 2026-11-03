// 视频高级创建会话态单测：按组隔离、关面板保留、创建成功丢弃、同一编码器可多次。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEntry,
  clearAdvancedSessions,
  dropSession,
  entryLabel,
  moveEntry,
  newEntryId,
  removeEntry,
  sessionFor,
  videoSpec,
  type AdvancedVideoCatalog,
  type VideoSpec,
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
  encoderNames: ['libx264', 'libx265'],
  specs: [H264],
};

beforeEach(() => {
  clearAdvancedSessions();
});

describe('sessionFor（按跑分组键控的模块内 Map）', () => {
  it('同组返回同一会话，不同组互不串扰', () => {
    const a = sessionFor('g1');
    a.referencePath = '/v/a.mp4';
    addEntry(a, 'libx264', H264);

    expect(sessionFor('g1')).toBe(a);
    expect(sessionFor('g1').entries).toHaveLength(1);
    expect(sessionFor('g2').entries).toHaveLength(0);
    expect(sessionFor('g2').referencePath).toBeNull();
  });

  it('dropSession 丢弃后回到空配置；clearAdvancedSessions 模拟重启归零', () => {
    const session = sessionFor('g1');
    session.referencePath = '/v/a.mp4';
    addEntry(session, 'libx264', H264);

    dropSession('g1');
    expect(sessionFor('g1').entries).toHaveLength(0);
    expect(sessionFor('g1').referencePath).toBeNull();

    addEntry(sessionFor('g1'), 'libx264', H264);
    clearAdvancedSessions();
    expect(sessionFor('g1').entries).toHaveLength(0);
  });
});

describe('条目增删排序', () => {
  it('同一编码器可添加多次，id 各不相同', () => {
    const session = sessionFor('g1');
    const first = addEntry(session, 'libx264', H264);
    const second = addEntry(session, 'libx264', H264);
    expect(session.entries).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    expect(newEntryId()).not.toBe(first.id);
  });

  it('新条目默认质量方式、规格默认质量、200 KB、无参数行', () => {
    const entry = addEntry(sessionFor('g1'), 'libx264', H264);
    expect(entry).toMatchObject({
      kind: 'video',
      encoderId: 'libx264',
      lossless: false,
      mode: 'quality',
      quality: 23,
      targetBytes: 200 * 1024,
      unit: 'KB',
      rows: [],
    });
  });

  it('removeEntry / moveEntry 越界不动', () => {
    const session = sessionFor('g1');
    addEntry(session, 'libx264', H264);
    addEntry(session, 'libx265', H264);

    moveEntry(session, 0, -1);
    moveEntry(session, 1, 1);
    expect(session.entries.map((entry) => entry.encoderId)).toEqual(['libx264', 'libx265']);

    moveEntry(session, 0, 1);
    expect(session.entries.map((entry) => entry.encoderId)).toEqual(['libx265', 'libx264']);

    removeEntry(session, -1);
    removeEntry(session, 9);
    expect(session.entries).toHaveLength(2);
    removeEntry(session, 0);
    expect(session.entries).toHaveLength(1);
  });
});

describe('videoSpec / entryLabel（目录为 null 时退回编码器名）', () => {
  it('命中规格用展示名，表外编码器退回 id', () => {
    expect(videoSpec(catalog, 'libx264')?.id).toBe('h264');
    expect(videoSpec(catalog, 'my-enc')).toBeNull();
    expect(entryLabel(catalog, 'libx264')).toBe('H.264（libx264）');
    expect(entryLabel(catalog, 'my-enc')).toBe('my-enc');
    expect(entryLabel(null, 'libx264')).toBe('libx264');
  });
});
