# 编码与来源域规格（encoding）

> 本文件是 `docs/refactor/frontend-redesign.md` 之下、由 **encoding** 域负责的落地规格。
> 覆盖：右侧检视器里的**来源（原图 / 跑分图）**、**跑分触发与进度**、**编码阶梯（一站式）**、
> **高级（条目队列 + 参数编辑）**，以及它们的纯逻辑、IPC 契约、测试守护与风险。
>
> 读法：第 1 节是「现状事实」（写过一次就不再重复查代码）；第 2 节定下哪些能原样搬、
> 哪些必须重写；第 3 节是问题清单；第 4 节是提案（按价值排序，≤6 条）；第 5 节是坑。
>
> 事实来源：`src/main.ts`、`src/onestop.ts`、`src/advanced.ts`、`src/advanced-ui.ts`、
> `src/encoder-card.ts`、`src/image-queue.ts`、`src/image-queue-run.ts`、
> `src/image-queue-runtime.ts`、`src/image-queue-panel.ts`、`src/image-entry-editor.ts`、
> `src/conflict.ts`、`src/pills.ts`、`src/style.css`、`src-tauri/src/lib.rs`（只读核对）。

---

## 0. 范围、注册契约与文件归属

对齐 `frontend-redesign.md` §7.2：本域只写 `src/features/encoding/**`、
`src/styles/encoding.css`、`src/styles/sources.css`。其余文件（`core/`、`ui/`、`shell/`）由 lead 提供。

### 0.1 检视器分区（PanelSection）

图片组五个分区，`kinds: ['image']`。注意 `PanelSection` 接口本身没有 `collapsible` 字段——折叠由
分区内部用 `ui/primitives.section({ collapsible })` 实现，展开态经 `getPref/setPref` 持久。

| 分区 id | 标题 | order | 现状来源 | 归属 |
| --- | --- | --- | --- | --- |
| `reference` | 原图 | 10 | `renderImageGroupContent` 的 `pickReference` + `pill-reference` 槽 | encoding（`sources.css`） |
| `candidates` | 跑分图 | 20 | 「添加跑分图」+ 已选跑分图胶囊列 | encoding（`sources.css`） |
| `score` | 跑分 | 30 | 「开始跑分」+「重跑改过的」+ 行内状态 + 进度 | encoding |
| `ladder` | 编码阶梯 | 40 | `buildOnestopControls` | encoding |
| `advanced` | 高级 | 50 | 「新建评测轮 → 高级创建…」图片分支（条目队列） | encoding |

视频组的「原视频 / 跑分视频 / 视频跑分」归 video 域，但其中**编码器卡**（`renderEncoderCard`）
由本域提供的共享实现消费（见 2.4，需 lead 裁决归属）。

本域同时注册外壳命令（`shell/registry.ts` 的 `registerCommand`），供快捷键与按钮共用：

| 命令 id | 行为 | 快捷键 |
| --- | --- | --- |
| `sources:pick-reference` | 选/换原图 | `Ctrl+O` |
| `sources:pick-candidates` | 追加跑分图 | `Ctrl+Shift+O` |
| `score:run` | 整轮全量跑分（`enabled: 有原图 && 有跑分图 && !isBusy()`） | `Ctrl+Enter` |
| `encoding:generate` | 一站式生成并跑分 | — |
| `encoding:rerun-changed` | 只跑改过的（N 张） | — |

### 0.2 归属边界

- 本域**不**在组件里裸调 `invoke`：工作区类命令走 `core/ipc.ts` 的 `ipc.*`；本域专有命令
  （`onestop_*` / `advanced_*` / `image_identities`）按 `core/ipc.ts` 头注释的约定收口在
  **本域自己的 `features/encoding/ipc.ts`**（参数形状与返回类型集中一处）。
- 工作区写入统一 `runWorkspace(...)` 或 `ipc.xxx → setWorkspace(...)`，**不做乐观更新**。
- 跨域动作（选文件对话框、最近目录、原图/跑分图增删、建轮/删轮）复用 `core/actions.ts`；
  本域不复制第二份对话框接线。
- 拖放落区：本域在每个分区 host 上挂 `dragover/drop`，交给本域 `acceptPaths(role, paths)`；
  若 shell 之后提供统一的拖放路由，再改为订阅。

### 0.3 已落地的脚手架（lead 已提供，直接消费）

| 能力 | 位置 | 本域用法 |
| --- | --- | --- |
| `el / frag / paint / invalidate / isTypingTarget` | `src/ui/dom.ts` | 所有 DOM 构建；`paint(host, key, build)` 保护正在编辑的输入框 |
| `button / iconButton / chip / segmented / field / textField / sliderField / switchField / selectField / section / emptyState / badge / progressBar / toolbar / spinner / metaRow` | `src/ui/primitives.ts` | `chip` 已带 `aria-pressed` + 真 `<button>` + `onRemove`；`progressBar` 有 `set()` 与 `setIndeterminate(label)`——正好对应 4.4 |
| `openModal / openMenu / openPopover / confirm / prompt` | `src/ui/overlay.ts` | 删除条目、冲突询问走 `confirm` / `openModal`（四选一用 `openModal` 自建按钮） |
| `getState / subscribe / setWorkspace / setStatus / beginBusy / updateBusy / endBusy / isBusy / isPathRunning` | `src/core/store.ts` | 忙状态与进度：`beginBusy('encode:<roundId>', '正在自动编码', paths)`、`updateBusy(id, { detail, running })` |
| `chooseReference / chooseCandidates / setRoundReference / addCandidates / removeCandidate / clearCandidates / createRound / deleteRound / pickFile / pickFiles / notePickedPath / IMAGE_FILTER / onGroupRemoved` | `src/core/actions.ts` | 直接复用；**注意** `addCandidates` 目前不带 `encodingParams`（见下） |
| `roundScoped / dropRoundScoped / getPref / setPref` | `src/core/ui-state.ts` | 一站式参数、阶梯选择、分区展开态（按轮 / 按偏好） |
| `registerPanelSection / registerCommand / runKindCommand` + `PanelSection{ id,title,order,kinds,mount(host,ctx):MountedView }` | `src/shell/registry.ts` | 本域 `index.ts` 注册 5 个分区 + 跑分/选图命令（`Ctrl+Enter` / `Ctrl+O` / `Ctrl+Shift+O`） |
| `--fs-* / --r-* / --s-* / --line / --surface-* / --accent / --ok / --danger` | `src/styles/tokens.css` | 只引用变量，不写字面色值 |

### 0.4 本域仍需 lead 补的三件事

1. **`actions.addCandidates` 需要 `encodingParams`**：一站式与条目队列必须把参数文本与路径成对写入
   （`ipc.roundAddCandidates` 已支持第 4 个可选参数，`actions` 层没透传）。要么扩参，要么本域直调
   `ipc.roundAddCandidates` + `setWorkspace`（推荐前者，保持一致状态栏文案）。
