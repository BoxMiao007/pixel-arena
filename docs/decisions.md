# 技术决策记录

每条记录：日期、决策、为什么、放弃了什么。深入取舍见 `docs/adr/`。

## 0001 · 技术栈：Tauri 2 + Rust 核心（已确认）

- 日期：2026-10-04
- 决策：GUI 用 Tauri 2（桌面窗口，界面 Canvas/Web 渲染）；解码、指标、编码编排做成独立 Rust 核心库，GUI 与 CLI 共用；一站式图片编码调用各格式权威参考编码器（MozJPEG / libwebp / libaom / libjxl）子进程；视频跑分走 ffmpeg（VMAF）。
- 为什么：对比查看器（同步缩放平移、网格多视图、视频逐帧同步对比）是工具命脉，Canvas/GPU 渲染最顺手（Squoosh 已验证此路线）；一份 Rust 核心三端复用，CLI 零额外成本；安装包约 15MB；权威参考编码器保证跑分结果可信（纯 Rust 编码器与参考实现质量有差距）。
- 放弃了：PySide6 + Python（真原生控件、指标库现成，但 Windows 打包约 150MB，AVIF/JPEG-XL 编码依赖是硬伤）；Electron + Node.js（可复用 Squoosh WASM 编码器，但安装包 150MB+、内存占用高）。
- 详见 `docs/adr/0001-tauri-rust-core.md`。

## 0002 · 第一版范围：图片全量 + 视频外部导入（已确认）

- 日期：2026-10-04
- 决策：图片做完整两种工作模式（外部导入 + 一站式）；视频进第一版但只做外部导入（用户自备压缩视频，工具跑分对比），查看器做逐帧同步对比；视频一站式与连续同步播放进路线图。
- 为什么：用户明确视频要在第一版；但视频一站式要接视频编码器跑质量-大小阶梯，范围再翻一倍，外部导入已覆盖「对比不同编码产物」的核心诉求。
- 放弃了：第一版只做图片（用户否决）；第一版视频一站式（用户接受延后）。

## 0003 · 一站式默认编码阶梯（已确认）

- 日期：2026-10-04
- 决策：默认 JPEG（MozJPEG）/ WebP / AVIF / JPEG-XL × 质量 60/75/90，外加无损对照组（PNG / 无损 WebP / 无损 JXL）默认开启，界面可自定义。
- 为什么：图片用途是混合（照片/截图/动漫都要），无损组作为大小与画质锚点，对截图类尤其有参考价值。
- 放弃了：只有损阶梯（用户选择带上无损组）。

## 0004 · 工作区数据模型与 JSON 持久化（已确认）

- 日期：2026-10-04
- 决策：核心库新增 `workspace` 模块（Workspace → Group → Round 三层），持久化为应用数据目录下单个 `workspace.json`（format_version 字段 + 原子写入：先写临时文件再重命名）；字段序列化用 camelCase，新增字段一律带 serde 默认值保证旧文件可读。激活的标签页/轮次随状态一起保存。
- 为什么：GUI（Tauri 命令）与将来的 CLI 复用同一套数据模型；原子写入让「改动即自动保存」不怕中途崩溃留半截文件。
- 放弃了：SQLite（当前只有几百字节的层级数据，JSON 足够）；损坏文件自动备份（T05 只报中文错误，等真实损坏场景出现再加固）。

## 0005 · 图片解码与 PSNR/SSIM 实现（已确认）

- 日期：2026-10-04
- 决策：解码用 `image` 0.25（PNG/JPEG/WebP，纯 Rust，统一 8-bit sRGB）；SSIM 按 Wang et al. 2004 自研实现（11x11 高斯窗 sigma=1.5、valid 边界、三通道平均）；PSNR 用全通道合并 MSE 口径（与 ffmpeg `psnr` 滤镜 `average` 相同）。指标锚点为黄金基准（入库样例 + 容差测试），并与 ffmpeg / numpy 定义性参照交叉验证。
- 为什么：`image` 纯 Rust 三端编译无系统依赖；SSIM 无活跃维护的等价 crate，教科书公式约百行且可与定义性参照逐位对齐；ffmpeg 的 `ssim` 滤镜实为 8x8 均匀窗变体，不能当标准 SSIM 锚点（证据：pixel-arena-shared/evidence/T02-交叉验证.md）。
- 放弃了：第三方 SSIM crate（无维护）；以 ffmpeg 口径为准（非标准，且测试须离线可跑）。

## 0006 · 评测轮内容与指标结果的数据模型（已确认）

- 日期：2026-10-04
- 决策：评测轮（Round）扩展 `referencePath`（原图路径）与 `candidates`（跑分图列表：路径、文件大小、体积比、指标结果、失败原因）；指标结果存「指标名 → 值」键值表，GUI 结果表列由键驱动生成；无穷大指标（两图完全一致时的 PSNR）以字符串 `"inf"` 哨兵持久化。
- 为什么：T04 新增 MS-SSIM / Butteraugli / SSIMULACRA2 时结果表自动多列，GUI 无需再改；serde_json 会把非有限浮点写成 null 导致读不回来，哨兵保证 JSON 往返无损。
- 放弃了：固定指标列的结构体（加指标要改三处：核心库、TS 类型、GUI 表格）；把 PSNR 截断成有限大数（数值不诚实）。

