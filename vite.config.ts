import { defineConfig } from 'vite';

// 默认 5173；多 worktree 并行开发时用 VITE_PORT 指定各自的端口，
// 需同步用 `tauri dev --config` 覆盖 src-tauri/tauri.conf.json 的 devUrl（见 .gitignore 的本地覆盖文件）。
export default defineConfig({
  clearScreen: false,
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    watch: {
      // Rust 构建产物（target/）里的 dll/exe 在编译时被占用，Vite 默认会去 watch
      // 整个项目根，命中 EBUSY 直接让 `tauri dev` 的 beforeDevCommand 失败。
      // 这些目录与前端热更新无关，显式忽略；.tmp 是本地截图/样例目录。
      ignored: ['**/target/**', '**/.tmp/**', '**/src-tauri/gen/**'],
    },
  },
});