2. **拖放入口**：`shell/` 目前只有 `controller.ts` 与 `registry.ts`，没有统一的拖放路由；
   本域会自己在分区 host 上挂，若后续 lead 加 `shell/dragdrop.ts` 再切过去。
3. **无 Tooltip 原语**：编码器卡的参数说明目前只能落 `title`（或本域自建轻量 popover）。
   若要复用原 `ⓘ` 气泡（`settings-bubble` + `wireBubbleFlip`），需要 lead 给 `ui/` 版实现。

---

## 1. 现有行为清单

术语与数据：

- **图片条目**：一张原图 + 一整套编码器卡，`ImageEntry`；**仅会话态**（模块级 Map，按 `groupId` 键控）。
- **跑分快照**：该条目最近一次**成功**跑分的原图标识（path+size+mtime）+ 逐卡参数指纹/产物路径。
- **失败永远不算已跑分**：失败只进 `entry.failures`，不进快照。

### 1.1 来源：选原图

- **触发入口**：工具栏「选择原图 / 重选原图」（`pickReference`）；原图胶囊本体点击（同一动作）。
- **前置**：`activeRound()` 存在且 `scoring === false`；否则静默返回。
- **参数**：`open({ title: '选择原图', multiple: false, filters: [IMAGE_FILTER], defaultPath })`，
  `IMAGE_FILTER = png/jpg/jpeg/webp/avif/jxl`；`defaultPath = openDefaultPath(settings)`（`recordState` 门控）。
- **IPC**：`round_set_reference { groupId, roundId, path }` → `Workspace`（整份）。
- **成功反馈**：替换 `ws` → 整页 `render()` → 状态栏「已自动保存 hh:mm:ss」；原图胶囊换名。
- **失败反馈**：`apply` 捕获 → 状态栏红字「出错: …」；工作区不变。
- **副作用**：后端换原图会**清空该轮已有候选的指标**（体积比按新原图重算），磁盘产物不动。
- **持久化字段**：`Round.referencePath`（`referenceSize` 由后端回填/迁移）。
- **其它**：选完调 `notePickedPath` 写最近目录（`settings_save`，失败只 `console.warn`）。
- **守护测试**：`image-queue-panel.test.ts`（主界面分派 / deps 齐全）；
  `image-entry-editor.test.ts:554`（更换图片用单选对话框、目录走 `advanced_image_catalog`）。

### 1.2 来源：添加 / 移除跑分图

- **触发入口**：「添加跑分图」（`pickCandidates`）；胶囊 ×（`removeCandidate`）。
- **参数**：`open({ multiple: true, title: '添加跑分图（可多选）', filters: [IMAGE_FILTER], defaultPath })`；
  取消（`null`）或空数组不动工作区。
- **IPC**：`round_add_candidates { groupId, roundId, paths }`（**不传 `encodingParams`**——
  外部导入的参数用户自备，界面显示 —）；`round_remove_candidate { groupId, roundId, candidatePath }`。
- **成功反馈**：整页 `render()` + 自动保存状态；结果表/查看器只多（少）这一行。
- **失败反馈**：状态栏红字；胶囊 disabled（忙时不可点、× 也不响应）。
- **持久化字段**：`Round.candidates[]`：`path / fileSize / sizeRatio / metrics / encodingParams(null) / note(null) / error`。
- **守护测试**：`main-image-queue.test.ts`（胶囊 onClick 条件、× 只做移除、`stopPropagation` 在 `buildPill`）。

### 1.3 跑分：整轮全量

- **触发入口**：「开始跑分」（`startScoring`）——**唯一**整轮全量入口。
- **前置**：有原图 + 至少 1 张跑分图 + 非忙；否则按钮 disabled。
- **IPC**：`round_score_candidates { groupId, roundId, onProgress }`；**有子集时才写 `paths` 键**
  （待跑清单快照 `scoringPaths` 由前端设，Channel 只推状态栏数字）。
- **进度**：`Channel<{completed,total}>` → `setStatus('跑分中 N/M')`（**只更新状态栏，不 render**）。
- **成功反馈**：替换 `ws` → `render()` → 状态栏「跑分完成，共 N 张」；行内状态从
  「跑分中…」变「完成」，失败行「失败：原因」（`status-fail`）。
- **失败反馈**：IPC 抛错 → 状态栏「出错: …」，行内状态由 `finally` 清空（不会永久停在「跑分中…」）；
  单张失败不抛错，由后端写进行内 `error`。
- **并发**：后端按设置并发度（默认 half 核）并行，前端不控制。
- **持久化字段**：`CandidateImage.metrics / error / fileSize / sizeRatio`（后端写）。
- **守护测试**：`main-scoring.test.ts`（F1 行内状态自收口、F8 不传 `paths` 键）、
  `main-image-queue.test.ts`（`startScoring` 仍不带 `paths`）。

### 1.4 一站式：质量优先 / 大小优先

- **触发入口**：「一站式跑分」（`runOnestop`）；控件区 `buildOnestopControls` 只在
  `round.referencePath` 存在时挂载。
- **会话态**（按 `round.id` 键控，不持久化）：`mode('quality'|'size')`、`baseline(0–100, 默认 75)`、
  `targetBytes(默认 200KB)`、`unit('KB'|'MB')`、`singlePoint`、`selection{lossy[],lossless[]}`（默认全选）。
- **质量优先取点**：`onestop_quality_ladder { baseline }` → `LadderItem[]`；
  前端缓存 `qualityLadderCache`（键 = baseline，跨轮共享）；按勾选 `filterLadder`。
  默认基准 75 + 全选 = **12 个有损点（每格式 60/75/90）+ 3 个无损组 = 15 项**。
- **大小优先**：逐勾选有损格式 `onestop_size_search { groupId, roundId, referencePath, format, targetBytes }`
  → `{ hit, note, points[] }` → `sizeOutcomeLadder` 展开（命中点 + 邻近补点，≥3 点）；
  无损组 `losslessLadder(selection)` 原样补入。不可达标注按格式收进 `notesByFormat`。
- **生成**（`onestop.ts:runOnestop`）：逐项 `onestop_encode { groupId, roundId, referencePath, format, quality, conflictDecision? }`
  → `{ kind:'done', product{path,encodingParams} } | { kind:'conflict', proposedName }`；
  进度 `onProgress('正在生成 AVIF q75（5/15）')`；全部成功项**一次性** `round_add_candidates { paths, encodingParams }`。
- **收尾**：逐产物 `round_set_candidate_note { candidatePath, note }`（仅大小优先不可达）；
  `generated > 0` → 调 `scoreAllCandidates()`（整轮全量）；否则状态栏「一站式生成全部失败：…」。
