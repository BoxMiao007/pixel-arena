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
- 所有改动（含跑分结果）自动保存，重启应用后完整恢复。

图片对比查看器（分屏 / 滑动 / 多视图等）按里程碑逐步加入。

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
- 命令行批量跑分（外部导入模式）：选好一张原图和几张已压缩的跑分图后，执行
  `cargo run -p pixel-arena-cli -- score --reference 原图.png --candidates 跑分图1.jpg 跑分图2.webp`，
  就得到一张 CSV 指标表（PSNR、SSIM、文件大小、体积比），可存成文件或贴进表格；
  加 `--format json` 则输出 JSON。进度与错误提示是简体中文，出错时按提示处理即可
  （支持的图片格式：PNG/JPEG/WebP）。

## 工作区文件在哪

跑分组与评测轮保存在应用数据目录下的 `workspace.json`：

- Linux：`~/.local/share/io.github.boxmiao007.pixelarena/workspace.json`
- Windows：`%APPDATA%\io.github.boxmiao007.pixelarena\workspace.json`
- macOS：`~/Library/Application Support/io.github.boxmiao007.pixelarena/workspace.json`

首次启动还没有这个文件，属正常现象，新建跑分组后即生成。

## 验证检查（改完代码跑这三条）

```bash
cargo test --workspace        # Rust 单元测试
npm run typecheck             # 前端类型检查
cargo run -p pixel-arena-cli -- --version   # CLI 冒烟，应输出核心库版本号
```
