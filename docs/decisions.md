# 技术决策记录

每条记录：日期、决策、为什么、放弃了什么。标注「默认生效」的条目是 agent 在用户未及作答时按推荐选定的，用户否决即改。

## 0001 · 技术栈：Tauri 2 + Rust 核心（默认生效，待拍板）

- 日期：2026-10-04
- 决策：GUI 用 Tauri 2（桌面窗口，界面以 Canvas/Web 渲染）；解码、指标、编码编排做成独立 Rust 核心库，GUI 与 CLI 共用；一站式模式的编码调用各格式权威参考编码器（MozJPEG / libwebp / libaom avifenc / libjxl）子进程；指标取 PSNR、SSIM、MS-SSIM 基线，加 Butteraugli、SSIMULACRA2 感知类。
- 为什么：对比查看器（同步缩放平移、网格多视图）是工具命脉，Canvas/GPU 渲染最顺手（Squoosh 已验证此路线）；一份 Rust 核心三端复用，CLI 零额外成本；安装包约 15MB；用权威参考编码器保证跑分结果可信（纯 Rust 编码器与参考实现质量有差距）。
- 放弃了：PySide6 + Python（真原生控件、指标库现成，但 Windows 打包约 150MB，AVIF/JPEG-XL 编码依赖是硬伤）；Electron + Node.js（可直接复用 Squoosh 的 WASM 编码器，但安装包 150MB+、内存占用高）。
- 已知代价：Windows 安装包靠 GitHub Actions 构建；WebView 在三个平台渲染细节略有差异（可接受）。

## 0002 · 第一版范围：只做图片（默认生效，待拍板）

- 日期：2026-10-04
- 决策：第一版只做图片评测；视频（VMAF、BD-rate）写入路线图，核心库接口设计时预留扩展位但不实现。
- 为什么：视频要逐帧对齐、播放控制、ffmpeg/VMAF 依赖，范围约翻倍；先让图片链路完整跑通并验收。
- 放弃了：第一版就包含视频评测。