- **成功反馈**：产物入轮 + 自动跑分 + 「跑分完成，共 N 张」；失败项附在状态栏
  「跑分完成；生成失败的项：A q60: …；B q75: …」（红字、易截断）。
- **失败反馈**：单档失败**不回滚**已成功项，继续其余；错误文本为后端中文原文（编码器缺失含官方发布页 URL）。
- **持久化字段**：`CandidateImage.encodingParams`（`OnestopFormat::encoding_params_text` 单一来源）、
  `CandidateImage.note`（不可达标注，与 CLI note 列同源）。
- **守护测试**：`onestop.test.ts`（目录、过滤保序、大小搜索载荷、展开、`toggleFormat` 不变原数组）、
  `conflict.test.ts`（批内决策记忆）。

### 1.5 一站式：单点模式

- **触发入口**：「编码阶梯」区的「单点模式」复选框（默认关）。
- **行为**：`onestop_single_point_ladder { baseline }`（每有损格式 1 点 + 无损组，取点仍由核心库算）；
  启用时强制 `mode='quality'`，并**锁死**模式切换、拉杆、目标大小（`disabled`），用启用前的基准值跑。
- **反馈**：预览行「单点模式：按基准 75 每格式压 1 点，共 N 项（无损组照常）」；
  未命中缓存时先「正在计算取点…」再异步补拉后重渲染。
- **失败反馈**：取点失败 → 状态栏「取点失败: …」；按钮仍按 `ladderCount` 判断可用性。
- **持久化**：无（纯会话态）。
- **守护测试**：`onestop.test.ts`；按钮计数逻辑在 `main-image-queue.test.ts`（一站式整轮调用点不变）。

### 1.6 高级创建（图片组）= 条目队列 + 惰性建轮

- **触发入口**：「新建评测轮 ⌄」→「高级创建…」→ `openAdvancedCreation()` 按组类型分派 →
  `openImageQueueCreation(group)` → `openImageQueuePanel(groupId, imageQueueHostDeps())`（整屏模态）。
- **添加**：`pickImages()` 多选 → `addImagePaths` 直接入列（**不弹窗**）→ `refreshQueueIdentities`
  → 渲染 → 状态栏「已加入 N 张图片（尚未跑分，工作区未改动）」；新条目自带 1 条 JPEG 有损卡。
- **行**：中间截断文件名 + 四态徽章（`未跑分 / 已跑分 / 将重跑（原因）/ 上次失败`）+「重复图片」提示 + ×。
- **判定**：`judgeEntries(entries, queueIdentityProbe())`；标识来自 `image_identities { paths }` →
  `identityReadingsOf` → 模块级 `identityCache`（面板与主界面共用一份）；缓存缺失按「读取失败」→ 保守重跑。
- **跑分按钮**：`scoreButtonLabel(plan, entries)`（「跑分 / 重跑（N 张）」，N = 待跑**图片张数**）；
  0 张仍可点，只弹「无需重跑」卡片。
- **执行顺序**（`image-queue-run.ts:runOneImage`）：
  1. `describeRound` 只读确认轮还活着（被删则丢弃 `entry.roundId`）；
  2. 惰性建轮 `round_create { groupId, name: '评测轮 N（文件名）' }` + `round_activate`；
  3. `round_set_reference`（同图时前端跳过，避免清空已有指标）；
  4. 逐卡 `advanced_encode { job{formatId,lossless,mode,quality,targetBytes,rows[]}, conflictDecision }`；
  5. `round_add_candidates { paths, encodingParams }`；
  6. `round_score_candidates { paths: 本次新产物 }`（**子集**，未列入行逐 bit 不变）；
  7. `applyRunResults`（写回**计划时**参数指纹）→ 每张 `onImageDone`。
- **失败语义**：编码失败 → 该卡失败；编码成功但跑分行缺失/带 error → `mergeScoreFailures` 折成失败；
  系统级错误（建轮/设原图/纳产物/跑分调用）→ 计划内**每张卡**都记失败；本次新建轮一条产物都没有 → `round_delete` 回滚空轮。
- **汇总**：状态栏「跑分完成：N 张图片已更新；K 条失败（详情见列表徽章）」+ 模态卡片
  「跑分汇总 / 本次跑分 N 张，跳过 M 张 / 逐张跳过原因」；**面板不关闭**。
- **删除条目**：`planDelete`（点名轮名与结果条数、写明磁盘产物不删）→ `confirm` → 有轮则 `round_delete` → `removeImageEntry`。
- **持久化字段**：新建 `Round`（名、referencePath、candidates 及 encodingParams）、
  被连带删除的轮；条目队列本身**不持久化**。
- **守护测试**：`image-queue.test.ts`（指纹/标识/脏判定/四态/换图/失败/反查/计划/文案/轮名/会话态/端到端）、
  `image-queue-run.test.ts`（批次/按钮文案/零调用/失败降级/回滚/系统错误/计划时指纹）、
  `image-queue-runtime.test.ts`（零调用、状态栏兜底、忙标志时机、`queueEditorDeps`）、
  `image-queue-panel.test.ts`（`planDelete` 文案、身份回包、DOM 机制守卫）、
  `main-image-queue.test.ts`（共用编排、宿主依赖只有一份）。

### 1.7 逐图参数编辑（弹窗）

- **触发入口**：条目列表行点击；主界面「已选跑分图」中**由条目产出**的胶囊本体点击
  （`openCandidateEntryEditor`，点击时按会话态重新 `entryForArtifact` 反查）。
- **前置**：`scoring` / 已有编辑窗 / 非条目产物（人工导入、一站式生成）时**不弹**，
  后者给状态栏「这张跑分图没有对应的图片条目…」。
- **结构**：左栏（文件名 + 四态徽章 + 全路径 + 「更换图片」）/ 右栏（编码器卡列表 + 「＋ 添加编码器」），右栏独立滚动。
- **即时生效**：没有「确定 / 应用」；改动直接落在 `ImageEntry.encoders` 上，关闭弹窗仍保留；
  只有回面板点「跑分」才写工作区。折叠区按 `entryId × data-adv-region` 回写。
- **换图**（`planReplaceImage` / `runReplaceImage`）：`round_clear_candidates`（清该轮跑分行，不删磁盘文件）
  → `replaceImagePath`（清快照/失败、置 `replaced`）→ `refreshIdentity`；**清行失败则不换图**。
  选回同一路径同样走完整流程（用外部工具原地覆写的唯一自救路径）。
- **卡操作**：加（优先 JPEG）/删/↑↓/恢复默认；命令行预览默认收起，「复制」走 `util.copyText`。
- **IPC**：`advanced_image_catalog`（目录）、`image_identities`（换图后标识）、`round_clear_candidates`。
- **失败反馈**：目录加载失败 → 右栏红字 + 状态栏；换图失败 → 状态栏「更换图片失败：…（旧图片与跑分结果未改动）」。
- **持久化**：无（全部会话态）；唯一落盘是 `round_clear_candidates`。
- **守护测试**：`image-entry-editor.test.ts`（换图计划与顺序、失败中止、头部、加卡、折叠回写、
  两栏结构、即时生效、三路关闭、单窗口、宿主依赖）。

