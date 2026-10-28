import { describe, expect, it } from 'vitest';
import { exportBaseName, exportFileName, sanitizeFileName } from './filename';
import { extensionOf, formatLabelForPath } from './format-label';

describe('格式显示名（与核心库 bdrate::format_label 同口径）', () => {
  it('已知扩展名', () => {
    expect(formatLabelForPath('/r/photo.jpg')).toBe('JPEG');
    expect(formatLabelForPath('/r/photo.jpeg')).toBe('JPEG');
    expect(formatLabelForPath('C:\\r\\photo.webp')).toBe('WebP');
    expect(formatLabelForPath('/r/photo.avif')).toBe('AVIF');
    expect(formatLabelForPath('/r/photo.jxl')).toBe('JPEG XL');
    expect(formatLabelForPath('/r/photo.png')).toBe('PNG');
  });

  it('大小写不敏感', () => {
    expect(formatLabelForPath('/r/PHOTO.JPG')).toBe('JPEG');
    expect(formatLabelForPath('/r/photo.JpEg')).toBe('JPEG');
  });

  it('未知扩展名按 ASCII 大写，无扩展名给「未知格式」', () => {
    expect(formatLabelForPath('/r/photo.heic')).toBe('HEIC');
    expect(formatLabelForPath('/r/README')).toBe('未知格式');
    expect(formatLabelForPath('/r/.hidden')).toBe('未知格式');
  });

  it('扩展名解析：最后一个点之后，点结尾视为无扩展名', () => {
    expect(extensionOf('/r/a.b.c.jpg')).toBe('jpg');
    expect(extensionOf('/r/photo.')).toBe('');
    expect(extensionOf('/r/.bashrc')).toBe('');
  });
});

describe('导出文件名', () => {
  it('优先原图文件名主干', () => {
    expect(exportBaseName({ referencePath: '/r/photo.png', name: '评测轮 2' })).toBe('photo');
    expect(exportFileName({ referencePath: '/r/photo.png', name: '评测轮 2' }, 'csv')).toBe(
      'photo.csv',
    );
  });

  it('没有原图时回落轮名，非法字符换下划线', () => {
    expect(exportBaseName({ referencePath: null, name: '人像/测试: 2' })).toBe('人像_测试_ 2');
  });

  it('轮名清洗后为空时回落「评测轮」', () => {
    expect(sanitizeFileName('   ')).toBe('评测轮');
    expect(sanitizeFileName('///')).toBe('___');
    expect(exportBaseName({ referencePath: null, name: '' })).toBe('评测轮');
  });

  it('Windows 保留名加下划线，结尾点与空格去掉', () => {
    expect(sanitizeFileName('CON')).toBe('CON_');
    expect(sanitizeFileName('nul.csv')).toBe('nul.csv_');
    expect(sanitizeFileName('名字...  ')).toBe('名字');
    expect(sanitizeFileName('a<b>c|d')).toBe('a_b_c_d');
  });

  it('原图文件以点开头时整名当主干（点开头不算扩展名）', () => {
    expect(exportBaseName({ referencePath: '/r/.hidden', name: '轮 1' })).toBe('.hidden');
  });

  it('html 扩展名', () => {
    expect(exportFileName({ referencePath: '/r/photo.jpg', name: 'r' }, 'html')).toBe('photo.html');
  });
});
