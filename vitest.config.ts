import { defineConfig } from 'vitest/config';

// css 默认 false：vitest 会把 .css 导入桩成空模块（连 ?raw 后缀也拦），
// status-bar.test.ts 需要以原文读取 style.css 做回归守卫，这里放行 CSS 处理。
export default defineConfig({
  test: {
    css: true,
  },
});