### 1.8 产物文件名冲突询问

- **触发入口**：设置策略为「询问」（默认「自动追加」，此时后端永不回 conflict）且目标名已存在。
- **协议**：后端返回 `{ kind:'conflict', proposedName }` 时**未写入任何文件**；
  前端弹窗 → 「覆盖」带 `conflictDecision:'overwrite'` 重调；「跳过」不再重调（该产物不生成、不进轮）。
- **四按钮**：覆盖 / 跳过 / 覆盖全部 / 跳过全部；`ConflictSession` 记住批内决定（**批次边界 = 一次跑分**）。
- **使用点**：一站式（`onConflict: askFileConflict`）、条目队列编码（`imageQueueHostDeps.encode` 的 `conflicts.decide`）、
  `runQueuePlanOnce` 默认 `askFileConflict`。
- **文案**：`产物 <名> 已存在于产物目录（Pixel Arena）。要覆盖它，还是跳过这项？`（不含完整路径）。
- **守护测试**：`conflict.test.ts`（逐个/全部/`peekBatchDecision`）。

### 1.9 重跑改过的（增量）

- **触发入口**：工具栏「重跑改过的（N 张）」（`rerunChangedImages`）；N = `planScore(entries, probe).runImageCount`。
- **前置**：非 `scoring`、非 `queueRerunning`（独立的防重入布尔）。
- **编排**：`runQueuePlanOnce({ groupId, entries, deps: imageQueueHostDeps(), hooks })`——
  与面板「跑分 / 重跑」**同一个函数**，因此增量语义只有一份。
- **反馈**：逐张 `正在跑分 第 i/N 张（文件名）…`；结束 `render()`（按钮计数随之变）；汇总卡片。
- **0 张**：按钮**可点**，点开只弹提示卡（文案按跳过原因分流：全部 clean ≠ 没有编码器配置）。
- **守护测试**：`main-image-queue.test.ts`（文案与计划同源、0 张不置灰、点击走共享编排）、
  `image-queue-run.test.ts`（`rerunChangedButtonLabel`、`nothingToRunNotice`）。

### 1.10 视频高级创建（仅列与本域交界处）

- `openAdvancedPanel(group.id, { kind:'video', … })`：`advanced_video_catalog` →
  `advanced_encoder_status { keys }` 预检 → 「创建评测轮」`round_create` + `round_activate`
  → `round_set_note`（配置摘要 + 命令行）→ `dropSession`。
- 与图片侧的差异（**必须记住**）：视频侧有 **`validateEntry` 前置校验** + **`advanced_encoder_status`
  可用性预检 + 卡内红标**；图片条目侧两者都**没有**。
- 卡片实现共享：`renderEncoderCard`（`src/encoder-card.ts`，739 行）两处宿主都在用。

---

## 2. 纯逻辑与接线边界

### 2.1 可原样搬走（零 DOM、有测试，只改 import 路径）

| 模块 | 内容 | 结论 |
| --- | --- | --- |
| `image-queue.ts`（763 行） | 指纹 `paramFingerprint`、标识 `imageIdentityFrom/identityChanged/probeFromCache`、判定 `judgeImageEntry/judgeEntries`、四态文案 `badgeText`、计划 `planScore/isPlanEmpty`、汇总 `planSummary`、轮名 `roundName`、结果回写 `applyRunResults`、反查 `entryForArtifact`、会话态 Map | **整体搬**到 `features/encoding/queue/`；除会话态 Map 外全纯 |
| `image-queue-run.ts` | `planRunBatches / scoreButtonLabel / rerunChangedButtonLabel / summaryLines / nothingToRunNotice / mergeScoreFailures / runScorePlan`（执行器注入） | **整体搬**，一行不改 |
| `image-queue-runtime.ts` | `identityReadingsOf`、`buildQueueRunExecutor`、`runQueuePlanOnce`、`queueEditorDeps` | 搬；把 `showNotice` 默认值从 `modal-card` 改为 `ui/overlay.openModal`（已是可选依赖，注入即可） |
| `advanced.ts` 纯函数段 | `mergeArgs / quickBaseArgs / buildEntryArgs(Lenient) / validateEntry / availabilityErrors / shellQuote / formatCommandLine / previewImageCommand / previewVideoCommand / newEntry / addEntry / moveEntry / removeEntry`，以及 `ImageSpec / VideoSpec / ToolStatusLite` 类型 | **搬**（会话态 `sessionFor` 只剩视频用，交给 video 域或保留） |
| `conflict.ts:ConflictSession` | 批内决策状态机 | **搬**；`askFileConflict` 的 DOM 换 `ui/overlay.confirm` 四选一 |
| `pills.ts` | 无状态胶囊构建 | **退役**，改 `ui/primitives.chip`（当前实现见 3.5 的无障碍缺口） |

**唯一必须改造的“纯逻辑”**：`onestop.ts`。

- `initOnestopCatalog / fetchQualityLadder / fetchSinglePointLadder / searchSizeFormat` 直接 `invoke`；
- `runOnestop` 内部 `invoke('onestop_encode')` 并 `import type { Workspace } from './main'`。

这形成一个**反向依赖环**（纯逻辑 → main）。搬移方案：
`initOnestopCatalog/fetch*` 归 `core/ipc.ts`（或本域 `ipc.ts` 薄包）；
`runOnestop` 改成注入式 `runLadder({ ladder, encode, addCandidates, onProgress, onConflict })`，
`Workspace` 类型改引 `core/model.ts`。函数体（阶梯过滤/展开/进度文案/失败收集）**逐字保留**。

### 2.2 必须重写（DOM / 布局 / 视觉）

