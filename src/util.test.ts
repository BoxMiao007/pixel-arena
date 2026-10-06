// 文件名中间截断工具的单测（T18）：只测公共函数的外部行为。
// 期望值为票面验收标准推演的字面量：短名不截、长名中间省略、扩展名保留、
// 悬浮全名由调用方以 title 提供（不属本函数职责）。

import { describe, it, expect } from 'vitest';
import { fileName, truncateFileName, FILE_NAME_MAX } from './util';

describe('fileName（取路径末端文件名，既有工具）', () => {
  it('POSIX 与 Windows 路径都取最后一段', () => {
    expect(fileName('/home/u/pics/photo.jpg')).toBe('photo.jpg');
    expect(fileName('C:\\Users\\u\\photo.jpg')).toBe('photo.jpg');
  });
});

describe('truncateFileName（中间截断 + 保留扩展名）', () => {
  it('短名原样返回，一个字符都不动', () => {
    expect(truncateFileName('a.jpg')).toBe('a.jpg');
    expect(truncateFileName('photo-q75.jpeg')).toBe('photo-q75.jpeg');
    expect(truncateFileName('短名字.png')).toBe('短名字.png');
  });

  it('长度恰好等于上限时不截断（边界）', () => {
    const name = 'a'.repeat(FILE_NAME_MAX) + '.jpg';
    expect(name.length).toBe(FILE_NAME_MAX + 4);
    const fits = 'a'.repeat(FILE_NAME_MAX - 4); // + ".jpg" 恰好 FILE_NAME_MAX
    expect(truncateFileName(fits + '.jpg')).toBe(fits + '.jpg');
  });

  it('长名中间省略：首尾主干保留、中间是省略号、扩展名原样保留', () => {
    const name = 'vacation-photo-2026-final-exported-copy.jpg';
    const out = truncateFileName(name);
    expect(out).not.toBe(name);
    expect(out.length).toBeLessThanOrEqual(FILE_NAME_MAX);
    expect(out).toContain('…');
    // 中间省略：省略号前是文件名开头，省略号后接主干结尾直到扩展名
    expect(out.startsWith('vacation')).toBe(true);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(out.endsWith('copy.jpg')).toBe(true);
  });

  it('无扩展名的长名同样中间截断', () => {
    const name = 'a-very-long-filename-without-any-extension-at-all';
    const out = truncateFileName(name);
    expect(out.length).toBeLessThanOrEqual(FILE_NAME_MAX);
    expect(out).toContain('…');
    expect(out.startsWith('a-very')).toBe(true);
    expect(out.endsWith('at-all')).toBe(true);
  });

  it('截断结果永不超上限，且首段与尾段都非空', () => {
    for (const name of [
      'x'.repeat(200) + '.webp',
      '中'.repeat(120) + '.png',
      'mix-中英-mixed-' + 'y'.repeat(80) + '.avif',
    ]) {
      const out = truncateFileName(name);
      expect(out.length).toBeLessThanOrEqual(FILE_NAME_MAX);
      const [before, after] = out.split('…');
      expect(before.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);
    }
  });

  it('超长扩展名放不下时退化为头部截断（不产生错误内容）', () => {
    const name = 'file.' + 'e'.repeat(60);
    const out = truncateFileName(name, 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.startsWith('file')).toBe(true);
  });

  it('可自定义上限（不同显示位置的宽窄需求）', () => {
    const name = 'abcdef-ghijklmnop-qrs.jpeg';
    expect(truncateFileName(name, 10).length).toBeLessThanOrEqual(10);
    // 上限比名字长：原样返回
    expect(truncateFileName(name, 60)).toBe(name);
  });

  it('隐藏文件（点开头无扩展名）按无扩展名处理', () => {
    const name = '.' + 'a'.repeat(40);
    const out = truncateFileName(name);
    expect(out.length).toBeLessThanOrEqual(FILE_NAME_MAX);
    expect(out.startsWith('.')).toBe(true);
    expect(out).toContain('…');
  });
});
