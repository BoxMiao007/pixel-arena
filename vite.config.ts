import { defineConfig } from 'vite';

// Tauri 窗口固定加载 http://localhost:5173：端口被占用时直接失败（strictPort），
// 避免开发服务器静默漂移到别的端口导致窗口白屏。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
});