| 现状 | 重写为 | 关键差异 |
| --- | --- | --- |
| `main.ts:pickReference/pickCandidates/removeCandidate` | `features/encoding/sources.ts`（`reference` / `candidates` 分区） | 工具栏按钮 + 胶囊 → 分区内「点选 + 拖放 + 列表」；空态给下一步 |
| `main.ts:startScoring/scoreAllCandidates` | `features/encoding/scoring.ts` + `score` 分区 | 状态栏 alone → `store.busy` + 分区内 determinate 进度 + 就地失败展开 |
| `main.ts:runOnestop/buildOnestopControls` | `features/encoding/ladder.ts` + `ladder` 分区 | 一屏控件 + 20 字提示 → 模式分段 + 主参数 + **阶梯网格预览**；单点/无损组收进次级行 |
| `main.ts:imageQueueHostDeps` | `features/encoding/actions.ts`（跨域部分改用 `core/actions.ts` 既有函数） | 一份 deps → 动作函数 + `setWorkspace`；宿主依赖不再经闭包回传 `render` |
| `onestop.ts` 的 4 个 invoke 包装 + `onestop_encode` 调用 | `features/encoding/ipc.ts` | 命令名/参数/返回类型集中一处；纯逻辑只接收注入的 `encode()` |
| `main.ts:openCandidateEntryEditor/rerunChangedImages` | `advanced` 分区就地编辑 + `score` 分区次级动作 | 整屏模态与工具栏平级按钮 → 检视器就地 / 分区内次级 |
| `image-queue-panel.ts`（整屏模态 404 行） | `advanced` 分区的队列（模态只留「新建 / 删除确认」） | 模态遮住舞台 → 就地列表 |
| `image-entry-editor.ts`（整屏模态 484 行） | `advanced` 分区的就地编辑器 | 左图右参模态 → 就地卡列表（左图信息仍在分区头） |
| `encoder-card.ts` DOM | `encoding/card.ts`（保留「整卡重建 + 折叠区回写」机制） | 视觉换令牌；`ⓘ` 气泡 → `title`/`Tooltip` 原语；参数行控件换 `field/textField/segmented` |
| `advanced-ui.ts`（视频） | 视频域重写，本域只提供 `card.ts` | 视频侧仍是模态（配置型表单适合模态） |
| `style.css` 的 `.pill*`（394–474） | `styles/sources.css` | 胶囊 → `chip`；新增拖放落区高亮；删掉胶囊专用 `#2a2d33` 字面色 |
| `style.css` 的 `.onestop-*`（476–580） | `styles/encoding.css` | 保留分段控件语义，配色换令牌 |
| `style.css` 的 `.queue-*` / `.queue-editor-*`（1900–2166） | `styles/encoding.css` | 模态布局 → 分区布局；四态徽章色换 `--ok/--danger/--info/--text-subtle` |
| `style.css` 的 `.adv-*`（1485–1900） | `styles/encoding.css` | 换 0.5px 线、同心圆角、三档字号 |

### 2.3 依赖方向（硬约束）

```
core/*（ipc/store/actions/ui-state/model/util/format）   ← 不得 import features/**
ui/*（dom/primitives/overlay/toast/icons）                ← 不得 import features/**
shell/*（controller/registry）                            ← 只认 registry，不认具体域
        ▲
features/encoding/index.ts        ← 唯一对外：register()（5 个 PanelSection + 命令）
features/encoding/ipc.ts          ← onestop_* / advanced_* / image_identities 的唯一收口
features/encoding/{sources,scoring,ladder,advanced}.ts   ← 分区 UI（消费 ui/* 与 core/*）
features/encoding/queue/**、ladder-plan.ts                ← 纯逻辑：禁止 DOM、禁止 store、禁止 invoke
```

- 纯逻辑层只允许 import 纯逻辑层 + 类型；**不得**出现 `document` / `window` / `subscribe(` / `invoke(`。
- `core/*` 不得 import `features/encoding/**`（否则环；需要回调就由本域在 `register()` 里挂，
  例如 `core/actions.ts` 的 `onGroupRemoved(() => dropImageQueue(groupId))`）。
- 本域对外只导出 `register()` 与（若 lead 采纳 §2.4 方案 2）`card.ts`。
- 分区 `mount()` 返回的 `update()` 必须幂等：结构重建走 `paint(host, key, build)`，
  只刷文本/属性时直接改节点——因为 `store` 每次 `setStatus` / `updateBusy` 都会通知所有订阅者
  （跑分逐项进度会高频触发）。

### 2.4 `encoder-card` 归属待裁决

图片侧把它改成就地编辑器后，`renderEncoderCard` 仍是视频高级创建的卡。三条路：

1. **提升到 `ui/`**（推荐）：`ui/encoder-card.ts`，参数合并/校验仍由 `advanced.ts` 提供；
2. 留在本域 `features/encoding/card.ts`，视频域 import 本域（跨域依赖，不好）；
3. 视频域复制一份（必然漂移，**反对**）。

风险提示：`encoder-card.ts` 的图片分支**不是死代码**，收缩视频面板时不能顺手删。

---

## 3. 现有交互问题清单

### 3.1 跑一次评测要点几次

| 路径 | 应用内点击 | 系统对话框 | 明细 |
| --- | --- | --- | --- |
| 外部导入（默认路径） | **5** | 2 | 新建跑分组(1) → 图片跑分组(1) → 选择原图(1) → 添加跑分图(1) → 开始跑分(1) |
| 一站式 | **4** | 1 | 新建跑分组(1) → 图片跑分组(1) → 选择原图(1) → 一站式跑分(1) |
| 图片条目队列 | **4** | 1 | 新建评测轮 ⌄(1) → 高级创建…(1) → ＋添加图片(1) → 跑分(1) |

- 一站式第 4 击会**默认生成 15 份产物 + 15 次跑分**，提交前只能看到「共 15 项」这一个数字。
- 工具栏一行有 **5 个动作按钮 + 2 个导出 + 原图胶囊**；三个「跑分」入口（开始跑分 / 重跑改过的 /
  一站式跑分）平级排列，只能靠 tooltip、绿色描边、虚线描边区分。
- 高级创建的「添加图片」藏在**「新建评测轮」下拉**里，但它并不建轮（惰性建轮）——语义错位。

### 3.2 噪音文案（逐条可删/可收）

- 条目面板说明句：`添加图片即入列、不弹窗；每行是「一张原图 + 一套编码器配置」，对应一个评测轮。点「跑分 / 重跑」只跑改过的：…关掉面板等于工作区零变更。`（一句话讲 4 件事）
- 换图说明 3 句（约 90 字，含「用外部工具原地覆写过原图时…」）。
- 单点模式：`title` 与灰字提示**内容重复**（一处讲锁定范围，一处讲锁定 + 取点口径）。
- 一站式预览行与灰字提示都是解释性副标题（`按基准 75 自动取点：共 15 项（每格式 ≥3 点，含无损对照组）` / `每个格式自动逼近目标并补邻近点（保 BD-rate）…`）。
- `新加入的条目自带一条 JPEG 有损配置，添加完可直接跑分`、`表外编码器（枚举可得但无推荐参数）：…`、`还没有编码器条目，点下方「＋ 添加编码器」开始配置。`
- **事实错误**：`编码器首次使用需联网下载；AVIF/JXL 编码较慢`——决策 0025 已移除运行期下载，实际是
  「内置缺失 → 报错并给官方发布页 + 设置页外部路径」。这句会直接误导用户。
- 多处按钮 `title` 是 50–80 字的说明（`重跑改过的`、`一站式跑分`、`单点模式`、关闭面板…），
  悬浮才能看到，等于没写。

### 3.3 状态看不见

