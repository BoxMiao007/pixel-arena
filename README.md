<!-- vibe-coding-declaration:begin -->
> [!IMPORTANT]
> 本仓库由 AI 开发与维护，所有代码变更均由 AI 执行。
<!-- vibe-coding-declaration:end -->

# pixel-arena（像素竞技场）

## 这是什么

一个多标签页的编码评测工作台：以「评测」为主、「编码」为辅，用来对比不同图片/视频编码格式的画质和压缩效率。日常在 Windows 上当桌面程序用，开发在 WSL 里进行。

当前进度：

- 标签页（跑分组）与评测轮管理：新建、重命名、关闭标签页，组内新建/改名/删除评测轮、切换轮次。
- 外部导入模式跑分：在评测轮里经系统文件对话框选一张原图与多张跑分图（PNG / JPEG / WebP），点「开始跑分」逐张计算 PSNR / SSIM；结果表给出文件大小、体积比、各指标与排名，任一列可点击排序，跑分失败会在行内给出中文原因。
- 一站式跑分（完整编码阶梯）：评测轮里选好原图后，点「一站式跑分」按勾选项自动生成完整编码阶梯并逐张跑分进结果表——有损 JPEG（MozJPEG）/ WebP（libwebp）/ AVIF（libaom）/ JPEG XL（libjxl）× 质量 60 / 75 / 90，外加无损对照组（PNG / 无损 WebP / 无损 JXL，像素与原图逐位一致）。格式、质量档与无损组都能勾选/取消（默认全开），进度逐项显示在状态栏（如「正在生成 AVIF q75（5/12）」），某项失败不影响其余项。各编码器首次使用需联网下载（sha256 校验后存应用数据目录，之后离线可用）。AVIF/JXL 产物在查看器里经自动生成的 PNG 代片显示。
- 视频外部导入跑分：同一轮评测里可再选一段原视频与多段跑分视频（MP4 / MKV / WebM 等），点「开始视频跑分」逐对计算 VMAF / PSNR / SSIM 与耗时；首次使用会自动下载一次 ffmpeg（约 40MB，之后直接复用）。
- 对比查看器（第一批）：**左右分屏**（两栏并排、同步缩放平移，可放大到像素级）与**滑动对比**（拖动分割线在同一画面内切换原图与跑分图）。选中原图与跑分图后自动出现，滚轮缩放（光标为锚点）、拖拽平移、双击复位；放大超过 100% 后按原始像素显示（不平滑），便于查看压缩伪影。
- 所有改动（含跑分结果）自动保存，重启应用后完整恢复。

对比查看器另支持多视图（2×2 / 3×3 网格）、叠加对比、差异图与闪烁切换（随 T08/T09 合入）。

## 环境搭建（一次性）

需要 Rust、Node.js 和几个系统库。系统依赖（webkit2gtk-4.1、gtk3 等）在当前开发环境已预装，下面的 apt 命令经 `apt-get install --dry-run` 验证过包名：

```bash
# 1. Rust（官方安装器，装到用户目录）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Node.js 22（用 nvm 或系统包管理器均可，本机为 Node 22）

# 3. Tauri 在 Linux 上的系统依赖（Debian/Ubuntu 包名）
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# 4. 前端依赖（在仓库根目录执行）
npm install
```

## 怎么启动（看到桌面窗口）

在仓库根目录执行：

```bash
npm run tauri dev
```

第一次会编译几分钟，之后弹出标题为「像素竞技场」的桌面窗口，窗口里显示经 IPC 从 Rust 核心库取回的版本号，就说明三层（前端 → IPC → Rust 核心库）贯通了。

## 日常怎么用

- 桌面应用：`npm run tauri dev` 启动开发窗口（正式安装包在后续里程碑提供）。
- 跑分组（标签页）：点「＋ 新建跑分组」建一个标签页；**单击**标签切换，**双击**标签名重命名，点标签上的 **×** 关闭。
- 评测轮：标签页下方一行是组内评测轮，点「＋ 新建评测轮」添加；**单击**切换轮次，**双击**改名，点 **×** 删除。
- 自动保存：所有改动立即保存，退出应用再打开，跑分组与评测轮原样恢复（保存位置见下方「工作区文件在哪」）。
- 对比查看器：评测轮里选好原图与跑分图后，结果表上方出现「对比查看器」。用「左右分屏 / 滑动对比」按钮切换模式，下拉框选择要对比的跑分图；**滚轮**以光标为中心缩放，**按住拖动**平移画面，**双击**复位到整图，滑动模式下**拖动白色分割线**（带 ⟷ 把手）可左右扫动对比。
- 一站式跑分（完整编码阶梯）：评测轮里只选一张原图，点绿色描边的「一站式跑分」按钮，工具按按钮下方的勾选自动生成跑分图并自动跑分——格式（JPEG / WebP / AVIF / JPEG XL）、质量档（60 / 75 / 90）与无损组（PNG / 无损 WebP / 无损 JXL）都可自由勾选，默认全开共 15 份。进度逐项亮在窗口右上角状态栏；生成失败会有中文提示，已成功的项照常进入结果表。编码器首次使用会自动下载（下载进度即状态栏提示，之后离线可用）。AVIF / JPEG XL 产物在对比查看器里显示的是工具自动生成的 PNG 代片（画面与产物解码一致）。
- 视频跑分：评测轮里的「视频跑分」区块与图片互不干扰——「选择原视频」定基准，「添加跑分视频」多选已压缩产物，「开始视频跑分」逐对出结果（VMAF / PSNR / SSIM / 耗时）。首次点跑分会先自动下载 ffmpeg（约 40MB，下载进度显示在顶部状态栏，之后直接复用）；VMAF 越接近 100 越好，视频 SSIM 是 ffmpeg 口径，与图片 SSIM 数值不可直接比较。视频跑分依赖的 ffmpeg 存放在应用数据目录的 `tools/` 文件夹（Linux 示例：`~/.local/share/io.github.boxmiao007.pixelarena/tools/`），一站式下载的各编码器也在同一位置。
- 命令行批量跑分（外部导入模式）：选好一张原图和几张已压缩的跑分图后，执行
  `cargo run -p pixel-arena-cli -- score --reference 原图.png --candidates 跑分图1.jpg 跑分图2.webp`，
  就得到一张 CSV 指标表（PSNR、SSIM、MS-SSIM、Butteraugli、SSIMULACRA2、文件大小、体积比），
  可存成文件或贴进表格；加 `--format json` 则输出 JSON。指标口径：MS-SSIM 越接近 1 越好；
  Butteraugli 是距离分，0 表示完全一致、约 1.0 是刚好可察觉；SSIMULACRA2 是质量分，
  100 表示完全一致。进度与错误提示是简体中文，出错时按提示处理即可
  （支持的图片格式：PNG/JPEG/WebP）。

## 工作区文件在哪

跑分组与评测轮保存在应用数据目录下的 `workspace.json`：

- Linux：`~/.local/share/io.github.boxmiao007.pixelarena/workspace.json`
- Windows：`%APPDATA%\io.github.boxmiao007.pixelarena\workspace.json`
- macOS：`~/Library/Application Support/io.github.boxmiao007.pixelarena/workspace.json`

首次启动还没有这个文件，属正常现象，新建跑分组后即生成。

## 验证检查（改完代码跑这四条）

```bash
cargo test --workspace        # Rust 单元测试
npm run typecheck             # 前端类型检查
npm test                      # 前端单测（对比查看器视口状态模块）
cargo run -p pixel-arena-cli -- --version   # CLI 冒烟，应输出核心库版本号
```
