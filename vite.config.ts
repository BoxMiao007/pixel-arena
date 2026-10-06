import { defineConfig } from 'vite';

// 默认 5173；多 worktree 并行开发时用 VITE_PORT 指定各自的端口，
// 需同步用 `tauri dev --config` 覆盖 src-tauri/tauri.conf.json 的 devUrl（见 .gitignore 的本地覆盖文件）。
export default defineConfig({
  clearScreen: false,
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
  },
});
