# Agent 开发约定

本文件是在本仓库工作的 AI agent 的工作契约。维护者不写代码、只提需求和验收,实现、验证、文档、提交均由 agent 完成。用户全局规则继续生效,本文件只写项目特有约定;两者冲突时,更具体的本文件优先。

## 项目是什么

用户原话（2026-10-04）：

> 一个多标签页评测工作台，以「评测」为主，「编码」为辅。用来对比不同图片/视频编码格式的画质和压缩效率。
>
> 每个标签页是一个独立的跑分组，互不干扰。可以新建、关闭、重命名标签页，每个标签页可以单独命名（比如「人像测试」「风景测试」）。
>
> 每个标签页内部：图片对比查看器（默认就有，核心功能）、跑分结果区（表格/排名）、操作区（选原图、选跑分图、触发跑分）。
>
> 图片对比查看器支持：左右分屏（主力，同步缩放平移）、滑动对比（可拖动分割线）、多视图对比（2x2 / 3x3 网格，多图同步缩放平移，每格可独立选图）、叠加对比（半透明）、差异图（高亮差异区域）、切换查看（原图/跑分图闪烁切换）。不需要上下分屏。
>
> 两种工作模式：外部导入模式（选一张原图作为基准，再选若干张跑分图——已用其他工具压好，工具跑分并对比）；一站式模式（选一张原图，工具自动用多种格式压缩，再自动跑分）。
>
> 最终形态：双击打开一个桌面窗口就能用；支持多标签页并行工作；CLI 用一行命令就能批量跑；在 Windows / Linux / macOS 上都能跑。必须是桌面原生程序，不要在浏览器里操作。

开发环境：WSL 里开发，日常在 Windows 上使用。需求背景与待拍板分叉见 `docs/requirements.md`。

## 协作模式

- 用户的话按"需求与验收期望"理解,不是技术指令;技术选型、实现细节、文件组织由 agent 决定。
- 方案不唯一且影响后续走向(技术栈、数据模型、外部服务、付费依赖)时,用简体中文给 2~3 个带取舍的选项让用户选;能安全推断的直接做,做完说明选了什么、为什么。
- 不问只有程序员才能答的技术判断题;确需用户拍板时,一次问清并附默认建议。

## 完成定义(每次交付前逐项核对)

1. 验证门全部通过:依次实测 `cargo test --workspace`(Rust 单测)→ `npm run typecheck`(前端类型检查)→ `npm test`(前端单测,对比查看器视口模块)→ `cargo run -p pixel-arena-cli -- --version`(CLI 冒烟,应输出核心库版本号);涉及界面的改动另附桌面窗口截图。命令须实测通过后才能作为验证门,没实测过的命令不得写入。
2. 功能实际跑通:能启动的自测核心路径;涉及界面或输出的改动,附截图或运行结果作为交付证据。
3. 交付说明讲给不写代码的人听:做了什么、怎么看到结果(地址/命令/截图)、有什么限制和后续建议;没把握或未完成的部分明说,不藏在细节里。

## 提交与推送

- 仓库约定优先:涉及版本、锁文件、发布、提交格式等事项,先查本仓库是否已有明确约定,有则从其约定。
- 自动提交:每个需求完成并验证通过后,agent 自行 git commit,无需逐次确认。
- 不自动推送:用户说「推」才推到 origin。
- 提交粒度:独立功能、缺陷修复或重构分别提交,避免无关改动混入同一个提交;提交前检查暂存内容,确保只含本次任务明确产生且经过检查的改动。
- 提交信息用 Conventional Commits:`<类型>[(scope)]: <一句话说明>`,类型常用 `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `ci` / `build` / `chore`,其余类型同样合法。破坏性改动在类型后加 `!`(如 `feat!:`),或在该提交的 footer 里写 `BREAKING CHANGE: <说明>`。这条格式是版本号机械递增的前提,不要随意破例。
- 密钥、凭据等敏感内容一律不提交;`.env`、`*.pem`、`*.key` 等本地凭据产物,以及新增的构建产物、本地环境文件类型,在第一次提交前先写进 `.gitignore`(不含真实敏感值的 `.env.example` 等样例除外)。发现疑似敏感内容或无法确认安全性时,说明文件路径并停止提交,交由用户决定;不得为完成提交绕过 Git 钩子或其他安全检查。

## 版本与发布

本项目遵循 SemVer 2.0.0，标签格式 `vX.Y.Z`。递增由当前版本阶段与 Commit 类型机械决定：

- `BREAKING CHANGE:` footer，或任意类型携带 `!`（如 `feat!:`、`fix!:`、`refactor!:`）→ 升 MAJOR；
- `feat:` → 升 MINOR；
- 其余类型一律升 PATCH（如 `fix:`、`perf:`、`docs:`、`refactor:`、`chore:`、`test:`、`ci:`、`build:`）；
- 处于 `0.y.z` 阶段时，凡按上述规则应升 MAJOR 的，改为升 MINOR；
- 无法机械判定时，暂停自动决策，列出候选版本号及理由，请用户选择。

递增依据上一个 `vX.Y.Z` 标签到 HEAD 之间的提交；仓库还没有任何 `vX.Y.Z` 标签时，首个发布为 `0.1.0`。

发布流程：

1. 更新承载版本号的文件：`Cargo.toml` 的 `[workspace.package] version` 与 `src-tauri/tauri.conf.json` 的 `version`，两处必须一致。
2. 确认版本号改动已在提交中（未提交时先 `git commit -m "chore(release): vX.Y.Z"`），再创建本地 annotated tag：`git tag -a vX.Y.Z -m "Release vX.Y.Z"`，**不推送**。
3. 停下并等待用户批准（发布闸门：未获批准不得推送 tag、不得执行 `gh release create`），报告候选版本号与递增理由。批准前不再产生新提交；若已产生，批准后先删掉本地 tag 重打（未推送的 tag 可以删），再推送。
4. 获批准后推送 tag 并执行 `gh release create`，Release 正文写清本次版本号与变更分类（breaking / feature / fix）；`gh` 未认证或仓库无 Release 权限时，只推送 tag 并说明原因，不阻断发布。

验证：宣称发布完成须附 `git tag -l vX.Y.Z` 与 `gh release view vX.Y.Z` 实际输出，并确认版本号文件与 tag 一致。已推送的 tag 不可修改。

## 知识沉淀(保证任何新会话都能接手)

- 全新环境依赖安装命令见 README「环境搭建(一次性)」:系统依赖(webkit2gtk-4.1、gtk3 等)已在当前环境预装,apt 命令经 `apt-get install --dry-run` 验证包名可解析;Rust/Node 为官方安装器标准流程;`npm install` 实测通过。步骤变化时同步更新。
- 重大技术决策(选型、数据模型、外部服务)在 `docs/decisions.md` 记一行:日期、决策、为什么、放弃了什么。技术栈选型是第一条要记的决策。
- README 面向用户维护:项目是什么、怎么启动、日常怎么用,保持非程序员能看懂。

## Agent skills

### Issue tracker

Issue 记在 GitHub Issues(远程仓库 BoxMiao007/pixel-arena 已创建),用 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个默认标签:needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局:根目录 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.

### Tauri v2 开发

GUI 技术栈为 Tauri 2(见 `docs/adr/0001-tauri-rust-core.md`)。凡涉及 `src-tauri/`、`tauri.conf.json`、IPC 命令、capabilities 权限、sidecar 外部程序或桌面打包的改动,先加载 `tauri-v2` skill(`.agents/skills/tauri-v2`),按其模式与排错清单操作;skill 中的移动端部分与本仓库无关(仅做桌面三端)。
