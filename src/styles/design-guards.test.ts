// 设计体系回归守卫（源码文本扫描，不依赖 DOM 与 Node 类型）。
//
// 这些规则来自 .agents/skills/desktop-agent-ui 与 web-design-guidelines 的硬约束，
// 也是本次重构最容易在后续改动里被破坏的地方：中点分隔符、粗边框、字号失控、
// 内联 HTML 拼接、字面色值与裸 invoke。旧文件（src/*.ts 根目录）不参与扫描——它们会被删除。
//
// 用 Vite 的 import.meta.glob 读原文，避免给测试引入 @types/node 依赖。

import { describe, it, expect } from 'vitest';

interface SourceText {
  path: string;
  text: string;
}

const RAW_BY_DIR: [string, Record<string, string>][] = [
  ['core', import.meta.glob('../core/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
  ['ui', import.meta.glob('../ui/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
  ['shell', import.meta.glob('../shell/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
  ['features', import.meta.glob('../features/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
  ['styles', import.meta.glob('../styles/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
  ['styles', import.meta.glob('../styles/**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>],
];

/** 只扫新架构目录；键名由目录前缀 + 文件基名拼回（core/store.ts、styles/tokens.css）。 */
const FILES: SourceText[] = [];
for (const [dir, modules] of RAW_BY_DIR) {
  for (const [key, text] of Object.entries(modules)) {
    if (key.endsWith('.test.ts')) continue;
    const normalized = key.replace(/\\/g, '/');
    const marker = `../${dir}/`;
    const relative = normalized.startsWith(marker)
      ? normalized.slice(marker.length)
      : (normalized.split('/').pop() ?? normalized);
    FILES.push({ path: `${dir}/${relative}`, text });
  }
}

const TS_FILES = FILES.filter((file) => file.path.endsWith('.ts'));
const CSS_FILES = FILES.filter((file) => file.path.endsWith('.css'));
const NON_TOKEN_CSS = CSS_FILES.filter((file) => file.path !== 'styles/tokens.css');

function offenders(predicate: (text: string, path: string) => boolean): string[] {
  return FILES.filter((file) => predicate(file.text, file.path)).map((file) => file.path);
}

describe('设计守卫：扫描范围', () => {
  it('能读到新架构的源码（防止 glob 失效导致恒真）', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(TS_FILES.some((file) => file.path === 'core/store.ts')).toBe(true);
    expect(CSS_FILES.some((file) => file.path === 'styles/tokens.css')).toBe(true);
  });
});

describe('设计守卫：文案与排版', () => {
  it('不使用中点「·」作为分隔符（改用留白、冒号或独立元素）', () => {
    const bad = offenders((text) => text.includes('·'));
    expect(bad).toEqual([]);
  });

  it('字号只走令牌，不写字面 px（三档：12 / 13 / 15）', () => {
    const bad: string[] = [];
    for (const file of CSS_FILES) {
      for (const match of file.text.matchAll(/font-size:\s*([^;]+);/g)) {
        const value = match[1].trim();
        const allowed =
          value.startsWith('var(--fs-') || value === 'inherit' || value === '1em' || value === '100%';
        if (!allowed) bad.push(`${file.path}: ${value}`);
      }
      // 显式小于 12px 的字号同样违规
      if (/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/.test(file.text)) {
        bad.push(`${file.path}: 出现小于 12px 的字号`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('边框统一 0.5px 发丝线，不出现 1px 实线或左边缘彩条', () => {
    const solid = /border(?:-(?:top|right|bottom|left))?:\s*(?:1px|2px|3px|4px)\s+solid/;
    const leftBar = /border-left:\s*(?:[2-9]|\d{2,})px/;
    // 滚动条滑块的「透明边框 + padding-box」是标准做法，不算界面粗边框
    const stripScrollbar = (text: string) => text.replace(/[^{}]*scrollbar[^{}]*\{[^}]*\}/g, '');
    const bad = NON_TOKEN_CSS.filter((file) => {
      const text = stripScrollbar(file.text);
      return solid.test(text) || leftBar.test(text);
    });
    expect(bad.map((file) => file.path)).toEqual([]);
  });

  it('不使用 transition: all（只列明确属性）', () => {
    const bad = CSS_FILES.filter((file) => /transition:\s*all/.test(file.text));
    expect(bad.map((file) => file.path)).toEqual([]);
  });

  it('彩色 rgba 必须走令牌（纯黑/纯白叠层例外）', () => {
    const bad: string[] = [];
    for (const file of NON_TOKEN_CSS) {
      for (const match of file.text.matchAll(/rgba\(\s*([^)]*)\)/g)) {
        const channels = match[1]
          .split(',')
          .slice(0, 3)
          .map((part) => part.trim());
        const neutral =
          (channels[0] === '0' && channels[1] === '0' && channels[2] === '0') ||
          (channels[0] === '255' && channels[1] === '255' && channels[2] === '255');
        if (!neutral) bad.push(`${file.path}: ${match[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('字面色值只允许出现在 tokens.css', () => {
    const bad: string[] = [];
    for (const file of NON_TOKEN_CSS) {
      for (const match of file.text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        bad.push(`${file.path}: ${match[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('设计守卫：实现约定', () => {
  it('不直接拼 innerHTML（用户数据统一走 textContent / el()）', () => {
    const bad = TS_FILES.filter((file) => file.text.includes('.innerHTML'));
    expect(bad.map((file) => file.path)).toEqual([]);
  });

  it('IPC 不散落：只有 ipc.ts / *-ipc.ts 允许直接 import invoke', () => {
    const bad = TS_FILES.filter(
      (file) =>
        /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*'@tauri-apps\/api\/core'/.test(file.text) &&
        !/ipc\.ts$/.test(file.path),
    );
    expect(bad.map((file) => file.path)).toEqual([]);
  });
});
