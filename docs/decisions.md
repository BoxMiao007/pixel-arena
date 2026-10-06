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

## 0012 · 编码阶梯补全：编码器清单与 AVIF/JXL 产物解码（已确认）

- 日期：2026-10-05
- 决策：一站式默认编码阶梯（决策 0003）全部落地为「首次使用下载 + sha256 校验」机制（复用决策 0009），Linux x86_64 的来源清单为——WebP：cwebp（libwebp 1.6.0 官方预编译静态构建，storage.googleapis.com/downloads.webmproject.org）；JPEG XL：cjxl（libjxl 0.11.1 官方 linux-x86_64 静态构建，GitHub Release，锁该版本因其后工件改为 .zip/.tar.lz 而现有机制只认 .tar.gz）；AVIF：avifenc + avifdec（libavif 1.4.2 + libaom 3.13.1 + libpng + zlib 全静态自建，官方只发源码不发二进制，工件入本项目 GitHub Release 供打包票 T16 接管）；无损 PNG 用 image crate 进程内编码，无外部二进制。产物解码在核心库解码入口（decode_srgb）按魔数分派：JPEG XL 走 jxl-oxide（纯 Rust 进程内，三端无外部依赖）；AVIF 走 avifdec 子进程（与 avifenc 同工件一次下载安装，路径经环境变量 PIXEL_ARENA_AVIFDEC 注入，GUI 启动时自动设置，CLI 显式设置）。AVIF/JXL 产物生成时自检解码并旁路一份无损 PNG 代片（`<产物>.png`），供 WebView（不支持这两种格式）的查看器显示。
- 为什么：cwebp/cjxl 有官方静态构建，直接沿用 T10 的分发机制零新代码；AVIF 必须用权威参考编码器（libaom），而 libaom/libavif 都无官方预编译，自建静态工件与 T10 的 MozJPEG 同标准（仅依赖 libc/libm），解码侧纯 Rust 生态没有成熟的 AVIF 全栈（rav1d + 容器解析 + 色彩转换拼装复杂度远超一个子进程调用），avifdec 与 avifenc 同源同装最省事；JXL 解码选 jxl-oxide 而非同工件里的 djxl，是因为解码入口（跑分、代片）在核心库内发生，进程内解码免「运行期找二进制」的注入链路，且外部导入 JXL 文件时无需先下载编码器。代片只影响显示，跑分与结果表始终用产物本身，像素经 jxl-oxide/avifdec 解码，与跑分口径完全一致。
- 放弃了：AVIF 解码经 ffmpeg（系统/静态构建的 libjxl、heif 解封装可用性参差，且引入第二套二进制依赖）；JXL 解码经 djxl 子进程（要为「解码」维护编码器可用性，外部导入场景体验差）；libwebp/libjxl 自建（官方静态构建已满足全静态标准）；无损 AVIF 进对照组（决策 0003 未含，YAGNI）；升级 libjxl 到 0.12+（需先扩展解包机制支持 .tar.lz/.zip）。
- 工件登记：工件 sha256 与下载 URL 记录在 `crates/pixel-arena-core/src/encode.rs` 的来源清单与 T11 笔记（pixel-arena-shared/notes/T11.md）；GitHub Release encoders-v1 由打包票 T16 统一上传（上传前 URL 404 为预期，测试用 PIXEL_ARENA_ENCODER_MIRROR）。

## 0013 · BD-rate 口径与导出报告格式（已确认）

