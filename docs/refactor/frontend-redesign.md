# 前端重构设计契约（refactor/frontend-rebuild）

本文是本次前端完全重构的共同基准：信息架构、视觉令牌、组件原语、渲染与状态约定、文件归属。
所有参与实现的 agent 必须先读本文，再读自己负责域的 `docs/refactor/<域>-spec.md`。

## 1. 目标与非目标

目标：

- 换掉「一条长页面从上滚到下」的形态，改成桌面工具惯用的四区布局：左侧跑分组栏、中部舞台、右侧检视器、底部结果坞。
- 交互以「图片对比」为主角：舞台常驻、可沉浸全屏，结果坞可折叠；常用动作都有键盘入口；文件支持从资源管理器直接拖入。
- 视觉体系重做：石墨仪表盘 + 琥珀信号色的深浅双主题，0.5px 发丝线、同心圆角、三档字号、克制的圆角与阴影。
- 逻辑重做：单向数据流（IPC → 状态 → 分区渲染），分区挂载一次、按需 `update()`，不再整页 `replaceChildren()`；忙状态、错误、进度有统一归宿。

非目标：

- 不改 Rust 端与 IPC 命令名、参数、返回结构（核心域由 `src/core/ipc.ts` 收口，功能域命令收口在各域 `ipc.ts`）。
- 不引入 UI 框架、组件库、CSS 框架、动画库。保持零新增运行时依赖。
- 不改数据模型（`workspace.json` 字段不变）；新增的纯界面偏好（面板宽度、折叠态、视图模式）只进 localStorage。
- 不改命令行、导出文件格式、跑分算法。

