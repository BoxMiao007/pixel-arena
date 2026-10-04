# Tauri 2 + Rust 核心作为全应用基座

pixel-arena 的命脉是对比查看器（多图同步缩放平移、2×2/3×3 网格多视图、视频逐帧同步对比），需要 GPU 加速的逐像素渲染和流畅交互；同时同一套核心逻辑要支撑桌面 GUI 与 CLI，并在 Windows/Linux/macOS 三端分发。决定采用 Tauri 2：桌面窗口内用 Canvas/Web 渲染界面（Squoosh 已验证该路线的对比体验），解码、指标、编码编排写成独立 Rust 核心库供 GUI 与 CLI 共用；一站式编码调用各格式权威参考编码器子进程，保证跑分结果可信。用户拍板确认于 2026-10-04 需求拷问会话。

## Considered Options

- PySide6 + Python：真原生控件、指标库现成，但 Windows 打包约 150MB，AVIF/JPEG-XL 编码依赖是硬伤。
- Electron + Node.js：可直接复用 Squoosh 的 WASM 编码器，但安装包 150MB+、内存占用高。

## Consequences

- Windows 安装包由 GitHub Actions 构建（WSL 侧不直接交叉编译）。
- 系统 WebView 三平台渲染细节略有差异，接受。
