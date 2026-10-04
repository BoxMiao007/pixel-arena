<!-- vibe-coding-declaration:begin -->
> [!IMPORTANT]
> 本仓库由 AI 开发与维护，所有代码变更均由 AI 执行。
<!-- vibe-coding-declaration:end -->

# pixel-arena（像素竞技场）

## 这是什么

一个多标签页的编码评测工作台：以「评测」为主、「编码」为辅，用来对比不同图片/视频编码格式的画质和压缩效率。日常在 Windows 上当桌面程序用，开发在 WSL 里进行。

当前进度：技术栈骨架已贯通（Cargo 工作区 + Tauri 2 桌面窗口 + Rust 核心库 + CLI 空壳），能弹出真实桌面窗口并显示核心库版本。对比查看器、跑分等功能按里程碑逐步加入。

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
- 命令行：`cargo run -p pixel-arena-cli -- --version` 查看版本；批量跑分（score 子命令）在后续里程碑实现。

## 验证检查（改完代码跑这三条）

```bash
cargo test --workspace        # Rust 单元测试
npm run typecheck             # 前端类型检查
cargo run -p pixel-arena-cli -- --version   # CLI 冒烟，应输出核心库版本号
```