## 2. 信息架构与布局

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 像素竞技场   人像测试 / 评测轮 2                              状态   ?   设置  │ 44 顶部栏
├────────────┬────────────────────────────────────────────────┬────────────────┤
│ 跑分组 3   │ 评测轮 [轮 1][轮 2][+]                导出 ▾    │ 检视器          │ 44 工作栏
│            ├────────────────────────────────────────────────┤  原图           │
│ ▣ 人像测试 │                                                │  跑分图 3       │
│ ▣ 风景     │                舞台（对比查看器）               │  跑分           │
│ ▣ 视频     │                                                │  编码阶梯       │
│            ├────────────────────────────────────────────────┤                │
│ + 新建     │ 结果   BD-rate   视频                 收起 ⌄   │                │ 结果坞
│            │  评分表…                                        │                │
└────────────┴────────────────────────────────────────────────┴────────────────┘
```

- 顶部栏 44px：品牌名、当前分组 / 轮次面包屑（双击或 F2 改名）、状态文本（可点开全文）、快捷键帮助、设置。
- 左栏 208px：分组列表（类型图标 + 名称 + 轮数），当前项为填充底；右键菜单（重命名 / 关闭）；关闭有内容的组先确认。底部「新建跑分组」弹出图片 / 视频二选一，选完在弹窗里填名字（预填「跑分组 N」，Enter 确认）。
- 工作栏 44px：轮次 chips（单击切换、双击改名、右键菜单删除并确认）+ 新建轮；右侧导出菜单。
- 舞台：图片组为对比查看器（工具栏 + 画布 + 胶片条）；视频组为视频对比（画面 + 时间轴）。无内容时是引导式空态（选原图 / 拖入文件）。支持沉浸模式（隐藏左栏、检视器与结果坞，工作栏保留以便切轮与导出；Esc 退出）。
- 检视器 328px：可滚动分区，分区标题可折叠（折叠态按分区持久）。图片组分区：原图、跑分图、跑分、编码阶梯（参数变体的入口在「跑分图」分区：右键已跑分的图「高级选项」，或「＋ 新建参数变体」）。视频组分区：原视频、跑分视频、视频跑分。
- 结果坞：默认高度 248px，可拖上边缘调整（140–560px，且不超过窗口高度的 72%），可折叠；页签为 评分表 / BD-rate（视频组为 视频指标）。表格内部滚动，不推动外层。
- 空工作区：舞台整块空态，给出「新建图片跑分组」「新建视频跑分组」两个入口与一句拖放提示。

## 3. 交互契约

### 3.1 鼠标

- 单击切换分组 / 轮次；双击名称就地改名；右键出上下文菜单（重命名 / 关闭 / 删除）。
- 结果表：点表头排序，再点反向；行悬停高亮；失败原因可在状态列就地展开。
- 查看器：滚轮以光标为锚点缩放、拖拽平移、双击复位；分割线拖动对比；模式条切换视图。
- 右键：跑分图列表里**已跑分**的行右键出「高级选项」（复制一份带参数副本的新变体并打开调参弹窗）；未跑分 / 失败的行不给菜单。
- 拖放：从资源管理器拖文件到「原图」区 → 设为原图；拖到「跑分图」区或舞台 → 追加跑分图；拖到视频区分同理。拖入时为整个落区显示描边高亮，无效类型给出中文提示。

### 3.2 键盘（全局，输入框内不拦截）

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+N` / `Ctrl+Shift+N` | 新建评测轮 / 新建跑分组 |
| `Ctrl+O` / `Ctrl+Shift+O` | 选原图 / 追加跑分图（视频组为原视频 / 跑分视频） |
| `Ctrl+Enter` | 开始跑分（视频组为视频跑分） |
| `Ctrl+E` | 打开导出菜单 |
| `Ctrl+,` | 设置 |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+J` | 折叠左栏 / 检视器 / 结果坞 |
| `F` 或 `Ctrl+Shift+F` | 沉浸模式开关 |
| `1`–`6` | 切换查看模式（分屏 / 滑动 / 叠加 / 差异 / 闪烁 / 多视图） |
| `空格` | 闪烁对比开关（闪烁模式） |
| `+` / `-` / `0` | 放大 / 缩小 / 复位到适应 |
| `?` | 快捷键帮助 |
| `Esc` | 关闭浮层；无浮层时退出沉浸模式 |
| `Ctrl+1`…`Ctrl+9` | 切换到第 N 个跑分组 |

### 3.3 渐进披露

- 检视器按「先选图 → 再跑分 → 想自动时展开编码阶梯 → 需要时进高级」的顺序排列；编码阶梯与高级默认折叠，跑分图或原图缺失时给出下一步引导而不是灰一片按钮。
- 一站式只露出一个模式分段控制 + 一个主参数（质量拉杆或目标大小）+ 格式胶囊；「单点模式」「无损组」放在该分区内的次级行。
- 参数变体不走独立列表、不建独立轮：右键「高级选项」复制并调参，或「＋ 新建参数变体」；未生成的变体作为一行混在跑分图列表里（虚线边 + 未跑分徽章），生成后由产物行代表（「高级」角标）。

## 4. 视觉令牌

`src/styles/tokens.css` 是唯一真源，其它样式只引用变量，不写字面色值（透明遮罩与纯黑/纯白例外）。

深色（默认，`data-theme="dark"`）：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--surface-0` | `#141619` | 窗口底 |
| `--surface-1` | `#191c20` | 面板 / 栏 |
| `--surface-2` | `#1f2328` | 输入框、卡片、表格行 |
| `--surface-3` | `#272c32` | 悬停 |
| `--surface-4` | `#31373f` | 选中 / 按下 |
| `--line` | `rgba(255,255,255,.08)` | 发丝线 |
| `--line-strong` | `rgba(255,255,255,.16)` | 浮层边界、分隔强调 |
| `--text` / `--text-muted` / `--text-subtle` | `#e6e9ec` / `#9aa3ad` / `#6c7681` | 三档文字 |
| `--accent` / `--accent-hover` / `--accent-soft` | `#e9a13b` / `#f4b25a` / `rgba(233,161,59,.14)` | 琥珀信号色 |
| `--text-on-accent` | `#191205` | 琥珀底上的字 |
| `--ok` / `--danger` / `--danger-soft` / `--info` | `#58bf8c` / `#e4695f` / `rgba(228,105,95,.14)` / `#6fa8d6` | 语义色 |
| `--canvas` / `--canvas-checker` | `#222` / `#272727` | 图像判定用中性底 + 棋盘格 |
| `--shadow-pop` / `--shadow-modal` | 见代码 | 仅浮层与模态 |
| 焦点 | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` | 键盘焦点（不用 box-shadow 环，避免被祖先裁切） |

浅色（`data-theme="light"`）：底 `#f2f3f4`，面板 `#fafafa`，卡片 `#fff`，线 `rgba(20,22,25,.12)`（强调 `.22`），字 `#191c20` / `#545d67` / `#6b737d`，琥珀压深为 `#9a5c0d`（白字对比达标），画布 `#c9c9c9`。语义软底色与遮罩收起为 `--ok-soft` / `--info-soft` / `--scrim` / `--scrim-soft` 令牌；非令牌 CSS 只允许纯黑/纯白 rgba 叠层（由 design-guards 断言）。

