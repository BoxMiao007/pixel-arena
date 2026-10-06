// 主题解析与设置路径纯函数的单测：期望值来自规格语义的字面推演，不复用实现表达式。

import { describe, it, expect } from 'vitest';
import { resolveTheme } from './theme';
import {
  parentDir,
  exportDefaultPath,
  openDefaultPath,
  nextRecentDir,
  ENCODER_FIELDS,
  type SettingsData,
} from './settings';

describe('resolveTheme（主题三选解析）', () => {
  it('浅色/深色直接生效，与系统深浅无关', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('跟随系统：系统深色得到深色，系统浅色得到浅色', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('parentDir（取父目录，记录最近目录用）', () => {
  it('POSIX 路径取 / 前的部分', () => {
    expect(parentDir('/home/user/图片/a.png')).toBe('/home/user/图片');
  });

  it('Windows 路径取 \\ 前的部分', () => {
    expect(parentDir('C:\\Users\\u\\a.png')).toBe('C:\\Users\\u');
  });

  it('根路径与裸文件名返回 null', () => {
    expect(parentDir('/a.png')).toBeNull();
    expect(parentDir('a.png')).toBeNull();
  });
});

describe('exportDefaultPath（默认导出目录）', () => {
  it('设置过目录：定位到 <目录>/<文件名>，容忍目录尾部多余分隔符', () => {
    expect(exportDefaultPath('/home/user/导出', '评测轮 1.csv')).toBe('/home/user/导出/评测轮 1.csv');
    expect(exportDefaultPath('/home/user/导出/', 'r.html')).toBe('/home/user/导出/r.html');
    expect(exportDefaultPath('C:\\导出\\', 'r.csv')).toBe('C:\\导出/r.csv');
  });

  it('未设置：返回纯文件名（对话框回落系统默认位置）', () => {
    expect(exportDefaultPath(null, 'r.csv')).toBe('r.csv');
    expect(exportDefaultPath('   ', 'r.csv')).toBe('r.csv');
    expect(exportDefaultPath(undefined, 'r.csv')).toBe('r.csv');
  });
});

describe('openDefaultPath（最近目录恢复门控）', () => {
  const settings = (recordState: boolean, recentDir: string | null) => ({
    recordState,
    recentDir,
  });

  it('记录状态开：返回最近目录', () => {
    expect(openDefaultPath(settings(true, '/home/user/图片'))).toBe('/home/user/图片');
  });

  it('记录状态关：不恢复（undefined = 系统默认位置），即使记过目录', () => {
    expect(openDefaultPath(settings(false, '/home/user/图片'))).toBeUndefined();
  });

  it('记录状态开但从未选过文件：undefined', () => {
    expect(openDefaultPath(settings(true, null))).toBeUndefined();
  });
});

describe('nextRecentDir（选文件后的最近目录记录，US27/审查修复 B7）', () => {
  const base: SettingsData = {
    formatVersion: 1,
    recordState: true,
    theme: 'dark',
    scoreConcurrency: 'half',
    defaultExportDir: null,
    recentDir: '/old',
    window: null,
    encoderOverrides: {
      cjpeg: null,
      cwebp: null,
      avifenc: null,
      cjxl: null,
      avifdec: null,
    },
  };

  it('记录状态开：recentDir 更新为所选文件的父目录', () => {
    const next = nextRecentDir(base, '/home/user/图片/a.png');
    expect(next?.recentDir).toBe('/home/user/图片');
    // 其余设置项原样保留
    expect(next?.recordState).toBe(true);
    expect(next?.theme).toBe('dark');
  });

  it('记录状态关：不写最近目录（恢复与写入同一道门控），即使本次选了文件', () => {
    expect(nextRecentDir({ ...base, recordState: false }, '/home/user/图片/a.png')).toBeNull();
  });

  it('路径没有父目录（根路径/裸文件名）：不记录', () => {
    expect(nextRecentDir(base, '/a.png')).toBeNull();
  });
});

describe('ENCODER_FIELDS（设置面板编码器清单）', () => {
  it('覆盖四个编码器与 avifdec，键与设置文件一一对应', () => {
    expect(ENCODER_FIELDS.map((f) => f.key)).toEqual([
      'cjpeg',
      'cwebp',
      'avifenc',
      'cjxl',
      'avifdec',
    ]);
  });
});