- 日期：2026-10-05
- 决策：BD-rate（Bjøntegaard delta 码率）在核心库 `bdrate` 模块实现，口径为——画质轴 PSNR（与跑分同一口径）；码率轴用文件字节数（同轮全部跑分图与原图同分辨率是跑分的前提，与 bpp 只差公共常数因子，在「同画质 log2 码率差」的差分中抵消，BD-rate 数值与 bpp 口径恒等，故免读图片尺寸）；拟合为 log2(码率) 对画质的最小二乘多项式（点数 ≥4 三次、恰 3 点降为二次），在两条曲线画质区间的交集上积分，BD-rate% = (2^Δ−1)×100，负值 = 同画质下更省码率。参照格式默认 JPEG，点数不足时按有损阶梯顺序（JPEG → WebP → AVIF → JPEG XL）回落并在界面/报告标注实际参照；无损组（PSNR = ∞）不参与拟合、单独标注。降级行为（不崩、有中文说明）：有效点 <3 → 样本不足；率失真非单调（按画质升序码率不递增）→ 跳过该格式；画质区间无交集或拟合矩阵退化 → 跳过该格式。正确性锚定：合成率失真数据的解析解与独立数值积分黄金测试。导出报告（核心库 `report` 模块，GUI 导出按钮 + 保存对话框）：CSV 分三节（图片跑分结果 / 视频跑分结果（无视频省略）/ BD-rate 汇总），沿用 T03 约定（RFC 4180 最小转义、inf/nan 哨兵、定点 6 位小数、英文列名）；HTML 为自包含单文件（内联样式、简体中文、含生成时间/跑分组/评测轮/原图名与路径/指标表/BD-rate 表，不嵌图片正文、附文件路径列）。界面汇总区与导出共用同一核心库函数（Round + summarize_round），保证所见即所导。
- 为什么：画质轴选 PSNR 是 BD-rate 的业界惯例（JPEG/AV1 共同测试条件均以 PSNR/SSIM 为主轴），它在质量阶梯上单调性最稳，且本库 PSNR 口径（全通道 average）已与 ffmpeg 交叉验证；SSIM 也常用但本库图片 SSIM 与视频 SSIM 口径不同（决策 0010），跨类型比较要额外解释；感知指标（Butteraugli/SSIMULACRA2）方向与尺度各异、低质量端可能非单调，第一版不接。码率轴选字节数而非 bpp：数值上完全等价（见上），实现免去 image_dimensions 的逐图读头及其对 AVIF/JXL 的失败分支。CSV 英文列名与 CLI score 输出同 schema（T03 约定「勿改名」），机器可读；HTML 承担面向人的中文报告。导出时间戳由前端生成传入，核心库序列化保持纯函数（可 TDD、不引入时间格式化依赖）。
- 放弃了：SSIM/SSIMULACRA2 画质轴（口径解释成本与单调性风险，后续票可加开关）；bpp 直算（等价但多一条读尺寸失败路径）；二次以上特殊拟合或分段线性（Bjøntegaard 标准多项式已够，YAGNI）；CSV 中文列名（与 T03 的 CLI schema 保持一致优先）；导出嵌图片正文（报告体积失控，路径列已可回溯原图）；BD-PSNR 反向指标（票面未要求）。

## 0014 · 三端打包与 Windows 工具分发：小安装包 + 首次运行下载（已确认）