- 一站式逐项生成**只有状态栏一行文本**；哪些项成功/失败、失败在哪个格式哪个质量，界面上没有清单。
- 跑分 Channel 的 `N/M` 也只进状态栏（顶栏右侧，超长即截断）；检视器/结果坞没有任何进度。
- 大小优先的**探测搜索阶段**（每格式多次真实编码）只有一句「正在搜索 AVIF 逼近目标大小…」，无进度、无剩余格式提示。
- 忙时全置灰，但**不解释为什么灰**：`disabled` 按钮的原生 tooltip 在 Windows WebView2 上不触发，
  单点模式锁死拉杆、无原图时禁用一键跑分，用户只能猜。
- 条目四态徽章（未跑分 / 将重跑（参数改了）/ 上次失败）只存在于模态里；主界面能看到的只有
  `重跑改过的（N 张）` 一个数字，看不到「哪些、为什么」。
- 会话态与工作区不一致时无提示：**重启后**条目队列与快照清空 →「重跑改过的（0 张）」、胶囊点不开参数，
  界面没说明这是「本次运行没有配置记录」。

### 3.4 错误埋得深

- 一站式的失败汇总挤在状态栏一行（`跑分完成；生成失败的项：A q60: …；B q75: …`），必然触发截断，
  必须点状态栏才能看全文卡片（`openStatusCard`）。
- 编码器缺失（决策 0025）会让**每一项**都在编码阶段失败，用户看到 N 条几乎相同的长文本；
  没有「去设置页 / 打开官方发布页」的直达动作。
- 目标大小非法只在状态栏报一次，输入框旁没有错误文本，并且 `render()` 会**回退成旧值**（用户以为输入被吞）。
- 参数行非法（缺标志、同标志冲突）在图片条目流程里**没有前置校验**（`validateEntry` 只在视频面板用），
  要等 `advanced_encode` 失败后，才在条目徽章的 `title` 里看到。
- 编码器可用性预检（`advanced_encoder_status`）也只在视频面板做，图片侧没有。
- 参数弹窗只能鼠标进入：`buildPill` 给 `span` 设 `role="button"` 却**无 `tabindex`**，键盘/读屏无法触发。
- 冲突弹窗只说文件名，不给完整路径与影响；「覆盖全部」是一次可能覆盖多份磁盘文件的破坏性批量动作。

### 3.5 其它结构性问题

- 两条互不相通的来源路径：**工具栏「添加跑分图」**（工作区级候选）vs **「高级创建」条目队列**（会话态条目 + 编码）。
  用户无法判断「我该用哪个」，而两者的持久化语义完全不同（一个写工作区、一个只在内存）。
- 参数编辑器是整屏模态，关闭后 `render()` 整页重建 → 查看器重挂、BD-rate 重新 IPC（代码注释已承认这是
  「弹窗内不逐次重建」的原因）。
- 一站式控件**在选原图之后才出现**（`round.referencePath` 为真时 append）→ 布局跳变 + 发现性差。
- 无拖放（全仓库无 `dragover/drop`）、无取消、无快捷键（内容区没有 `keydown`，只有下拉菜单有）。

---

## 4. 新交互提案（按价值排序，≤6）

### 提案 1 · 检视器五分区 + 渐进披露 + 拖放落区

`原图 → 跑分图 → 跑分 → 编码阶梯 → 高级`，每个分区**一个主按钮**，缺前置条件时给下一步引导而不是灰一片。

- `原图`：有图 → 文件名 + 尺寸/大小 + 「更换」；无图 → 空态「点选或拖入一张原图」。
- `跑分图`：计数 + 列表（每行：文件名、大小、体积比、状态点、×）；「添加」+ 拖入追加。
- `跑分`：`开始跑分` 主按钮（`Ctrl+Enter`）+ 一行预演「将跑 N 张 / 跳过 M 张」+ 进度/失败区。
- `编码阶梯`、`高级`：默认折叠。
- 拖放：本域在各分区 host 上挂 `dragover/drop` → `acceptPaths('reference' | 'candidates', paths)`；
  整个分区高亮描边，无效类型就地一句中文提示（不弹窗）。键盘等价路径：`Ctrl+O` / `Ctrl+Shift+O`。

**价值**：把 5 按钮一行的决策负荷拆成「一次只面对一个决定」。

### 提案 2 · 一键跑分的主次收敛

- `开始跑分`（整轮全量）是**唯一**主按钮，留在 `跑分` 分区顶部（不复用工具栏）。
- 「只跑改过的」从工具栏同级按钮降为 `跑分` 分区内的次级动作，文案带预演计数
  「只跑改过的（N 张）」，N=0 时降级成静默文字（不再靠置灰表达）。
- 一站式不再是工具栏第三个跑分按钮，而是 `编码阶梯` 分区的 `生成并跑分`（`ladder` 分区自己的主按钮）。
- 三者关系用**位置**表达：整轮在 `跑分`，增量在 `跑分`（次级），自动生成在 `编码阶梯`（自己分区）。

**价值**：消掉「三个平级跑分按钮，只能靠描边区分」的最高频困惑。

### 提案 3 · 编码阶梯可视化预览（可勾选具体点）

- 模式（质量优先 / 大小优先）+ 一个主参数（拉杆或目标大小）+ 格式胶囊，保持现状语义。
- 拉杆/目标变化后，用真实 `LadderItem[]` 渲染**网格**：行=格式，列=质量点，每点一个 chip，
  默认全选、可单独取消（`toggleFormat` 已支持），行尾标「无损」对照。
- 预览脚注只留一行**事实**：`将生成 15 份产物并逐张跑分`（删掉「保 BD-rate」「每格式 ≥3 点」这类解释）。
- 大小优先在**搜索完成后**再用实测 `points[].bytes` 填充网格（搜索期间用 indeterminate 状态）。

**价值**：把「点一下就跑 15 张」变成「看得见清单再跑」；同时天然回答了「这次会做什么」。

### 提案 4 · 进度与失败就地展开

- 跑分：`beginBusy('score:<roundId>', '正在跑分', 待跑路径)` + `progressBar`（Channel `completed/total`
  的真实进度）；分区顶显示「跑分中 7/15」+ 当前文件名；结果坞状态列的「跑分中…」由
  `isPathRunning(path)` 驱动（**协作项**：需 results 域采用，别各自维护一套行内状态）。
- 一站式编码阶段：`正在生成 AVIF q75（5/15）` 进 `store.updateBusy` 的 `detail`；
  未知进度的搜索阶段用 **indeterminate**（文案 + 循环条），**绝不伪造百分比**。
- 失败：`跑分` 分区内一个可展开的「失败 K 条」列表（格式/文件名 + 原文 + 「复制」+「去设置」）；
  结果坞状态列的失败原因就地展开，不用悬浮 `title`。
- 编码器缺失：先调 `advanced_encoder_status` 预检，缺哪个就在发起前拦下并给
  「打开设置 → 编码器」与官方发布页两个动作（不再让 15 项各自失败一遍）。

