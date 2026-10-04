# 需求基线

来自 2026-10-04 的需求拷问会话（grill-with-docs），所有分叉已由用户拍板（拍板记录见文末）。技术决策见 `docs/decisions.md` 与 `docs/adr/`，术语见 `GLOSSARY.md`。

## 产品定位

多标签页评测工作台，以「评测」为主、「编码」为辅，对比不同图片/视频编码格式的画质和压缩效率。桌面原生窗口（双击打开，不用浏览器）+ CLI 一行命令批量；核心逻辑 Windows / Linux / macOS 三端通用；WSL 里开发，日常 Windows 使用。

## 第一版范围

**图片（两种工作模式都做）**
- 外部导入模式：选原图 + 已用其他工具压好的跑分图，工具跑分对比。
- 一站式模式：选原图，工具自动按编码阶梯压缩生成跑分图并自动跑分。
- 默认编码阶梯：JPEG（MozJPEG）/ WebP / AVIF / JPEG-XL × 质量 60/75/90，**外加无损对照组**（PNG / 无损 WebP / 无损 JXL）默认开启，界面可自定义。
- 图片用途定位混合（照片/截图/动漫插画都要），指标与默认档按此配置。

**视频（只做外部导入）**
- 用户用其他工具压好视频，拿进来和原视频跑分对比（VMAF 等）。
- 对比查看器做**逐帧同步对比**：同一时间点并排画面（复用图片对比的左右分屏/滑动/多视图），时间轴同步拖动 + 逐帧步进。

**明确不做（第一版）**：上下分屏；视频一站式（工具自动接视频编码器跑质量-大小阶梯）；连续同步播放。均入路线图。

## 结构与查看器

- 标签页 = 跑分组，独立、可新建/关闭/重命名；**一个跑分组可包含多轮评测**。
- 评测轮 = 一张原图（或原视频）+ N 张跑分图（或跑分视频）的一组对比。
- 每个跑分组三块：对比查看器（核心）、跑分结果区（表格/排名）、操作区（选原图、选跑分图、触发跑分）。
- 六种对比模式：左右分屏（主力，同步缩放平移）、滑动对比、多视图（2×2 / 3×3，每格独立选图，同步缩放平移）、叠加对比（半透明）、差异图、闪烁切换。
- 结果区按轮分组展示指标表与排名；跨轮汇总排名留路线图。

## 指标（agent 定，反对即改）

- 图片：PSNR / SSIM / MS-SSIM 基线 + Butteraugli / SSIMULACRA2 感知类；一站式阶梯附 BD-rate 对比。
- 视频：VMAF + PSNR / SSIM。

## 交付形态

- 开源 GitHub 仓库，MIT 许可（`LICENSE` 已放入）；远程仓库等用户说「推」时再创建。
- GitHub Actions 出三平台产物；Windows 双击即用（便携 exe + 安装包）；初期不签名（macOS 签名需付费开发者账号，暂不做）。
- CLI：`score`（外部导入跑分）与 `run`（一站式批量）子命令，输出默认 CSV，可选 JSON / HTML。
- 界面简体中文，术语（SSIM、AVIF 等）保持原文。
- 跑分组（含轮次与结果）自动保存、可重开；可导出 CSV / HTML 报告。

## 里程碑

- **M0 技术栈落地**：Tauri 骨架在 WSL 启动真实桌面窗口（截图验收），骨架按 `.agents/skills/tauri-v2` 的 Quick Start 与项目结构约定搭建（lib.rs/main.rs 拆分、capabilities/default.json、generate_handler! 注册）；验证门命令与依赖安装命令实测后回填 `AGENTS.md` / README。
- **M1 核心库 + CLI（图片外部导入）**：解码、图片指标、`score` 子命令出指标表（示例图验收）。
- **M2 GUI 最小可用**：跑分组/轮次管理、选图、触发跑分、左右分屏与滑动对比、结果表、跑分组自动保存（IPC 用 invoke/事件/Channel，文件选择用 dialog/fs 插件并配 capabilities 权限——模式见 tauri-v2 skill）。
- **M3 查看器全模式**：多视图 2×2/3×3、叠加、差异图、闪烁切换。
- **M4 一站式图片**：编码阶梯（含无损组）自动生成并跑分、BD-rate、导出报告（编码器分发评估 sidecar/externalBin 机制——tauri-v2 skill 的 advanced-runtime 参考；同样适用于 M5 的 ffmpeg）。
- **M5 视频外部导入**：VMAF 接入（ffmpeg/libvmaf；Windows 侧依赖打包方案届时记入 `docs/decisions.md`）、逐帧同步对比、视频跑分结果。
- **M6 三端打包**：GitHub Actions 产物，Windows 双击即用（bundle 配置与签名约束按 tauri-v2 skill 的 updater/distribution 参考）。
- **路线图（第二版起）**：视频一站式（编码器阶梯 + BD-rate）、连续同步播放对比、跨轮汇总排名。

## 拍板记录（2026-10-04）

| 分叉 | 决定 |
| --- | --- |
| 视频范围 | 第一版就要视频 |
| GUI 路线 | Tauri 2 + Rust 核心 |
| 图片类型 | 混合都要 |
| 跑分组模型 | 一页 = 多轮评测 |
| 视频工作模式 | 只做外部导入 |
| 视频查看器 | 逐帧同步对比 |
| 无损对照组 | 默认阶梯带上 |
| 开源许可 | 开源，MIT |

## 参考项目（用户提供）

- 图像评测：imazen/codec-eval、kadykov/web-image-formats-research、thibaudcolas/image-quality-benchmark
- 视频评测：Netflix/vmaf、SINRG-Lab/Video-Codec-Evaluation、fau-lms/bjontegaard
- 界面参考：Squoosh 对比界面、IZH318/Video-Encoding-Optimizer