- 日期：2026-10-05
- 决策：三端安装包不捆绑编码器与 ffmpeg（保持约 15MB 小体积），Windows 双击安装后一站式与视频功能开箱即用靠既有下载机制补齐：首次触发一站式/视频跑分时按决策 0009/0010/0012 的「下载 → sha256 校验 → 解包 → 复用」自动取工具（需网络，一次性），失败给中文错误且不落盘。三端安装产物由 GitHub Actions 矩阵产出（tag v* 触发）：Windows NSIS + MSI + 便携 exe，Linux deb + AppImage，macOS dmg + app；初期不签名（Windows SmartScreen 提示、macOS 需右键打开绕过 Gatekeeper，已知限制写入 README）。Windows x86_64 的编码器清单（encode.rs）本票补齐三条——MozJPEG 4.1.5 用 mingw-w64 交叉编译（与 Linux 版同源码同配置：无 SIMD、全静态，导入表仅系统 DLL），工件入库 `assets/encoders/` 由 CI 原样上传 Release encoders-v1，清单哈希与 Release 资产恒等、无回填环节；libwebp 1.6.0 与 libjxl 0.11.1 直连官方版本化 URL（官方 Windows 工件只有 zip 格式，解包机制相应扩为「tar.gz 或 zip」：按魔数分流、文件名匹配容忍 `\` 路径分隔、unix 上统一补执行权限）。Windows ffmpeg 锁定 BtbN FFmpeg-Builds 的版本化 autobuild tag（autobuild-2024-11-30-13-12 的 ffmpeg-n7.1-39-g64e2864cb9-win64-gpl-7.1.zip，GitHub release 资产不可变，`--enable-libvmaf` 构建配置已核对，全静态单文件仅依赖系统 DLL），sha256 代码内锚定，与 Linux 的 johnvansickle 7.0.2 不同版本（跨平台版本不必一致，VMAF 模型同为 vmaf_v0.6.1，口径一致）。macOS 的编码器清单与 ffmpeg 分发暂缺（libwebp 官方仅 Intel 包、libjxl/libavif/MozJPEG 无官方 macOS 工件、无查证过「含 libvmaf + 版本化锁定 URL + 可锚定哈希」三条件齐备的 ffmpeg 源），暂维持中文「暂无分发 / 请手动放置」提示，条目随后续票补齐；Windows AVIF 同理（libavif/libaom 无官方预编译，工件需 CI 自建并回填清单哈希），推送后 Windows 一站式除 AVIF 有损 3 档外全部可用。
- 为什么：小安装包分发快，工具升级只改清单条目不动应用发版；「工件入库 + CI 原样上传」让安装包内的清单哈希与 Release 资产同源，消除「CI 重新构建哈希漂移 → 回填代码 → 重打 tag 重出安装包」的循环（Linux 的 MozJPEG/libavif 与 Windows 的 MozJPEG 三条适用）；libwebp/libjxl/ffmpeg 官方直连已有「版本化 URL + sha256 双锚」，供应链等价，不引入本项目转传环节；解包扩 zip 是 Windows 官方工件格式的最小适配（同一套 sha256 校验与暂存目录逻辑复用）。
- 放弃了：捆绑工具进安装包（体积涨到 200MB+，编码器升级被迫重发版，违背决策 0009 的解耦初衷）；CI 从源码构建全部编码器工件（MozJPEG/libavif 的 CI 重建哈希与本机锚定值必然不同，首次发布即陷入回填循环）；gyan.dev 作 Windows ffmpeg 源（版本化老包已下架，最老保留 8.1.2，无法锁 7.0.2 附近版本）；BtbN「latest」滚动 tag（URL 固定但内容随构建变动，不满足版本锁定）；macOS 本票强行补条目（无官方工件可锚定，硬凑要引入 vcpkg/osxexperts 等不可控来源）。
- 工件登记：Windows 清单条目与哈希记录在 `crates/pixel-arena-core/src/encode.rs`（Windows ffmpeg 在 `src-tauri/src/ffmpeg_setup.rs`）；入库工件在 `assets/encoders/`（CI 上传 encoders-v1 的即此目录内容）；构建配方（mingw 交叉编译命令）见 pixel-arena-shared/notes/T16.md。

## 0015 · 跑分组分类型（图片/视频）与旧工作区自动归类（已确认）

- 日期：2026-10-05
- 决策：跑分组（Group）增加类型字段（图片/视频），新建时在下拉菜单选定、之后不可更改；组内评测轮的类型随组锁定——六个评测内容入口（选原图/添加跑分图/图片跑分、选原视频/添加跑分视频/视频跑分）在核心库按组类型前置校验，类型不符报中文错误。旧 workspace.json（无 kind 字段）加载时按「组内任一轮含视频（有原视频或有跑分视频）→ 视频跑分组，否则（含空组）→ 图片跑分组」在核心库 `from_json` 迁移归类，只补类型不动任何既有数据；迁移判定在核心库单测覆盖空组/纯图片组/含视频组。前端按类型分流渲染：图片组只有图片流程，视频组只有视频导入与逐帧同步对比（遗留图片内容只读展示）。格式版本保持 1（新增字段带 serde 默认值，向后兼容，见决策 0004 演进约定）。
- 为什么：两种评测的功能入口差异大，混在一个标签页里互相干扰（规格 #19 反馈 1）；类型锁定把「组内能不能放某类内容」的裁决放在核心库一处，GUI 与将来的 CLI 自动一致；迁移放 `from_json` 让 GUI 启动恢复与任何加载路径都走同一规则，且旧文件不用升版本号就能继续加载。
- 放弃了：给评测轮（Round）单独加类型字段（组级约束已足够锁定轮类型，多一份状态要多一份迁移与一致性维护）；允许创建后改类型（会造成组内已有异类内容的脏数据，规格拍板不可更改）；升级 format_version 做显式迁移标记（新增字段带默认值即可无损兼容，重复迁移幂等无风险）；旧混用组按图片处理（会丢视频入口，按「任一轮含视频」归类保守保留两边）。

## 0016 · 编码阶梯取点单源化 + 质量/大小优先两套取点（已确认）

- 日期：2026-10-06
- 决策：取点逻辑下沉核心库 `ladder` 模块单一实现，GUI 与 CLI 共用。质量优先 = 统一基准 0–100，在基准 ±15 取点（贴边夹进各格式自身范围、不足 3 点向内扩 ±30 补足），每有损格式 ≥3 点 + 无损对照组；基准 75 的取点恒等于决策 0003 默认阶梯 60/75/90，GUI 勾选目录（新 IPC 命令 `onestop_default_ladder`）与 CLI 默认/`--baseline-quality` 全部同源。大小优先 = 目标字节数驱动，每格式先探范围两端再二分逼近（`size_search` 纯函数，「质量 → 实际大小」探测回调注入，真实编码走 `probe_onestop_size` 探测缝）；不可达（过小压不到/过大放松到顶）回退最小/最大质量点并携带中文标注，大小优先模式 CSV/JSON 追加尾随 note 列、HTML 追加「备注」列，默认与质量优先模式输出列序不变。命中点邻近自动补点至 ≥3（US23），JXL 有损范围上限定 95（cjxl q100 是数学无损，与无损对照组重叠）。
- 为什么：GUI（src/onestop.ts）与 CLI（main.rs）各持一份档位定义，改一处漏一处（#19 反馈 5 的根因之一）；单源后默认行为、GUI 目录、CLI 取点同一份代码，基准 75 ≡ 60/75/90 的锚点测试钉死兼容性。二分搜索约 9 次探测/格式即可逼近，纯函数化让边界单测不依赖真实编码器。
- 放弃了：按码率 bpp 口径搜索（与字节口径在 BD-rate 上等价，字节免读尺寸，沿决策 0013）；全局最优质量点扫描（每格式全 100 档编码代价不可接受，二分逼近在总体单调的率失真曲线上足够，局部非单调时结果仍是合理逼近点）；GUI 拉杆交互与 KB/MB 切换（T22 范围，本票只切数据源）；CLI `--qualities` 显式枚举改为自动取点（既有行为与脚本兼容优先，显式枚举原样保留）。

## 0017 · 设置中心：settings.json 独立持久化 + 编码器路径覆盖进核心库签名（已确认）

- 日期：2026-10-06
- 决策：设置存应用数据目录的 `settings.json`（与 workspace.json 分离，坏文件 fail-soft 回默认不挡启动，工作区那边维持 fail-fast），camelCase 形状 Rust/TS 两侧对应。首批项：记录状态开关（默认开）、界面主题（浅/深/跟随系统，`data-theme` 驱动 CSS 变量，画布底色读 `--canvas-bg` 同源）、默认导出目录、最近目录（记录恒进行、恢复由记录状态门控）、编码器路径覆盖（空串归一为 None=恢复内置；保存时校验存在性）。窗口大小不用 tauri-plugin-window-state，随 settings.json 记逻辑像素宽高（窗口 Resized 时持续记录、值变才写盘、最大化与过小尺寸跳过，启动恢复；不挂退出事件——实测 WSLg/X11 关窗触发致命 X 错误，GDK 直接终止进程，CloseRequested/ExitRequested 均不可达，Resized 始终可达且兜住崩溃退出）。编码器覆盖进核心库：`encode_onestop` 增加 `EncoderOverrides` 参数，覆盖路径优先于内置自动安装、假路径在启动编码器前 fail-fast 中文报错；CLI 恒传默认值，行为只由命令行参数决定（不读 GUI 设置）。avifdec（AVIF 代片解码）沿用 PIXEL_ARENA_AVIFDEC 环境变量注入机制，由 GUI 壳在启动与保存设置后刷新。
- 为什么：设置是可重配偏好，独立文件让「删设置不伤评测数据」、fail-soft 与工作区数据分级一致；路径覆盖放核心库签名让 GUI/CLI 边界在类型上可见（CLI 想读设置都读不到，settings 模块在 src-tauri crate），报错在编码入口 fail-fast 且点名工具与路径；CSS 变量方案让主题切换零 JS 分支、查看器画布与界面同源即时生效。
- 放弃了：tauri-plugin-window-state（多一个插件/capabilities 面，且窗口大小本就要和记录状态开关一起门控，自管一个字段更可控）；tauri-plugin-store（键值存储对带校验的结构化设置无增益）；设置存 localStorage（Rust 侧单测不可达，且编码器覆盖必须在 Rust 侧使用）；CLI 读 GUI 设置（票面明确禁止）；主题只切界面壳（画布底色写死会留深色孤岛，验收要求查看器区域一并切换）。

## 0018 · 并行跑分：核心库自带工作池而非 rayon，整轮一次 IPC + Channel 推进度（已确认）

- 日期：2026-10-06
- 决策：整轮跑分并行化落在核心库 `parallel` 模块——`run_parallel`（候选列表 + 单候选评分闭包 + 并发上限 + 单调进度回调，结果保序）与 `concurrency_limit`（floor 核数×比例，夹在 [1, 核数]），std::thread::scope 工作池实现、不引 rayon。workspace 层新增 `score_round_candidates_parallel` / `score_round_video_candidates_parallel`，行级落库逻辑与单张入口共用一份函数；GUI 侧单张命令 `round_score_candidate` / `round_score_video_candidate` 替换为整轮命令（一次 IPC 提交全部跑分图/视频），进度经 Channel 推 N/M。并发度档位（quarter/half/threequarters/full，默认 half = 一半逻辑核）作为 `scoreConcurrency` 进 T23 设置中心（缺字段 serde 兜底，无迁移），比例→线程数的换算在核心库、档位枚举留在 GUI 壳层；视频侧每任务各起一个 ffmpeg 进程，同时在跑的进程数受同一上限约束。CLI 本票不改（仍逐张串行），调度函数已就位可后续共用。
- 为什么：调度需求只有「固定并发上限 + 保序 + 进度」，一个作用域线程池就够，rayon 的依赖树与全局池语义（吃满核、与并发度设置相抵触）都不合算；整轮一次 IPC 让并发调度在后端闭环，前端只剩订阅进度，不再自己开并发调用（逐张循环既拿不到统一上限也无法一次写盘）；「默认一半核心」直接对应票面「电脑不卡死、留余量」。
- 放弃了：rayon / tauri 异步任务池（前者引依赖且默认吃满核，后者要自己补保序与上限）；前端逐张循环改 Promise 并发（上限散在 UI 层、视频 ffmpeg 进程数无法约束）；并行结果容差比对（指标是单图闭式计算，逐行必须 bit 级一致，单测以黄金基准样例锚定）；CLI 同步并行化（票面验收只要求 GUI 提速，避免扩散回归面）。

## 0019 · 界面会话状态按评测轮键控（不复位、不串扰）（已确认）

- 日期：2026-10-06
- 决策：图片对比查看器、视频逐帧对比、结果表排序、一站式控件（模式/基准/目标大小/单位/格式勾选）与内容区滚动位置，全部按评测轮 id 键控（模块级 Map + 取用函数）：切换跑分组/评测轮时切走保留、切回还原、两轮互不串扰；新轮首见时按默认值创建（分屏、视口待 fit、差异阈值 2、质量优先 / 基准 75 / 200KB / 全选）。三类东西明确不按轮键控：跑分忙标志（全局，同一时刻只有一条跑分会话）、质量阶梯缓存（与轮无关的纯缓存）、切模式时的重新 fit（窗格几何变了）。状态仍不持久化，重启归零。
- 为什么：第四批用户反馈要求「切换不同跑分组/评测轮标签时，各标签的界面状态相互独立：不要同步，也不要复位」；此前是「模块级单例 + 换轮重置」，切走即丢模式/视口，且不透明度/阈值/一站式勾选跨轮串扰。
- 放弃了：持久化进 workspace.json（界面态与评测数据分离，不为看图的缩放位置扩大工作区文件与迁移面）；轮状态回收（每轮条目几百字节、会话级，重启即清）；按模式各存一份视口（切模式仍重新 fit，维持 T07 行为）。