几何与字号：

- 字号只有三档：`--fs-meta: 12px`、`--fs-body: 13px`、`--fs-title: 15px`。禁止 12px 以下，禁止第四档。
- 圆角只有四档：`--r-xs: 2px`、`--r-sm: 4px`、`--r-md: 6px`、`--r-lg: 10px`。嵌套时按 `R_inner = max(0, R_outer - padding)` 收紧。
- 边框统一 `0.5px solid var(--line)`（高亮态 `--line-strong`），不用 1px 实线。
- 间距 4 的倍数：`--s-1..--s-8`。面板内边距 12px，控件高 `--control-h: 30px`（小号 `--control-h-sm: 26px`）。
- 阴影只给浮层/模态；卡片、按钮、栏一律无阴影，用底色与发丝线分层。
- 数字一律 `font-variant-numeric: tabular-nums`；日期/数字格式化走 `Intl`。
- 禁止：中点「·」分隔符、卡片左边缘彩条、每个卡片一段解释性副标题、全大写 eyebrow、`transition: all`、`outline: none` 无替代、纯装饰性无限动效。
- 图标：`src/ui/icons.ts` 的 16px 线性图标（stroke 1.5），全部 `aria-hidden`，可点按钮必须带 `aria-label`。

字体栈（单一家族，跨平台回退）：

```
"Segoe UI Variable Text", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif
```

等宽字体仅用于路径与原始日志：`"Cascadia Mono", Consolas, "SF Mono", monospace`（12px）。

## 5. 动效策略

- 默认开启动效，跟随操作系统的「减少动态效果」只收敛**装饰性/循环**动效（脉冲、闪动、渐隐），功能性状态反馈（按钮按下、面板开合、toast、进度）保留。
  两处 skill 对此口径相反（frontend-animation-patterns 要求忽略系统设置，desktop-agent-ui 与 web-design-guidelines 要求尊重），这里取交集：功能反馈不砍，装饰动效砍。该取舍记入 `docs/decisions.md`。
- 只动 `transform` / `opacity` / `background-color` / `border-color` / `width`（面板开合），时长 90–220ms，缓动 `cubic-bezier(.2,.8,.2,1)`；退出比进入快。
- 面板开合、结果坞折叠 160ms；模态 160ms 透明度 + 2px 位移；toast 160ms；模式切换 120ms 透明度。
- 跑分进行中的进度是真实进度（IPC Channel），不做假动画；未知进度用不确定态（文案 + 循环条），完成即停。

## 6. 组件原语（`src/ui/`）

统一 `el(tag, props, ...children)` 建 DOM（`src/ui/dom.ts`），禁止用 `innerHTML` 拼接用户数据。

```ts
// primitives.ts
button({ label, icon?, variant?: 'primary'|'secondary'|'quiet'|'danger', size?: 'sm'|'md', title?, ariaLabel?, disabled?, onClick? }): HTMLButtonElement
iconButton({ icon, label, variant?, size?, disabled?, onClick? }): HTMLButtonElement   // label 必填，落到 aria-label
chip({ label, active?, title?, onClick?, onRemove?, disabled? }): HTMLElement
segmented({ items: {id,label,icon?}[], value, onChange, ariaLabel }): HTMLElement       // role=radiogroup，方向键切换
field({ label, control, hint?, error? }): HTMLElement                                  // <label> 包控件
switchField({ label, checked, onChange, hint? }): { node, button, setChecked }                          // role=switch
sliderField({ label, min, max, step, value, onInput, format? }): { node, input, setValue }
selectField({ label, value, choices, onChange }): HTMLElement
textField({ label, value, placeholder?, onCommit, type?, mono?, hint? }): { node, input, setValue }
section({ id?, title, collapsible?, open?, onToggle?, actions?, className? }, ...children): { node, body, setTitle }
emptyState({ title, hint?, actions? }): HTMLElement
badge({ text, kind: 'neutral'|'accent'|'ok'|'danger'|'info', title? }): HTMLElement
progressBar({ label? }): { node, set(value, max, label?), setIndeterminate(label) }
toolbar(...children): HTMLElement
spinner(): HTMLElement
```