## 0007 · 感知指标：MS-SSIM 自研 + Butteraugli/SSIMULACRA2 用社区 Rust 移植（已确认）

- 日期：2026-10-04
- 决策：MS-SSIM 在核心库自研（与现有 SSIM 共用 11x11 高斯窗机制，Wang 2003/2004 五层下采样标准流程，权重 [0.0448, 0.2856, 0.3001, 0.2363, 0.1333]，三通道各自合成后平均，负项按 0 截断）；Butteraugli 用 `butteraugli` 0.9.3（imazen 维护，libjxl C++ 原版的纯 Rust 移植，自带 10.9k 行 C++ 对照回归表，本机全量通过）；SSIMULACRA2 用 `ssimulacra2` 0.5.1（rust-av 组织维护，官方测试 tank 样例期望值 ±0.25 本机复现）。输出口径：Butteraugli 输出原始距离分（0 = 完全一致，约 1.0 = 刚好可察觉），SSIMULACRA2 输出原始质量分（100 = 完全一致），都不做 DSSIM 之类变换，保持各指标社区通用口径。
- 为什么：三个指标是感知质量评价的事实标准；`butteraugli` crate 维护活跃（2026-05 仍在发版、52k 下载）且把 C++ 原版对照值带进测试，可信度最高；`ssimulacra2` 是 Rust 生态事实上的唯一活跃移植（av1an 生态在用）。两个 crate 均纯 Rust、无系统依赖，保住三端编译。MS-SSIM 无可信 crate，公式约百行且复用已交叉验证的 SSIM 机制，与 numpy 定义性参照逐位对齐（scripts/msssim_reference.py）。
- 放弃了：`butteraugli-oxide`（无 stable 版本、下载量低）、`butteraugli-sys`（绑 C++，引入系统依赖）；`ssimulacra2-cuda`（需 GPU）；MS-SSIM 引第三方 crate（无可信维护者）；Butteraugli 转 DSSIM 口径（丢失 JND 可解释性）。

## 0008 · 对比查看器视口状态与 asset protocol 图片加载（已确认）

- 日期：2026-10-04
- 决策：查看器的缩放/平移收敛为纯 TS 模块 `src/viewport.ts` 的「视口状态」{centerX, centerY, zoom}（图片坐标系，窗格尺寸只作换算参数），提供 fit / 光标锚点缩放 / 平移 / 图片↔屏幕换算 / 可见区域裁剪，全部纯函数，由 vitest 前端单测守护（`npm test`）；左右分屏与滑动对比共享同一份视口状态。图片经 asset protocol（convertFileSrc）交给 WebView 原生解码：tauri.conf.json 开启 `assetProtocol` 且 scope 放行全部路径，tauri crate 增加 `protocol-asset` feature，capabilities 无需新增权限。
- 为什么：视口用图片坐标描述，N 个尺寸不同的窗格可共用同一份状态，是 T08 多视图、叠加与视频逐帧对比的天然底座；asset protocol 免 base64 IPC，大图解码内存与开销最小。scope 放行全部路径：文件对话框本身即用户授权，且 Windows 多盘符无法用 $HOME 等变量穷举，限用户目录会造成任意盘选图「能选不能看」。
- 放弃了：视口逻辑内嵌在组件渲染里（不可单测、难扩展）；IPC 回传 base64 图片数据（大图内存翻倍）；离屏 worker 解码（可见区域裁剪绘制在 3000×2000 实测已流畅，出现卡顿再引入）。

## 0009 · 权威编码器分发：首次使用时下载 + sha256 校验（已确认）

- 日期：2026-10-05
- 决策：一站式模式调用的权威参考编码器不随应用捆绑。首次使用时从版本锁定的 URL 下载 `.tar.gz` 工件，sha256 与清单登记值一致才解包安装到应用数据目录 `tools/<编码器>/<版本>/<可执行文件>`，并在旁边写 `<可执行文件>.sha256`；之后每次使用先校验已装文件，损坏或被改自动重新下载覆盖；下载内容哈希不符即报中文错误且不落盘。三端共用同一套「下载 → 校验 → 解包 → 复用」机制，只差来源清单（EncoderSource：版本 + URL + sha256 + 包内文件名）各平台一条条目；Linux x86_64 的 MozJPEG 4.1.5 条目随 T10 落地，其余平台与编码器的条目由打包票（T16）在 CI 构建并上传 GitHub Release 后补齐。网络受限环境可用 `PIXEL_ARENA_ENCODER_MIRROR` 环境变量把下载主机换成镜像目录（同名工件）。
- 为什么：MozJPEG 等权威编码器没有跨平台系统包管理器统一来源，apt 无 mozjpeg 包；随应用捆绑会让安装包从约 15MB 涨到数十 MB，且任一平台构建出问题会卡住整个应用发版；首次使用下载把「取编码器」从发版链路里解耦，编码器升级只换清单条目。校验链双锚点：清单 sha256 锚定下载工件（防下载损坏/篡改），安装目录旁路 sha256 锚定已解包文件（启动免下载、防运行期损坏）。机制已在 Linux 端到端实测跑通（下载 → 校验 → 安装 → 编码 → 跑分）。
- 放弃了：捆绑进安装包（体积大、构建链路耦合，Tauri `externalBin` sidecar 需为三平台分别准备二进制）；运行期用系统包管理器安装（Windows 无统一来源、macOS 需 Homebrew 依赖，都不可控）；npm @imagemin/mozjpeg 包（Node 生态工件，且它是构建期依赖不该进桌面应用运行时）。