**价值**：把「状态栏一行 + 截断全文卡片」换成就地、可逐条处理的真实状态。

### 提案 5 · 高级创建分步化：队列进分区，模态只留一步

- 图片组的「高级」不再是整屏条目面板，而是 `advanced` 分区里的条目队列：
  顶部「＋ 添加图片」（或拖入）、列表（同 1.6 的四态徽章 + ×）、底部「跑分（N 张）」。
- 模态只保留**真正需要聚焦的破坏性一步**：删除条目确认、冲突询问。
- 「添加图片」从「新建评测轮」下拉里移出（它不建轮）：`advanced` 分区直接给入口，
  轮在第一次产出产物时惰性创建（现状语义不变）。

**价值**：不再遮住舞台；消除「新建轮」与「添加图」的语义错位。

### 提案 6 · 参数编辑就地化（胶囊 → 分区内展开）

- 点「跑分图」里由条目产出的行/胶囊 → 在 `advanced` 分区展开该条目的编码器卡（就地编辑，即时生效），
  不弹整屏模态；`已有编辑窗` 的互斥改成分区内的单展开。
- 非条目产物（人工导入 / 一站式生成）不挂点击，只写明「没有可调的编码器参数」——
  保持现状的诚实口径（不给假交互）。
- 会话态缺失（重启后）时，行上直接说明「本次运行没有该图的配置记录，参数不可编辑」（而不是让按钮消失）。

**价值**：编辑时舞台与结果仍可见；顺带消掉「关闭模态整页重渲染」的成本。

---

## 5. 风险与坑

### 5.1 长任务不可中断（最高风险）

- 全仓库**没有** `AbortController`；`round_score_candidates` 在 `spawn_blocking` 里持工作区锁、
  整轮跑完才写盘返回。编码（`onestop_encode` / `advanced_encode`）同理。
- 前端能做的只有：**禁止重复触发**（`store.busy` 单任务 key）、**如实显示进行中**、
  关闭浮层/切分组时**不中断**但也不假装已结束。
- 「取消」需要后端新命令（本轮**不做**，记为待办；不要用前端计时器伪造中止）。

### 5.2 重复触发与忙标志

现状有 4 个布尔：`scoring`（全局）、`queueRerunning`、面板 `running`、`candidateEditorOpen`。
重写后统一到 `store.busy` 的任务表（`score:<roundId>` / `encode:<roundId>` / `editor:<entryId>`），
规则：
1. 会改数据的动作在**同类任务进行中**禁用；
2. **不**禁用「关闭浮层 / 切分组 / 看结果」；
3. 任务结束**必须** `endBusy`（`try/finally`），否则界面永久灰死——这是现状最容易被回归的点
   （`main-scoring.test.ts` 的 F1 就是在钉这件事）。

### 5.3 状态按轮隔离 vs 全局共享（别混）

| 状态 | 键控 | 生命周期 |
| --- | --- | --- |
| 一站式参数（mode/baseline/targetBytes/unit/singlePoint/selection） | `roundId` | 内存，切轮保留，重启归零 |
| 排序、查看器逐模式选图、滚动位置 | `roundId` | 同上 |
| 质量/单点阶梯缓存 `qualityLadderCache` | `baseline` | 全局（跨轮共享，不要按轮复制） |
| 原图标识 `identityCache` | `path` | 全局（面板与主界面必须同一份，否则同一个条目两处判定不同） |
| 图片条目队列 `queues` | `groupId` | 内存；**关闭分组时必须 `dropImageQueue`**，否则泄漏 |

切分区/切轮的 `update()` 必须幂等；轮 id 消失时要清理对应的轮级 Map。

### 5.4 IPC 返回整份工作区导致的重渲染（性能与焦点）

- 任何一次写操作都回整份 `Workspace`。现状最贵的路径：一站式大小优先**每有一个不可达标注就单独调一次
  `round_set_candidate_note`**，每次都是整份回包 + 整页 `render()`（并重挂查看器、重发 BD-rate IPC）；
  一次跑分里可能有多次。
- 新架构必须：`store.setWorkspace()` 后只让**订阅分区** `update()`；`paint(host,key,build)` 保护正在编辑的输入框；
  逐产物写 note 要合并（前端串行写、只刷结果坞；后端批量命令属可选项，**本轮不改后端**）。
- 编码器卡「整卡重建 + 折叠区按 `entryId × data-adv-region` 回写」机制必须保留，
  否则输入框丢焦点（`image-entry-editor.ts` 里已有该机制的实现与测试，照抄）。

### 5.5 编码器缺失的中文提示（决策 0025）

- 后端文案已经是中文且含官方发布页 URL + 「设置页指定外部路径」，**不要在前端复述/改写**，原样透传。
- 图片条目路径现在**没有** `advanced_encoder_status` 预检（只有视频面板有）→ 建议在 `跑分`/`高级`
  发起前统一预检一次（一次 IPC 拿全部 key），缺失即就地显示并给两个动作。
- `onestopBtn` 的 `编码器首次使用需联网下载` 与新决策冲突，**必须删除**（换成「内置缺失会提示去设置页」）。

### 5.6 会话态 vs 工作区的分裂（必须如实呈现）

条目队列、快照、参数指纹、标识缓存全部只在内存；工作区里的跑分结果却持久化。重启后：
条目队列为空 →「重跑改过的」显示 0 张、跑分图胶囊反查不到条目（点不开参数），
但结果表里的指标仍在。**不要**用「假装可编辑」掩盖；按 3.3 明确说明「本次运行没有配置记录」。
把条目队列持久化是产品决策 + 数据模型变更，**明确不在本重构范围**（`frontend-redesign.md` §1 非目标）。

### 5.7 换原图/换图会清空既有指标

`round_set_reference` 会清掉该轮候选的指标（体积比按新原图重算）；换图流程要先
`round_clear_candidates` 再换路径。重写时**不能**为了「减少重渲染」跳过这两条 IPC，
否则结果表会出现「旧产物指标 vs 新原图」的骗人对比（这是 `image-entry-editor` 的核心不变量，
`planReplaceImage` 的注释已写明）。

### 5.8 测试迁移（会碎一排）

6 个测试文件用 `?raw` 把源码当文本、压平空白后断言字面串：