```ts
// overlay.ts
openModal({ title, body, footer?, width?, onClose? }): { close(), setBody(node), setFooter(node) }  // 焦点捕获、Esc、点遮罩关闭、焦点还原
openMenu(anchor, items: { label, icon?, danger?, disabled?, onSelect }[], opts?): { close() }        // role=menu，方向键/Home/End/Esc
confirm({ title, message, confirmLabel, cancelLabel?, danger? }): Promise<boolean>
prompt({ title, label, value, placeholder?, confirmLabel }): Promise<string | null>
openPopover(anchor, content, { align? }): { close() }
toast(message, kind?: 'info'|'ok'|'danger', action?: { label, onSelect })
```

约定：

- 所有可聚焦元素有 `:focus-visible` 焦点环；模态与菜单做焦点捕获与还原。
- 破坏性动作（关闭有内容的分组 / 删除有跑分结果的轮）必须 `confirm`。
- 表单错误写在控件旁，不用 toast 代替。

## 7. 架构与数据流

```
Tauri IPC ──> core/ipc.ts（唯一 invoke 收口，带类型）
                 │
                 ▼
            core/store.ts（单一状态源 + 订阅通知）
                 │
   ┌─────────────┼───────────────┬───────────────┬─────────────┐
   ▼             ▼               ▼               ▼             ▼
 shell 分区    inspector 分区   dock 页签       stage 视图    overlay 浮层
 （挂载一次，update() 增量更新，DOM 不整体重建）
```

- `store.state`：`workspace`、`settings`、`ffmpeg`、`busy`（进行中的长任务表）、`status`（状态栏文本）、`error`。
- `store.setWorkspace(ws)`、`store.setSettings(s)`、`store.setFfmpeg(f)`、`store.beginBusy(id, label)` / `store.updateBusy(id, patch)` / `store.endBusy(id)`、`store.setStatus(text, isError?)`、`store.subscribe(fn)`。
- `core/actions.ts`：分组/轮次 CRUD、文件对话框、原图/跑分图增删、文件冲突询问等跨域动作。
- 各功能域自己的动作放各自目录（如 `features/encoding/scoring.ts`、`features/results/export.ts`、`features/video/actions.ts`）。
- 任何 IPC 变更都返回整份 `Workspace`，统一走 `store.setWorkspace()`；不做前端乐观更新（后端是唯一真源）。
- 长任务：`beginBusy` 时写 `{ label, detail?, running:Set<path> }`，进度回调用 `updateBusy({ completed, total, detail })`（`completed/total` 是结构化真值，`detail` 只放人类可读文案，界面不得反解 `detail`）；结束时 `endBusy`。
- 忙时置灰所有会改工作区内容或写文件的入口（新建/重命名/关闭/删除、增删跑分项、跑分、导出），并给出原因；**导航（切组、切轮）与设置保存不置灰**——它们只改激活位置/独立设置文件，长任务期间仍然安全。
- 按轮隔离的界面状态（排序、一站式参数、查看器逐模式选图、滚动位置）以轮 id 为键存在模块内 Map，切轮不串扰、不持久化。
- 纯界面偏好（左栏/检视器折叠、结果坞高度、分区折叠、查看器模式、主题以外）存 `localStorage`，键前缀 `pixel-arena.ui.`；`settings.recordState === false` 时不读写。

### 7.1 注册契约（`src/shell/registry.ts`）

功能域不直接改外壳代码，只注册：

```ts
interface ViewCtx { group: Group; round: Round }

interface StageView {
  id: string;
  label: string;
  kinds: GroupKind[];
  mount(host: HTMLElement, ctx: ViewCtx): { update(): void; destroy(): void };
}

interface PanelSection {
  id: string;
  title: string;
  order: number;
  kinds: GroupKind[];
  collapsible?: boolean;
  mount(host: HTMLElement, ctx: ViewCtx): { update(): void; destroy(): void };
}

interface DockTab {
  id: string;
  label: string;
  order: number;
  kinds: GroupKind[];
  mount(host: HTMLElement, ctx: ViewCtx): { update(): void; destroy(): void };
}

registerStageView(view) / registerPanelSection(section) / registerDockTab(tab)
```