## 0010 · 视频跑分经 ffmpeg 子进程 + 静态构建下载到应用数据目录（已确认）

- 日期：2026-10-05
- 决策：视频指标（VMAF/PSNR/SSIM）统一经外部 ffmpeg 子进程一次算完（`split` 出 libvmaf/psnr/ssim 三个滤镜分支，结果从 stderr 汇总行解析，不落 JSON 日志文件）；ffmpeg 不依赖系统安装，首次使用视频跑分时把锁定版本的静态构建下载到应用数据目录 `tools/` 下，先做全量 sha256 校验再解压（不匹配即删除重下）。Linux 锁定 johnvansickle.com 的 ffmpeg 7.0.2 amd64 static（版本化 URL 固定不变，官方公告 md5 交叉一致，包内含 libvmaf）；Windows 侧同一机制但构建源不同（gyan.dev release-full 或 BtbN win64-gpl，均含 libvmaf），随打包票 T16 定稿并捆绑，本版 Windows 上仅识别手动放入 `tools/` 的 ffmpeg.exe，缺了报中文提示。口径：VMAF 用 libvmaf 默认内嵌模型 vmaf_v0.6.1；视频 SSIM 为 ffmpeg `ssim` 滤镜口径（8x8 均匀窗变体），与图片 SSIM（Wang 2004 标准实现）不可直接比较，已在 GLOSSARY.md 注明；音轨不参与评分。下载的压缩包（约 40MB）不入库，落在应用数据目录。
- 为什么：系统发行版 ffmpeg 普遍不带 libvmaf（本机 Ubuntu 的 ffmpeg 8.0.1 只有 vmafmotion），动态链接系统 ffmpeg 会让 VMAF 完全不可用；静态构建免依赖、解压即用、跨机器结果可复现；锁定版本 + 双哈希校验（官方 md5 交叉、代码内 sha256）守住供应链；应用数据目录是用户可感知的标准位置，便于排查与手动升级。
- 放弃了：从源码编译 libvmaf/ffmpeg（构建慢、难复现、三端脚本成本高）；Rust 原生 VMAF 实现（无成熟维护的 crate）；运行时用系统 PATH 上的 ffmpeg（libvmaf 可用性不可控）；把 ffmpeg 直接提交进仓库（体积与许可都不合适，GPL 构建以来源记录文件标明）。

## 0011 · 视频逐帧对比：回环流服务供帧 + ffprobe 取帧率（已确认）

- 日期：2026-10-05
- 决策：视频逐帧对比（T15）的 `<video>` 元素不使用 asset protocol，改从应用内置的本地回环 HTTP 流服务拉流（`src-tauri/src/video_server.rs`：仅监听 127.0.0.1、端口随机、只暴露经 IPC `video_stream_url` 显式注册过的文件路径，路径哈希做 URL id，支持 Range 分段，纯 std 实现）。帧率/时长经 ffprobe 读取（`video_probe_meta` 命令 + `video_probe.rs` 纯函数解析 key=value 输出），ffprobe 与 ffmpeg 同包同版本：ffmpeg 工具安装的解压清单由只解 ffmpeg 扩为 ffmpeg+ffprobe（决策 0010 的增量），T14 时代只有 ffmpeg 的老安装会在首次探测时幂等补装。逐帧步进口径：±1 帧按当前显示第一路视频的帧长（1/fps）移动共享时间点，两路各自落到共享时间点的最近帧；时间轴总量取当前显示各路时长的最小值。
- 为什么：实测 WebKitGTK 2.52.6 的媒体引擎不走 Tauri 的 asset 自定义协议（`<video>` 直接报 SRC_NOT_SUPPORTED，`<img>` 不受影响），本地回环 HTTP 是三端一致的可靠通路；只回环、随机端口、显式注册把暴露面压到与 dev server 同级。帧率必须用容器元数据而不是估算，否则「逐帧」步进不诚实；ffprobe 与 ffmpeg 同一锁定包，无新增下载来源。放弃的方案：MediaSource + IPC 分片传字节（复杂度高一个量级）；再注册一个自定义协议（与 asset 同样被媒体引擎绕过）；只支持 Windows/macOS 的 asset 路径（Linux 主开发端直接不可用）。
- 遗留：Linux 端 H.264 等格式依赖系统 GStreamer 插件（本机缺 gst-libav），画面区已给中文提示「需安装 gst-libav」，是否捆绑/引导安装由打包票 T16 决策。