| 测试 | 读取的源文件 | 重写后 |
| --- | --- | --- |
| `main-scoring.test.ts` | `main.ts` | 必然碎 → 按 `scoring.ts` 重建（F1/F8 两条不变量必须保留） |
| `main-image-queue.test.ts` | `main.ts` / `image-queue-panel.ts` / `image-queue-runtime.ts` / `pills.ts` | 碎 → 保留「胶囊 onClick 条件 / × 只移除 / 开始跑分不带 paths / 0 张不置灰 / 编排只有一份」五条语义，改钉新文件 |
| `image-queue-panel.test.ts` | 面板 + runtime + run + queue + `main.ts` + `style.css` | 纯逻辑部分（`planDelete`、`identityReadingsOf`、徽章文案）**保留**；DOM/CSS 守卫重写 |
| `image-entry-editor.test.ts` | editor + panel + `main.ts` + `style.css` | 纯逻辑（换图计划/顺序/中止/头部/加卡/折叠回写）**保留**；两栏 DOM 守卫重写 |
| `advanced-ui.test.ts` | `advanced-ui.ts` + `encoder-card.ts` + `style.css` | 纯逻辑保留；气泡/下拉/CSS 机制守卫随 UI 原语重写 |
| `bubble-flip.test.ts` / `status-bar.test.ts` / `topbar-menus.test.ts` | `settings-ui.ts` / `style.css` / `main.ts` | 涉本域的部分（状态栏全文卡片被跑分复用、气泡）要跟着改 |

纯逻辑测试（`onestop.test.ts`、`conflict.test.ts`、`advanced.test.ts`、`image-queue.test.ts`、
`image-queue-run.test.ts`、`image-queue-runtime.test.ts`）**应全部原样通过**——这是「纯逻辑原样复用」
这句话的验收标准：搬完之后它们的 diff 只应出现在 import 路径。

### 5.9 一次性跑分有 30 次以上后端编码/探测

默认一站式 = 15 次 `onestop_encode` + 15 次跑分；大小优先每格式探测约 2+log2(99) 次编码。
首次跑完可能要几十秒到几分钟。UI 必须：不阻塞、进度真实、失败不阻断、结束时汇总，
并承接 5.1（不可取消）的心理预期：进行中明确写「完成前无法中止」，不要给假的取消按钮。

### 5.10 无名契约（前端不能自己算）

- 编码参数文本、产物命名、冲突判定、指标计算**全部在后端**；前端只透传与展示。
- `advanced_encode` 之后必须 `round_add_candidates`（带 `encodingParams`）再
  `round_score_candidates`（带本次产物子集），顺序不能换、不能省。
- 一站式/高级创建都用 `encodingParams` 数组与 `paths` **一一对应**，长度不一致会被后端按缺省处理。

---

## 6. Phase B 实现落点（已交付）

### 6.1 文件清单

```
src/features/encoding/
  index.ts                    注册 5 个分区 + 5 个命令 + onGroupRemoved 清理（幂等，import 即注册）
  ipc.ts                      本域 IPC 唯一收口（onestop_* / advanced_image_catalog / advanced_encoder_status / advanced_encode / image_identities）
  actions.ts                  动作层：来源选择、整轮跑分、只跑改过的、一站式生成、队列宿主依赖、编码器预检
  session.ts                  按轮会话态：阶梯参数 / 逐点排除 / 大小搜索缓存 / 候选就地展开
  sections/common.ts          折叠态持久化（getPref('sections')）、paintBody、拖放注册、防抖
  sections/reference.ts       分区 reference(10)
  sections/candidates.ts      分区 candidates(20)，含就地参数编辑 + 四态行内状态
  sections/score.ts           分区 score(30)，主按钮 + 次级动作 + 真实进度 + 失败就地展开
  sections/ladder.ts          分区 ladder(40)，segmented + slider/size + chips + 逐点清单 + progressBar
  sections/advanced.ts        分区 advanced(50)，条目队列入口与概览
  overlay/entry-editor.ts     逐图编辑内容视图（候选就地 / 队列模态第 2 步共用）
  overlay/queue-modal.ts      条目队列模态（两步：列表 → 编辑 → 底部跑分）
  overlay/conflict.ts         冲突询问（覆盖 / 跳过 / 全部），关闭 = 跳过
  overlay/notice.ts           提示 / 汇总卡片
  overlay/encoder-issue.ts    编码器未就绪卡片（打开设置 + 复制发布页）
  logic/entries.ts            ← src/image-queue.ts（原样复制，import 路径改到 core/util）
  logic/run.ts                ← src/image-queue-run.ts
  logic/runtime.ts            ← src/image-queue-runtime.ts（拆掉 askFileConflict / modal-card 依赖，卡片改为注入）
  logic/ladder.ts             ← src/onestop.ts（去 main 反向依赖：runLadder 注入 encode/addCandidates；新增 groupLadderByFormat / ladderItemKey / pickLadderItems）
  logic/advanced.ts           ← src/advanced.ts（原样）
  logic/conflict.ts           ← src/conflict.ts（只保留 ConflictSession 纯状态机）
  logic/editor-plan.ts        ← src/image-entry-editor.ts 的纯逻辑段（头部/换图计划/加卡/排序）
  logic/queue-plan.ts         ← src/image-queue-panel.ts 的 planDelete
  logic/*.test.ts             迁来的 6 份纯逻辑测试 + 新增 encoding-logic.test.ts
src/ui/encoder-card.ts        共享编码器卡（图片条目 + 视频高级创建）；旧 src/encoder-card.ts 未动
src/styles/sources.css        原图 / 跑分图分区
src/styles/encoding.css       跑分 / 阶梯 / 高级 / 编码器卡 / 队列模态 / 三张卡片
```

### 6.2 注册契约（已实现）

- 分区：`reference`(10) / `candidates`(20) / `score`(30) / `ladder`(40) / `advanced`(50)，`kinds: ['image']`；折叠态写 `getPref('sections')[id]`。
- 命令：`pick-reference-image` / `pick-candidates-image` / `run-score-image`（enabled：有原图 + 有跑分图 + 空闲）/ `rerun-changed-image` / `generate-ladder-image`（enabled：有原图 + 空闲）。
- 拖放：`reference`（image → 首张设原图、其余加候选）、`candidates`（image → 全部追加）、`advanced`（image → 加条目）；忙时 `disabled: () => isBusy()`。

### 6.3 待 lead 集成时删除的旧文件（本域不自行删除）

`src/onestop.ts`、`src/advanced.ts`、`src/conflict.ts`、`src/image-queue.ts`、`src/image-queue-run.ts`、
`src/image-queue-runtime.ts`、`src/image-queue-panel.ts`、`src/image-entry-editor.ts`、`src/advanced-ui.ts`、
`src/encoder-card.ts`、`src/pills.ts`、`src/modal-card.ts`（若设置域已不用），以及它们的测试
`src/onestop.test.ts`、`src/advanced.test.ts`、`src/conflict.test.ts`、`src/image-queue*.test.ts`、
`src/image-entry-editor.test.ts`、`src/advanced-ui.test.ts`、`src/main-image-queue.test.ts`、
`src/main-scoring.test.ts`、`src/bubble-flip.test.ts`（最后两个 `main-*` 属禁区，由 lead 处理）。

`src/main.ts:1461` 的 `编码器首次使用需联网下载` 与决策 0025 冲突，随旧 main.ts 一起删除即可（新界面已无此文案）。