- 外壳在「分组或轮次变化」时销毁并重新 `mount`；状态变化时只调 `update()`。
- `ctx` 是 mount 时的快照：store 每次整份替换 workspace，同轮内的增删改不会反映到挂载时
  捕获的 `ctx.round`。分区 `update()` 读轮数据必须经 store 重取（编码域 `sections/common.ts`
  的 `liveRoundOf`、结果坞 `liveRound`、视频域 `videoRound` 同一口径）；长动作入口（整轮跑分 /
  编码阶梯 / 大小搜索）也要先按 id 重取再校验，否则会拿旧快照误拒或误放行。
- 五个注册表（舞台视图/分区/页签/命令/键位）统一「同 id 覆盖」语义：重复注册不报错也不静默丢弃，后注册者生效（热更新与测试替身都靠这个）。
- 命令 id 约定（快捷键与外壳按钮按此调用，功能域注册时必须同名）：`pick-reference-image` / `pick-reference-video`、`pick-candidates-image` / `pick-candidates-video`、`run-score-image` / `run-score-video`、`rerun-changed-image`、`generate-ladder-image`、`export-menu`、`open-settings`、`open-help`。
- 舞台键位用 `registerKeyBinding({ id, keys, kinds?, when?, run })` 注册（外壳统一监听 keydown，输入框/浮层打开时不派发）。
- 拖放落区用 `registerDropTarget(host, { id, accept, hint, onDrop, disabled? })`（`src/shell/file-drop.ts`），外壳负责把系统文件拖放路由到指针下的落区。
- `update()` 必须幂等，且不得重建正在编辑的输入框（用 `paint(host, key, build)` 做结构键保护，见 `ui/dom.ts`）。
- 舞台视图同一时刻只有一个；检视器分区与结果坞页签按 `order` 排列，按 `kinds` 过滤。

### 7.2 目录与文件归属

```
index.html                      lead
src/main.ts                     lead（启动装配）
src/core/model.ts               lead（数据模型与派生）
src/core/ipc.ts                 lead（IPC 收口）
src/core/store.ts               lead（状态与订阅）
src/core/actions.ts             lead（跨域动作）
src/core/settings.ts            lead（设置模型、读写、主题）
src/core/theme.ts               lead
src/core/ffmpeg.ts              lead（FFmpeg 状态）
src/core/format.ts              lead（大小/比率/指标/时间格式化）
src/core/util.ts                lead（文件名、截断、复制、id）
src/core/ui-state.ts            lead（按轮界面状态 + 界面偏好持久化）
src/ui/dom.ts|icons.ts|primitives.ts|overlay.ts|toast.ts   lead
src/shell/*.ts                  lead（外壳、快捷键、拖放、注册表）
src/styles/tokens.css|base.css|components.css|shell.css     lead
src/features/viewer/**          viewer
src/styles/viewer.css           viewer
src/features/results/**         results
src/styles/results.css          results
src/features/encoding/**        encoding
src/styles/encoding.css|sources.css                        encoding
src/features/video/**           video
src/styles/video.css            video
src/features/settings/**        settings
src/styles/settings.css         settings
```

各功能域不得修改别人目录下的文件；需要共享的东西找 lead 加进 `core/` 或 `ui/`。

## 8. 验收门（每次交付）

1. `cargo test --workspace`
2. `npm run typecheck`
3. `npm test`（逻辑单测，保持纯函数、无 DOM 依赖的既有风格）
4. `cargo run -p pixel-arena-cli -- --version`
5. 桌面窗口真实截图（主界面、查看器各模式、设置、模态、空态、深/浅主题）
6. 手工路径：新建组/轮 → 拖入原图与跑分图 → 跑分 → 排序 → 导出 → 重启恢复
7. 手工路径（参数变体）：右键已跑分的图 →「高级选项」→ 改参数 →「完成」→ 列表出现待生成变体 →「开始跑分」→ 新图进**当前轮**且带「高级」角标；确认评测轮数量不变
