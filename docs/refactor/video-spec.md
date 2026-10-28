# 视频域重构规格（video）

本文覆盖「视频跑分组」的整条前端：视频来源选择、视频跑分（VMAF / PSNR / SSIM / 耗时）、逐帧同步对比舞台、FFmpeg 就绪提示的界面呈现。
基准是 `docs/refactor/frontend-redesign.md`（信息架构、令牌、组件原语、注册契约、文件归属），本文只写视频域特有的东西，与之冲突时以设计契约为准。

本域最终重写进 `src/features/video/**` 与 `src/styles/video.css`，现有 `src/video.ts`、`src/video-compare.ts`、`src/main.ts:1564-1615` 与 `src/style.css:945-1048` 的视频段落由本域取代；旧文件本轮**不删**（`main.ts` 仍 import 它们），交付时给可删清单（§8）。

---

## 0. 范围、事实基线与注册契约

### 0.1 事实基线（本阶段实测）

- 分支 `refactor/frontend-rebuild`，工作区仅有 skills 目录的增删（与本域无关），`src/` 干净。
- `npx vitest run`：24 文件 / 462 测试全绿；其中视频两个文件 **27 测试**（`video.test.ts` 9 + `video-compare.test.ts` 18）。
- Rust 侧视频测试：`crates/pixel-arena-core/tests/video_scoring.rs` 5 个（真实 ffmpeg + 夹具，缺 ffmpeg 环境时跳过）、`workspace.rs` 内视频单测若干、`video_probe.rs` 4 个解析单测 + 2 个真实 ffprobe 链路（可跳过）、`video_server.rs` 3 个（Range / 404）。
- 现有视频 UI 的交互与渲染**没有任何自动化测试**，只以截图为准（`video.test.ts:1-3` 注明）。本域重构后仍沿用这条边界：纯逻辑进单测，渲染靠桌面截图。

### 0.2 注册契约（Phase B 已由 lead 定稿）

入口 `src/features/video/index.ts`（由 lead 的启动装配 import 一次，注册即生效）：

```ts
// 舞台：视频组唯一舞台视图（id/label 用 lead 指定值）
registerStageView({
  id: 'video-viewer', label: '视频对比', kinds: ['video'],
  mount(host, ctx) { /* 返回 { update, destroy } */ },
});

// 检视器：三个分区（id 用 lead 指定值）
registerPanelSection({ id: 'reference-video',  title: '原视频',   order: 10, kinds: ['video'], mount });
registerPanelSection({ id: 'candidates-video', title: '跑分视频', order: 20, kinds: ['video'], mount });
registerPanelSection({ id: 'score-video',      title: '视频跑分', order: 30, kinds: ['video'], mount });

// 结果坞：视频指标页签（id 待 lead 确认，见 §0.4 #5）
registerDockTab({ id: 'video-metrics', label: '视频指标', order: 40, kinds: ['video'], mount });

// 命令（快捷键与按钮共用同一入口）
registerCommand({ id: 'pick-reference-video',  run: () => chooseVideoReferenceForActiveRound() });
registerCommand({ id: 'pick-candidates-video', run: () => chooseVideoCandidatesForActiveRound() });
registerCommand({ id: 'run-score-video',       run: () => runVideoScoringForActiveRound() });

// 舞台键位（外壳统一监听，输入框/浮层打开时不派发）
registerKeyBinding({ id: 'video-step-back',  keys: ['ArrowLeft'],        kinds: ['video'], when: stageMounted, run: stepFrames(-1) });
registerKeyBinding({ id: 'video-step-fwd',   keys: ['ArrowRight'],       kinds: ['video'], when: stageMounted, run: stepFrames(+1) });
registerKeyBinding({ id: 'video-step-back10', keys: ['Shift+ArrowLeft'], kinds: ['video'], when: stageMounted, run: stepFrames(-10) });
registerKeyBinding({ id: 'video-step-fwd10',  keys: ['Shift+ArrowRight'],kinds: ['video'], when: stageMounted, run: stepFrames(+10) });
// Home/End、1/2/3 模式、+/-/0 缩放同法注册；空格视频组不注册。
```

键位匹配的 `KeyboardEvent.key` 写法待 Phase B 与 lead 对齐（`registerKeyBinding` 目前按 `keys` 数组匹配、注释里示例有 `'+'`/`' '`，没有 `Shift+` 前缀的组合语法 —— 见 §0.4 #3）。

- 图片组不注册以上任何一项；视频组不注册查看器舞台与「评分表」页签（遗留图片内容由结果坞的 `评分表` 兜底，见 results-spec：`kinds: ['image','video']` + 有遗留数据才显示）。
- 拖放：检视器「原视频区 / 跑分视频区」与舞台三处在 `mount` 时 `registerDropTarget(host, { id, accept: 'video', hint, onDrop })`，`destroy` 调返回的注销函数（`shell/file-drop.ts`）。
- 文件拖放的默认路由会 `import('../features/video/actions')` 并调用 **`chooseVideoReference(groupId, roundId, path)`** 与 **`chooseVideoCandidates(groupId, roundId, paths)`**（两个都必须导出、都是 async）。
- 视频组**没有**编码阶梯、没有一站式、没有叠加/差异/闪烁模式、没有连续同步播放（`docs/requirements.md:21,63-64`：第一版明确不做）。
- 轮级备注 `round.note`（T29-3 视频高级创建写入的配置摘要）由外壳展示，视频域不重复渲染（现状在 `src/main.ts:1341-1347`）。

### 0.3 文件归属

```
src/features/video/
  index.ts        唯一注册入口（注册舞台 / 三分区 / 坞页签 / 命令 / 键位）
  stage.ts        舞台视图（模式条 + 画面区 + 时间轴 + 错误层）
  media.ts        媒体服务：流注册、元素池、解码缓存、seek 汇聚（唯一持有 <video>）
  timeline.ts     时间/帧纯函数（从旧文件复制 + 新增）
  sources.ts      源列表、默认两路、网格槽位解析（纯函数）
  metrics.ts      视频指标列序 / 排序取值 / 行列派生（纯函数）
  errors.ts       MediaError.code → 中文提示（纯函数）
  actions.ts      选片、跑分、移除的 IPC 动作
                  **必须导出** chooseVideoReference(groupId, roundId, path)
                  **必须导出** chooseVideoCandidates(groupId, roundId, paths)
  inspector/      reference-video / candidates-video / score-video 三个分区
  dock.ts         「视频指标」页签
  *.test.ts       纯逻辑单测
src/styles/video.css
```

**硬约束（lead Phase B 规则）**：不删除、不 `git mv` 任何旧文件；`src/main.ts` 仍 import `src/video.ts`、`src/video-compare.ts`，搬走会让全仓 typecheck 变红。可复用的纯逻辑一律**复制**进 `src/features/video/` 再改 import；旧文件原样留着，交付时给「可删清单」（§8）。

不新建其它目录的共享模块，也不得 import `features/viewer/**`、`features/results/**`、`features/encoding/**` 的文件（结果表骨架例外，见 §0.4 #15）。

### 0.4 依赖盘点（Phase B 基础层已就绪，下表只列**仍缺**或**需对齐**的）

已可直接用（本轮不再重复造）：`core/model.ts`（`CandidateVideo` 已含视频字段）、`core/store.ts`（`busy` / `isPathRunning` / `runWorkspace` / `setStatus`）、`core/ffmpeg.ts`（`ffmpegStatus/ffmpegReady/ffmpegReason/refreshFfmpeg`）、`core/format.ts`（`formatSize/formatRatio/formatMetric/formatElapsed/formatClock`）、`core/ui-state.ts`（`roundScoped` 按轮状态、`getActiveCandidate` 交叉联动）、`core/actions.ts`（`pickFile/pickFiles/notePickedPath/dialogDefaultPath`）、`ui/canvas.ts`（视口几何 + `prepareCanvas/drawSource/watchSize/attachPanZoom` + 图片缓存）、`ui/dom.ts`（`el/paint`）、`ui/primitives.ts`（`button/chip/segmented/sliderField/selectField/section/emptyState/badge/progressBar/toolbar/spinner/metaRow`）、`ui/overlay.ts`、`ui/toast.ts`、`shell/registry.ts`、`shell/file-drop.ts`。

| # | 仍需 lead / 后端配合的事项 | 现状 | 影响 |
| --- | --- | --- | --- |
| 1 | `core/ipc.ts` 补 6 个视频命令包装：`roundSetVideoReference`、`roundAddVideoCandidates`、`roundRemoveVideoCandidate`、`roundScoreVideoCandidates`、`videoProbeMeta`、`videoStreamUrl` | 现有 `ipc` 只有图片命令 + `ffmpegCheck/ffmpegDownload`（`core/ipc.ts:33-`） | **阻塞实现**：我只能改 `features/video/**`，不能往 `core/ipc.ts` 加。若 lead 不补，退化方案是本域自建 `video-ipc.ts` 直接 `invoke`（违背"唯一收口"契约，需 lead 明确同意） |
| 2 | `video_stream_url` 的失败语义 | 命令同步返回 `String`，文件不存在也不报错 | 本域要 catch 并把失败映射到错误层；最好由 ipc 层原样抛出 |
| 3 | `registerKeyBinding` 的组合键 | `keys: readonly string[]` 且按 `KeyboardEvent.key` 匹配，无 `Shift+ArrowLeft` 语法（`shell/registry.ts:56-77`） | 逐帧 ±1/±10 两种步长需要：要么支持修饰键写法，要么本域注册 `ArrowLeft` 一个键、在 `run(event)` 里读 `event.shiftKey`（后者可立即实现，建议采用） |
| 4 | `shell/file-drop.ts` 的 `VIDEO_EXTENSIONS` 与选片过滤器不一致 | 拖放只认 `mp4/mkv/webm/mov/m4v`（`file-drop.ts:34`），旧对话框认 `+avi/ts/flv`（`video.ts:56-59`） | 拖入 `.avi/.ts/.flv` 会被判"非视频文件"。建议 shell 导出统一白名单（或本域只保留交集并在对话框同步收窄；需 lead 定口径） |
| 5 | 结果坞「视频指标」页签的 id/order | results-spec 只写"由 video 域注册"，未给 id | 暂定 `id: 'video-metrics'`、`order: 40`；若与 results 的评分表顺序冲突，以 lead 为准 |
| 6 | 网格行列规则 `gridLayout` 的归属 | 纯函数在旧 `src/multiview.ts:55-63`，不在 core | 按"复制不搬"规则：本域在 `features/video/sources.ts` 复制一份（含 1/2/3-4/5-6/7-9/更多 的映射），并加单测；不要 import 旧文件 |
| 7 | 画布底色 | `ui/canvas.ts` 明确"画布背景交给 CSS，不读颜色" | 本域用 `.video-stage canvas { background: var(--canvas) }` 实现，不调用任何取色 API（旧 `canvasBg()` 退役） |
| 8 | 结果表骨架 | `src/features/results/table.ts`、`metrics.ts` 由 results 域在写，签名未定 | 按 lead 指示：**先自己实现**视频指标表（只读指标列序/排序纯函数复用 `core/format.ts`），等 results 签名稳定再决定是否改为只读 import，不阻塞 |
| 9 | `ui/canvas.ts` 的视频扩展点 | 只有 `drawSource`，无"视频帧就绪/seek 汇聚"能力 | 本域 `media.ts` 自建；不改 `ui/canvas.ts` |
| 10 | 拖放默认路由 | 已 `import('../features/video/actions')` 并调用上述两个函数 | 必须保持签名 `(groupId, roundId, path\|paths) => Promise<void>`，且内部走 `runWorkspace` 落库 + 刷新 store |
| 11 | `store.busy` 的进度语义 | 只有 `label/detail/running`，没有 `completed/total` 数值字段 | 视频跑分进度只能写进 `detail`（如「视频跑分 3/8」）；若 lead 想给坞头做确定态进度条，需要新增 `updateBusy(id,{completed,total})` 或等价字段 |
| 12 | 命令启用条件 | `registerCommand` 的 `enabled?: () => boolean` | 视频跑分按钮/命令的置灰口径：无原视频或无跑分视频 → 禁用；忙 → 禁用；**FFmpeg 未就绪仍可点**（点了给原因），不要用 `enabled` 挡 |
| 13 | 舞台沉浸模式 | 契约 §3.2 有 `F` 沉浸开关，实现细节在 shell | 视频舞台只负责"填满给定 host"，不自己改外壳布局；需要 lead 明确 host 高度约束（`flex:1` + `min-height:0`） |
| 14 | `Shift+←/→` 与 Home/End 在全局表里没有 | 契约 §3.2 的全局键盘表不含逐帧键 | 需 lead 把"舞台作用域键位"写进快捷键帮助（`help.ts`），否则用户不知道 |
| 15 | 跨域只读 import 的许可 | results-spec §R11 未裁决 | 默认不 import；若 lead 同意，仅允许纯函数/类型，且 results 侧先提供稳定导出 |

---

## 1. 现有行为清单（重构必须保留的契约）

### 1.1 数据与 IPC 契约

| 项 | 内容 | 来源 |
| --- | --- | --- |
| `VideoCandidate` | `path / fileSize / sizeRatio / metrics / error / elapsedMs`（camelCase，与核心库 `CandidateVideo` 一一对应；数据模型另有未被前端使用的 `encodingParams`） | `src/video.ts:12-28`、`crates/pixel-arena-core/src/workspace.rs:135-159` |
| `Round` 视频字段 | `videoReferencePath: string \| null`、`videoCandidates: VideoCandidate[]`（serde default，旧文件为空） | `workspace.rs:94-99`、`src/main.ts:91-93` |
| 组类型隔离 | 视频组拒绝图片命令、图片组拒绝视频命令，后端报中文错误；前端按 `group.kind` 分流渲染 | `workspace.rs:642/665/708/745/816`（`ensure_group_kind`）、`src/main.ts:1349-1355` |
| 返回整份 Workspace | 六个命令全部返回 `Workspace`，前端整页替换、不做乐观更新 | `lib.rs:1224-1338`、`src/main.ts:388-398` |
| 指标格式 | `VMAF/PSNR/SSIM` 三键，值 `number \| 'inf'`（无穷大用字符串哨兵持久化） | `workspace.rs:161-215`、`src/video.ts:12,88` |

> 数据模型和命令名在本轮**不改**（契约 §1 非目标）。视频域新增的任何状态（时间点、模式、选路、曲线缓存）都不得进 `workspace.json`。

### 1.2 来源：选原视频

- 行为：系统文件对话框单选，过滤器 `mp4/mkv/webm/mov/avi/m4v/ts/flv`（`video.ts:56-59`）；取消不动工作区（`video.ts:234`）；成功后 `round_set_video_reference` → 整份工作区替换 → 全页重渲染（`video.ts:227-243`）。
- 覆盖语义（后端保证，前端只负责重选入口）：换原视频后**全部跑分视频的 `metrics/error/elapsedMs` 清空、`sizeRatio` 按新原视频重算**（`workspace.rs:636-655`）。前端不额外确认，也不二次弹窗。
- 入口形态：按钮文案随是否已有原视频变化（「选择原视频」/「重选原视频」）+ 单选胶囊（点击即替换，无 ×），空闲文案「尚未选择原视频」（`video.ts:126-148`）。
- 跑分中禁用（`disabled = ctx.scoring`）。
- 测试覆盖：**无**（纯 UI；`workspace.rs` 有 `set_round_video_reference` 单测与体积比重算断言）。

### 1.3 来源：添加 / 移除跑分视频

- 添加：多选对话框（`video.ts:246-264`）；后端去重（同路径已在列表则跳过）、任一文件不存在则**整批失败**、`fileSize` 选入时读盘、`sizeRatio = size / 原视频 size`（无原视频时 `null`）（`workspace.rs:659-694`）。
- 移除：胶囊 `×` → `round_remove_video_candidate` → 只摘这一行，其余行与原视频不动（`video.ts:215-224`、`workspace.rs:810-825`）。
- 胶囊文案：`truncateFileName(fileName(path))`（中间截断，上限 24 字符），`title` 为全路径（`src/util.ts:17-30`、`video.ts:172-185`）。
- 最近目录：选完记入设置（`recordState` 开启时），下次对话框用最近目录（`video.ts:232-235,251-256`）。
- 空态文案两条（有/无原视频各一条，`video.ts:190-196`）。
- 请求失败：`apply` 内部捕获 → 状态栏 `出错: …`，不弹窗（`main.ts:390-398`）。
- 测试覆盖：**无**；后端有去重/批量失败/体积比的 `workspace.rs` 单测。

### 1.4 元信息探测（ffprobe）

- 命令 `video_probe_meta(path, onProgress)` → `{width,height,fps,durationSecs}`；ffprobe 定位顺序「设置覆盖的同目录 ffprobe > tools/ 内置」，未配置返回中文错误（`lib.rs:1305-1332`、`ffmpeg_setup.rs:129-146`）。
- 前端**串行化**探测（`probeChain`），避免 ffprobe 缺失时并发触发多次失败（`video-compare.ts:216-232`）。
- 前端只消费 `fps`；**`durationSecs / width / height` 当前完全没用**（时长取 `<video>.duration`，尺寸取 `videoWidth/videoHeight`）。`onProgress` 通道后端已忽略（`lib.rs:1324-1326`），前端仍建了 Channel 并把消息转状态栏（`video-compare.ts:222-224`）——死契约。
- 探测失败静默降级：`fps = null` → 逐帧步进禁用，其余功能不受影响，**不弹错误**（`video-compare.ts:227,297-301`）。
- 解析口径：`r_frame_rate`（如 `30000/1001`）、`duration` 缺失记 0、缺 width/height 视为无效（`video_probe.rs:48-82`）。
- 测试覆盖：`video_probe.rs` 4 个解析单测 + 2 个真实 ffprobe 链路（环境缺 ffprobe 时跳过）。

### 1.5 播放与流 URL 生命周期

- **不使用 asset 协议**：Linux WebKitGTK 的 `<video>` 不走 Tauri asset protocol（`SRC_NOT_SUPPORTED`，实测 webkit2gtk 2.52.6），统一走内置回环 HTTP 流服务（`video_server.rs:1-7`、决策 0011）。
- 服务：启动时 `TcpListener::bind("127.0.0.1:0")` 随机端口，每连接一线程，纯 std 实现；仅暴露经 IPC 注册过的路径，id = 路径 `DefaultHasher` 哈希，支持 `Range: bytes=a-b / a- / -n`，未注册 404，文件不可读 404（`video_server.rs:24-112`）。响应带 `Content-Type`（按扩展名，未知回落 octet-stream）、`Accept-Ranges`、`Content-Length`，206 带 `Content-Range`（`video_server.rs:93-103,224-238`）。
- 注册：`video_stream_url(path)` 每次调用都插入注册表并返回同一地址（幂等）；**注册表只增不删，进程退出即销毁**（`video_server.rs:47-58`、`lib.rs:1334-1338`）。
- 前端加载：每个路径一个 `<video muted preload="auto">`，`src` 在 `video_stream_url` 返回后才写入；元素挂在 `document.body` 下 `.video-compare-pool`（离屏、`aria-hidden`、2×2px），因为部分内核（WebKitGTK 系）对不在文档里的媒体元素解码不可靠（`video-compare.ts:193-196,248-294`、`style.css:1038-1048`）。
- 解码缓存：模块级 `videoCache`，会话级、**不淘汰**；条目含 `status/el/width/height/duration/fps/errorCode/listeners`（`video-compare.ts:159-196`）。
- 就绪判定：`loadeddata`（首帧可解码）才算 ready，并把画面 seek 到共享时间点；`error` 记录 `MediaError.code`；`seeked` 从待办集合除掉，**全部齐了才统一重绘**（`video-compare.ts:263-287`）。
- 卸载：无任何释放路径——移除候选、关闭分组、切轮都不会销毁 `<video>` 或清缓存；只有进程退出才回收。
- 测试覆盖：`video_server.rs` 3 个（Range 三种形式、越界钳制、404）；前端无测试。

### 1.6 跑分：参数、执行与结果

- 触发：`round_score_video_candidates(groupId, roundId, onProgress: Channel<{completed,total}>)`，**一次 IPC 提交整轮全部跑分视频**，后端按设置的并发档位（默认 half 核）同时起多个 ffmpeg 进程，每段一个进程（`lib.rs:1264-1303`、决策 0016）。
- 单段计算：一次 ffmpeg 进程 `-filter_complex` 把两路各 `split=3` 后分别喂 `libvmaf / psnr / ssim`，输出 `-f null -`；从 stderr 三条汇总行解析 `VMAF score:` / `PSNR … average:` / `SSIM … All:`（`crates/pixel-arena-core/src/video.rs:42-95,115-150`、决策 0010）。
- 口径（不可改文案口径）：VMAF 用 libvmaf 默认内嵌模型 `vmaf_v0.6.1`（两路完全一致约 97~98，不是 100）；PSNR 为 ffmpeg average（两路一致为 `inf` → 前端显示 `∞`）；**视频 SSIM 是 ffmpeg 8×8 均匀窗口径，与图片 SSIM 不可比**；音轨不参与；两路分辨率/帧率需一致，否则 ffmpeg 失败并写中文原因（`video.rs:3-12`、`GLOSSARY.md:59-62`）。
- 结果落库：`metrics = {VMAF, PSNR, SSIM}`、`error = 中文原因`、`elapsedMs = 该段耗时（含子进程，失败也记）`（`workspace.rs:775-805`）。单段失败**不让整轮失败**（`workspace.rs:696-699`）。
- 前端流程（`video.ts:272-297`）：`setScoring(true, 全部路径)` → `setStatus('视频跑分中 0/N')` → `rerender()` → `await apply(invoke(...))` → `setStatus('视频跑分完成，共 N 段')` → `finally setScoring(false, ∅)`。
- **进度真相**：Channel 只有 `{completed,total}`（`lib.rs:594-619`），没有"哪一段完成/失败"的信息；所有行在跑分期间同时显示「跑分中…」（`video.ts:406-408`），行内状态只在整轮返回后一次性更新。
- **错误真相**：`ctx.apply` 内部已捕获异常（`main.ts:390-398`），因此 `startVideoScoring` 的 `try/catch`（`video.ts:292-293`）对 IPC 失败是**死代码**；失败时只有状态栏一条 `出错: …`，行内退回「待跑分」，错误原因不落库（后端未返回工作区）。
- **不可取消**：没有取消入口，关闭窗口才中断（子进程随后台线程结束）。
- 测试覆盖：`video_scoring.rs` 5 个真实链路（合理区间、两路一致 → PSNR∞/SSIM≈1、缺文件 fail-fast、非视频文件中文错误、分辨率不一致中文错误）；`workspace.rs` 有 `apply_video_score` 的间接断言（`video_group_rejects_image_round_content` 等）。

### 1.7 结果表

- 列：`排名 | 跑分视频 | 文件大小 | 体积比 | VMAF/PSNR/SSIM…（数据驱动，偏好序在前） | 耗时 | 状态`（`video.ts:308-315,64-74`）。
- 排序：点表头 → 首次方向由 `firstClickDir` 决定（文件大小/名称/耗时升序，指标与体积比降序）→ 再点反向；**缺值沉底**；跑分中点击静默忽略（`video.ts:317-363`）；排序状态**按评测轮**存在模块 Map，切走切回保留、重启归零（`video.ts:99-105,357`）。
- 格式化：大小 `B / KB(1位) / MB(2位)`、体积比 `<1` → 一位小数百分数、`>=1` → `×1.25`、指标 `|v|>=10` 两位小数否则四位、`inf` → `∞`、耗时 `<1s` → `ms` 否则一位小数秒（`video.ts:95-97,425-439`）。
- 状态四段文案与判定顺序：`失败：{error}` → `跑分中…` → `待跑分` → `完成`（`video.ts:400-414`），与核心库 `report.rs` 的 `status_text` 同口径并联（results-spec §1.4）。
- 「排名」列 = **当前排序下的行序号**，不是质量排名（未排序时是加入顺序）。results-spec §1.3 已把这条列为语义含混问题。
- 测试覆盖：`video.test.ts` 9 个（列序偏好、`inf` 还原、缺值沉底、首点方向、耗时格式）。

### 1.8 逐帧同步对比（核心）

模式与结构（`video-compare.ts:37-39,311-527`）：

- 三种模式：`分屏`（自动 N 栏：原视频固定最左 + 每段跑分视频一栏，同一卡片内无缝拼接，无间隙无分隔线）、`滑动`（单画布 + 可拖分割线，左右两路各自下拉选源，带「左路/右路」角标）、`网格`（按源总数自动行列，每格一个选源下拉，可选「（空）」，右上「放大/还原」）。
- 网格排布：`1→1×1、2→1×2、3-4→2×2、5-6→2×3、7-9→3×3、更多→ceil(n/3)×3`（`multiview.ts:55-63`，视频与图片共用）。
- 网格放大：显式「放大/还原」切换，放大后网格区高度取「内容区自然满高」与「行数×180px」的较大者；状态按轮记住，切换时视口置 null 重新 fit（`multiview.ts:65-122`、`style.css:983-991`）。
- 每轮默认：左=原视频（源列表第一项）、右=第一段跑分视频（第二项）；不足两段时整个对比只显示一行说明（`video-compare.ts:52-55,315-323`）。
- 源失效回落：被移除的源从 `leftPath/rightPath` 移除后回落到当前源列表前两项（`video-compare.ts:328-335`）。

时间与帧（纯函数，`video-compare.test.ts` 守护）：

| 能力 | 规则 | 来源 |
| --- | --- | --- |
| 共享时间点 | 所有显示中的视频 seek 到同一 `time`（秒），画面只随 seek 变化，永久暂停 | `video-compare.ts:124-127,624-630` |
| 时间轴总时长 | 当前显示各路 `<video>.duration` 的**最小值**；未就绪的 0 忽略；全未知则时间轴禁用 | `video-compare.ts:81-84,611-614` |
| 拖动 | `input[type=range]`，`min=0`、`max=时长`、`step=0.001`（1ms），`input` 即 seek | `video-compare.ts:551-559` |
| ±1 帧 | 帧序号 `floor(t*fps + 1e-6)`；+1 帧 = `(idx+1)/fps`；-1 帧 = 恰在帧界退到上一帧、帧中落回本帧开头；结果钳制 `[0,duration]` | `video-compare.ts:58-79` |
| 帧率口径 | 取**当前显示的第一路**已知 fps（分屏即原视频优先）；未知则两个步进按钮禁用 | `video-compare.ts:616-622` |
| 帧长展示 | 仅写在两个按钮的 `title` 里：`帧长 33.3 ms（fps=30，取自当前显示的第一路）` 或 `帧率未知（ffprobe 不可用或仍在探测），逐帧步进不可用` | `video-compare.ts:793-800` |
| 时间显示 | `分:秒.毫秒`（毫秒三位，四舍五入进位），如 `1:05.123 / 3:00.000` | `video-compare.ts:86-92,791-792` |
| 同步缩放/平移 | 所有窗格共享**同一份** `ViewportState`；滚轮以光标为锚点缩放、拖拽平移（pointer capture）、双击复位（重新 fit）、`zoom>=100%` 关闭平滑用最近邻 | `video-compare.ts:632-682,736-765,768-780` |
| 同步重绘 | 每次 seek 把元素加入 `pendingSeeks`，等所有 `seeked` 到齐才统一 rAF 重绘；2s 兜底定时器防坏文件卡死 | `video-compare.ts:198-214,284-287,569-574` |
| 逐路画幅 | 视口按第一份就绪帧的 `videoWidth/videoHeight` fit，之后所有窗格按同一视口 `drawImage` 可见区域 | `video-compare.ts:768-780` |

状态与生命周期：

- 每轮状态 `VideoState {mode,leftPath,rightPath,cellPaths,divider,viewport,gridZoomed,time}`，模块级 `Map<roundId, VideoState>`，切走保留、切回还原、重启归零（`video-compare.ts:112-153`）。
- 切换模式 = 整个 `mountVideoCompare` 重新挂载（递归），视口置 null 重新 fit，时间点保留（`video-compare.ts:364-369`）。
- 页面任何整页重渲染都会重新挂载对比（外层 `render()` → `mountVideoBlock` → `mountVideoCompare`），模块级 `sources / probeStatus / active / notifyDraw` 被重新赋值。
- 隐藏元素池只有一份（`document.body > .video-compare-pool`），跨重挂载复用。

### 1.9 空态 / 错误态 / 解码能力不足（中文提示全表）

| 场景 | 文案 | 位置 |
| --- | --- | --- |
| 未选原视频 | `尚未选择原视频` | `video.ts:146` |
| 有原视频、无跑分视频 | `原视频已就位。点「添加跑分视频」多选已压缩的视频，再「开始视频跑分」。` | `video.ts:192-193` |
| 什么都没有 | `视频评测（可选）：与图片评测互不干扰。先「选择原视频」作为基准，再添加跑分视频。` | `video.ts:194` |
| 源不足两段 | `逐帧对比：先选原视频并添加跑分视频（至少两段）后可用。` | `video-compare.ts:320` |
| 画布：路径为空 | `（空）`（网格空格） | `video-compare.ts:740` |
| 画布：加载中 | `正在加载视频…` | `video-compare.ts:745` |
| 画布：已就绪但无可画帧 | `正在解码视频帧…` | `video-compare.ts:753` |
| MediaError 2 | `视频加载失败：{name} 无法读取，可能已被移动、重命名或删除` | `video-compare.ts:183` |
| MediaError 3 | `视频解码失败：{name} 的编码格式系统缺少解码器（如 H.264 需安装 gst-libav）` | `video-compare.ts:185` |
| MediaError 4 | `视频格式不支持：{name} 不是有效的视频文件` | `video-compare.ts:187` |
| 其他 code | `视频加载失败：{name} 格式可能不受支持或已被移动、删除` | `video-compare.ts:189` |
| 跑分中（行内） | `跑分中…` | `video.ts:407` |
| 待跑分 | `待跑分` | `video.ts:410` |
| 完成 | `完成` | `video.ts:413` |
| 失败（行内） | `失败：{error}`（`title` 为错误原文） | `video.ts:403-405` |
| 状态栏进度 | `视频跑分中 {completed}/{total}` | `video.ts:280` |
| 状态栏完成 | `视频跑分完成，共 N 段` | `video.ts:291` |
| 状态栏失败 | `出错: {err}` | `main.ts:396`（经 apply） |
| 逐帧不可用 | `帧率未知（ffprobe 不可用或仍在探测），逐帧步进不可用` | `video-compare.ts:798` |
| 网格放大按钮 | `放大` / `还原` | `multiview.ts:77-80` |

解码能力不足的处置边界（现状）：仅按 `MediaError.code` 给文案，**没有**"重试""换源""检查解码器"的动作入口；文案写在画布上（canvas 文本，不可选中、不可复制、读屏不可达）。H.264 在 Linux 需要 GStreamer 插件（如 gst-libav）这条背景只出现在 code 3 的文案里。

### 1.10 FFmpeg 就绪提示链路

```
boot() ──> refreshFfmpegCheck() ──invoke ffmpeg_check──> detect_ffmpeg(tools/, settings.ffmpegPath)
                                         │                    └─ resolve_ffmpeg + `ffmpeg -version`（5s 超时）
                                         ▼
                        ffmpegCheck = {available, path, version, error}
                                         │
              ┌──────────────────────────┼─────────────────────────────┐
              ▼                          ▼                             ▼
   #ffmpeg-warning 警告条        #new-group-menu 视频项 title    #add-round title
   （renderFfmpegWarning）       （updateEntryWarnings）        （仅视频组 + 未就绪）
              │
      「前往设置」──> openSettings() ──关闭──> refreshFfmpegCheck()（重新检测）
```

- 警告条是 `index.html` 里的静态元素 `#ffmpeg-warning`（`role="alert"`，`hidden`），不随内容区重渲染（`index.html:43-45`、`main.ts:250-251`）。文案 = 后端 `error`，缺失时回落 `FFmpeg 未就绪：视频跑分前请先在设置页处理。`（`main.ts:287-289`），附「前往设置」按钮（`main.ts:290-297`）。
- 入口警告只改 `title`、**不禁用**：新建分组菜单的视频项、视频组下的「新建评测轮」（`main.ts:302-316`）；创建视频组后额外在状态栏亮一条红色提示（`main.ts:406-408`）。
- 检测失败（IPC 本身挂）也按未就绪警示，但不编造后端原因（`main.ts:271-275`）。
- 后端错误文案三态（设置页与警告条同源）：未配置 `FFmpeg 未配置：视频跑分依赖 ffmpeg。请到「设置 → FFmpeg（视频跑分）」…`；外部路径无效 `FFmpeg 自定义路径无效：{raw}（文件不存在）。…`；探测超时/失败走 `detect_with_timeout`（`ffmpeg_setup.rs:90-118,197-233`）。
- 探测（`video_probe_meta`）用 **ffprobe**：`resolve_ffprobe` 优先取外部 ffmpeg 同目录的 ffprobe，否则 tools/ 内置；未配置报中文错误（`ffmpeg_setup.rs:127-145`）。**这条错误前端吞掉了**（`video-compare.ts:227`），用户只看到逐帧按钮禁用。
- 跑分会重新 `resolve_ffmpeg`，未就绪直接返回中文错误（`lib.rs:1286-1289`）→ 经 `apply` 落到状态栏。
- 设置页（另一域）是唯一下载入口：`ffmpeg_download` 后台下载 → sha256 → 解包 tools/，进度走 Channel（`lib.rs:167-184`）；应用**不再自动下载**（决策 0025/T29-4 修订）。
- 测试覆盖：后端 `ffmpeg_setup.rs` 单测覆盖「有效外部路径优先 / 无效路径中文报错 / 空串回落内置 / 内置缺失报指引 / 探测超时」；前端链路无测试。

### 1.11 现状渲染与状态生命周期（重构必须知道的坑）

- 视频区块是**内容区最后一块**：导出工具栏 → （遗留图片结果表 + BD-rate）→ 视频区块（`main.ts:1567-1615`）；逐帧对比又是视频区块内部的二级块（`video.ts:198-207`）。所以"视频画面"在长页面最底部，要滚很久。
- 一切改动走 `apply()`：IPC → 替换整份工作区 → `render()` 全页重建 → 视频区块与逐帧对比重新挂载（`main.ts:388-398,1567-1615`）。滚动位置靠 `contentScrollByRound` 恢复（`main.ts:1357-1359`），视频内部的滑杆/网格下拉焦点不恢复。
- 排序状态、逐帧状态、一次性控件状态都按轮键控，但**分散在三处模块级 Map**（`main.ts` 的 `sortStates`、`video.ts` 的 `sortStatesByRound`、`video-compare.ts` 的 `videoStates`）。
- 跑分期间的忙标志是 `main.ts` 的模块级 `scoring` + `scoringPaths`，图片与视频共用；`setScoring` 回调内部会 `render()`，因此一次开始跑分至少触发两次全页重建（`main.ts:1607-1611`、`video.ts:275,283`）。
- `video.ts:2-3` 与 `main.ts:1032-1035` 的注释仍写"前端逐对调用/逐对刷新"，与 T24 的整轮单 IPC 实现不符（`video.ts:272-297` 已是一次提交整轮）——迁移时以代码为准，注释退役。

---

## 2. 可复用纯逻辑与必须重写的 UI 边界

### 2.1 可复制走（零 DOM、有测试，复制进本域后改 import；旧文件与旧测试原样保留）

| 逻辑 | 现状 | 现有测试 | 去向 |
| --- | --- | --- | --- |
| `videoMetricKeys` / `videoSortableValue` / `firstClickDir` | `video.ts:64-93` | `video.test.ts` | 复制到 `features/video/metrics.ts`（新测试 `metrics.test.ts`） |
| `formatElapsed` 及私有 `formatSize/formatRatio/formatMetric` | `video.ts:95-97,425-439` | 仅 `formatElapsed` | **不复制**：直接 import `core/format.ts`（同阈值同精度，见 §1.7） |
| `videoSources` / `defaultPair` | `video-compare.ts:47-55` | `video-compare.test.ts` | 复制到 `features/video/sources.ts` |
| `clampTime` / `frameIndexAt` / `nextFrameTime` / `prevFrameTime` / `minDuration` / `formatTimestamp` | `video-compare.ts:58-92` | `video-compare.test.ts`（浮点容差、帧界、钳制、进位） | 复制到 `features/video/timeline.ts`（新测试 `timeline.test.ts`） |
| `resolveCellVideo` | `video-compare.ts:96-110` | `video-compare.test.ts` | 复制到 `features/video/sources.ts`，改调本地 `gridLayout` + 槽位解析 |
| `gridLayout` / `gridZoomHeight` / `gridZoomLabel` | `multiview.ts:55-80` | `multiview.test.ts`（图片侧） | 复制纯函数到 `features/video/sources.ts`（含放大态高度下限常量）；DOM 的 `applyGridZoom` / `buildGridZoomButton` 用 `video.css` + `primitives.button` 重写 |
| `videoLoadErrorMessage` | `video-compare.ts:179-191` | 无 | 复制到 `features/video/errors.ts`，补单测 |
| 视口数学与画布工具 | `viewport.ts` / `video-compare.ts:710-780` | `viewport.test.ts` | **不复制**：直接用 `ui/canvas.ts`（`fitViewport/zoomAt/panBy/visibleRegion/prepareCanvas/drawSource/watchSize/attachPanZoom`） |
| 视频白名单 | `video.ts:56-59` | 无 | 复制到 `features/video/actions.ts`（与 dialogs 一致；拖放白名单见 §0.4 #4） |

> 复制而非搬运：旧 `src/video.ts` / `src/video-compare.ts` 与它们的测试保持可编译、可运行，直到 lead 收尾删除（§8）。本域新文件必须**自带 import 与测试**，不依赖旧模块。

规划与状态：排序状态从 `video.ts` 的 Map 迁到 `core/ui-state.roundScoped('video-sort', roundId, …)`；逐帧状态用 `roundScoped('video-stage', roundId, …)`；当前选中跑分视频复用 `core/ui-state` 的 `getActiveCandidate/setActiveCandidate`（与结果坞行点击天然联动）。

### 2.2 必须重写（DOM / 布局 / 视觉 / 状态机 / 媒体）

1. **整块 DOM 构建**：`mountVideoBlock` + `buildVideoTable`（`video.ts:109-421`）→ 检视器三分区 + 坞页签，用 `ui/primitives` 重建。跑分表**先自建**（results 的 `table.ts` 签名未定，不阻塞），排序/格式化复用本域 `metrics.ts` + `core/format.ts`；后期待 results 稳定再评估是否换成只读引用。
2. **逐帧对比挂载器**：`mountVideoCompare`（`video-compare.ts:311-860`，550 行单函数）→ `stage.ts` 拆分 `mount / update / destroy`：模式与工具栏、画面区、时间轴、绘制循环各自可独立更新；**时间轴更新不得重建 DOM**（`paint(host, key, build)` + 直接改属性）。
3. **媒体服务**：`videoCache` + 隐藏池 + `pendingSeeks` + `notifyDraw` + `probeChain`（`video-compare.ts:193-305`）→ `media.ts` 的显式生命周期对象：
   ```ts
   interface MediaService {
     stream(path: string): Promise<string>;              // video_stream_url，失败必须可见
     acquire(path: string, onSettle: () => void): MediaHandle; // 元素 + 元信息 + 错误
     seek(path: string, t: number): Promise<'ok'|'stale'>; // 单路 seek 完成（超时=tale）
     seekAll(paths: string[], t: number): Promise<void>;   // 汇聚 + 超时兜底
     meta(path: string): VideoMeta | null;                 // ffprobe 结果（fps/时长/宽高）
     releaseUnused(keep: readonly string[]): void;         // 新增：按需回收
     destroy(): void;                                     // 解绑监听；池与已解码元素保留
   }
   ```
   关键差异：`stream()` 的失败不再静默（当前 `invoke` 无 catch，见 `video-compare.ts:290-294`）；ready/error 回调按路径登记而不是全局 `notifyDraw`；seek 完成用 Promise，舞台据此决定重绘或标记 stale；`destroy()` 必须解绑所有监听与定时器，但**不销毁文档内的 `<video>`**（§5.1）。
4. **样式**：`style.css:945-1048` 全部作废，重写进 `styles/video.css`，只引用令牌（`--line/--canvas/--surface-*/--fs-*/--r-*/--s-*`），0.5px 发丝线，无写死色值（现状画布文字写死 `#9a9a9a`、`14px system-ui`：`video-compare.ts:728-734`）；画布底色由 `.video-stage canvas` 的 CSS 背景承担，不读颜色。
5. **状态与错误呈现**：画布内文字（加载中/解码失败/空）改为 DOM 覆盖层（`role="alert"`/`role="status"`），画布只画画面；错误层带「重试」「在检视器换源」动作。
6. **进度与忙态**：从 `main.ts` 全局 `scoring/scoringPaths` 迁到 `store.busy`（`beginBusy/updateBusy/endBusy` + `isPathRunning`）；行内状态由 busy + 候选数据派生（纯函数，可测）。
7. **就绪提示**：从 `main.ts` 的 DOM 直写改为读 `store.ffmpeg` / `ffmpegReason()`；分区内联提示新增，全局警告条去留由 lead 定（§6 #4）。

### 2.3 依赖方向（硬约束）

```
features/video  ──>  core/{ipc,store,format,ui-state,ffmpeg,model,actions}
                ──>  ui/{dom,primitives,icons,overlay,toast,canvas}
                ──>  shell/{registry,file-drop}（只注册，不 import 外壳实现）
        ✗──>  features/{viewer,results,encoding,settings}
        ✗──>  旧 src/{video,video-compare,viewport,multiview,pills,util}.ts
```

- 旧 `src/*.ts` 一律不 import（复制而非依赖），否则 lead 删除旧文件时本域会跟着红。
- `features/results/table.ts` 如需只读引用，仅允许纯函数/类型，且必须经 lead 裁决（§0.4 #15）。
- 反之，results / encoding 也不得 import `features/video/**`；共享物一律上移 `core/` 或 `ui/`。

---

## 3. 现有交互问题清单

### 3.1 位置与信息架构

- 视频画面在长页面最底部：导出 → （遗留图片表 + BD-rate）→ 视频区块 → 逐帧对比（`main.ts:1567-1615`、`video.ts:198-207`）。换一段对比源要先滚回顶部下拉，再滚回底部看结果。
- 逐帧对比是嵌在视频区块里的二级区块（虚线分隔 + 小一号标题，`style.css:961-976`），与"主舞台"的地位不符；标题、口径说明、方案说明三层文字堆在画面之上。
- 跑分结果与对比完全割裂：结果表在上、对比在下，互不联动；点了某一段没有任何视觉反馈能把它带到画面里（只能去下拉里按文件名找）。

### 3.2 控件分散、键盘不可达

- 一次对比要用到的控件分布在四处：模式条（`video-compare.ts:347-420`）、时间轴（`529-564`）、网格每格下拉（`454-479`）、滑动模式的左右路下拉（`388-414`）。
- 画布没有任何键盘入口：`canvas` 不可聚焦、无 tabindex、无 `+/-/0` 缩放、无 `←/→` 步进（现状全部鼠标：`video-compare.ts:632-682`）。
- 原生 `range` 的 `step=0.001`（`556`）意味着**键盘方向键每次只移动 1ms**，不是 1 帧；也没有 `aria-valuetext`。
- ±1 帧按钮不可用键盘连续触发（必须点），且"为什么不能步进"的原因只藏在 `title` 里（`796-800`）。
- 切换模式会整块重挂载（`video-compare.ts:364-369`），焦点、滚动、ResizeObserver 全部重建。

### 3.3 单帧指标与时间点对不上

- 只有三个**全片均值**，没有"这个时间点画质如何"的任何信息；后端也不存逐帧数据（`video.rs:47-95` 只解析三条汇总行）。
- 时间轴没有刻度、没有帧号，只有 `m:ss.mmm / m:ss.mmm`（`video-compare.ts:791-792`）；帧号与帧长只在按钮 `title` 里。
- 时间轴长度取各路最短时长（`81-84`），但界面**不说明哪一路更短**，超出交集的部分（原视频后半段）根本无法检查。
- 不同 fps 的两路共用"第一路 fps"步进（`616-622`），步进后两路可能停在不同帧号，界面没有任何提示。

### 3.4 状态与错误不可见 / 不可达

- 画布上的文案（`（空）`、`正在加载视频…`、`正在解码视频帧…`、解码失败三种提示）都是 canvas 文字：读屏读不到、鼠标选不中、错误路径无法复制（`video-compare.ts:728-734,740-750`）。
- 解码失败没有下一步动作：不能重试、不能换源、不能定位文件（`749`）。
- `video_stream_url` 的 Promise 没有 catch（`video-compare.ts:290-294`）：注册失败时条目永远停在 loading，画面永远"正在加载视频…"。
- ffprobe 不可用被静默吞掉（`227`）：±1 帧按钮灰着，用户不知道为什么，也不知道该去设置页装 ffprobe。
- MediaError 4 的文案断言"不是有效的视频文件"（`187`），但文件被移动/删除时流服务返回 404，浏览器很可能报 code 4 —— 文案会把"文件没了"说成"格式不对"（需三端实测确认后再定文案）。
- 跑分失败只有状态栏一条中文错误（`main.ts:396`），行内退回「待跑分」，用户不知道哪一段失败、为什么失败（后端其实没返回工作区，前端拿不到行级原因）。

### 3.5 与新视觉规范冲突

- 字号失控：视频相关规则里出现 `0.78rem / 0.8rem / 0.82rem / 0.85rem / 0.88rem / 0.9rem` 六档（`style.css:954-1036,817-827`），全站共 12 档 —— 违反「三档字号 + 12px 下限」。
- 边框 1px 实线、圆角 6/8px（`style.css:667-672,733-737,1003-1010`）—— 新规范是 0.5px 发丝线 + 四档圆角（舞台 6 / 内部 4）。
- 说明式文案堆叠：视频区块标题带长 `title`（`video.ts:120`）、两条空态各写两句、逐帧标题再带一段机制说明（`video-compare.ts:343-345`）—— 违反"删冗余解释、让布局解释"。
- 写死颜色与字体：画布提示色 `#9a9a9a`、`14px system-ui`（`video-compare.ts:730`）；分屏卡片底色写死 `#2a2d33 / #2b2b2b`（`style.css:733-736`）→ 浅色主题下失去语义。
- 分割线手柄用字符 `⟷`、30px 白圆（`style.css:800-815`）—— 与"克制圆角与阴影"的仪表盘气质不符，应由线性图标 + 2px 轨道重做。
- 无 `:focus-visible`：全站只有 3 处（`style.css:115,1241,1353`），视频按钮/滑杆/画布均无焦点环。

### 3.6 生命周期与性能

- 整页重渲染即重挂载对比；媒体元素池与解码缓存**只增不减**（`video-compare.ts:193,248-261`）：删掉候选、关掉分组、换轮之后 `<video>` 仍在 body 下，长会话会累积解码器与内存。
- 拖时间轴是 1ms 步进的连续 `input` → 每次都对所有路 `currentTime = t`（`video-compare.ts:557-559`）：拖动一次会发起大量 seek 请求，回环流服务（每连接一线程）与磁盘被放大。
- `refreshVideos` 的就绪对齐与 `seekAll` 用同一个 5e-4s 阈值（`205-207,577-584`）：浏览器把 seek 结果对齐到帧起点后，差值可能大于 5e-4，导致"以为没对齐"的重复 seek。
- 远端文件变更（同一路径换了内容）不会刷新缓存：画面仍是旧解码结果（缓存无失效）。

### 3.7 视频源不一致不可见

- 分辨率/帧率/时长三路可以各不相同，界面不显示任何一路的元信息；两路分辨率不同时 ffmpeg 跑分会失败，但对比时看不出差异。
- VFR（可变帧率）视频的 `r_frame_rate` 往往不是真实帧间隔，±1 帧会落到错误帧（`video_probe.rs:74-82` 只解析 `r_frame_rate`）。

---

## 4. 新交互提案（5 条，按价值排序）

### 提案 1 · 舞台化视频对比：画面即舞台，时间轴即底座

- **目标**：视频组的主角是画面。舞台常驻、占满中部，不再藏在长页面底部；跑分结果与来源退到检视器/结果坞。
- **结构**（自上而下，垂直 flex，填满舞台）：
  1. 舞台工具行：模式分段控件（`分屏 / 滑动 / 网格`，`segmented`）+ 网格「放大/还原」+ 右侧安静入口（`适应窗口`、沉浸）。
  2. 画面区：`flex: 1` 自适应高度（不再写死 `clamp(200px, calc(100vh-420px), 380px)`），由 `ResizeObserver` 触发重绘；分屏自动 N 栏 / 滑动分割 / 网格自动排布沿用现规则。
  3. 时间轴底座：时间码读数 + 轨道 + 帧读数 + 步进按钮（见提案 2）。
  4. 覆盖层（DOM，不画在 canvas 上）：加载中、解码失败（含「重试」「在检视器换源」）、"源不足两段"的空态引导。
- **空态**：0 源 → 大号空态「选一段原视频开始」+ 主按钮；1 源（只有原视频）→「已就位，再加一段跑分视频就能逐帧对比」+ 次按钮。全部用动作句，不写"与图片评测互不干扰"这类说明。
- **口径提示**：SSIM 口径、音轨不参与、两路需同分辨率帧率这些信息从标题 `title` 移到检视器「视频跑分」分区的 hint（每处只出现一次，不重复）。
- **保留的行为契约**：三种模式与自动排布、共享视口、双击复位、滚轮锚点缩放、网格放大、滑动分割线、按轮状态、默认两路、源失效回落、最短时长口径。
- **验收**：窗口 900×600 与 1440×900 下画面都占满可用高度且不出现外层滚动；三模式切换后焦点留在分段控件上；时间点与视口在切换模式后保留。

### 提案 2 · 时间轴 + 帧级键盘：让"定位到某一帧"变成一次按键

- **目标**：把"看某一帧"从鼠标拖动 1ms 变成精确、可重复、可键盘完成的动作。
- **轨道**：`0..最短时长`；每秒一个刻度（时长 >60s 时每 5s 一个，避免噪声）；当前时间一根 1px 指示线；点击轨道任意点定位（不是只有拖手柄）；拖动过程中用 `requestAnimationFrame` 合并，只对最终时间点发 seek。
- **读数**（一排，`gap` 分隔，禁中点）：
  `帧 1234` · `0:41.133` · `/ 3:00.000` · `30.000 fps` · `帧长 33.3 ms`（数字全部 `tabular-nums`；fps 未知时该段显示「fps 未知」并把步进按钮置灰 + 内联原因，不再只写 `title`）。
- **键盘**（舞台聚焦时生效，经 `registerKeyBinding` 注册，外壳统一监听；输入框/浮层打开时不派发）：
  | 键 | 动作 |
  | --- | --- |
  | `←` / `→` | ∓1 帧（等价于现 `prevFrameTime/nextFrameTime`） |
  | `Shift+←` / `Shift+→` | ∓10 帧（现版 `registerKeyBinding` 不支持 `Shift+` 写法 → 注册 `ArrowLeft/ArrowRight` 两个键，在 `run(event)` 里读 `event.shiftKey` 分流，见 §0.4 #3） |
  | `Home` / `End` | 首帧 / 末帧 |
  | `1` / `2` / `3` | 分屏 / 滑动 / 网格 |
  | `+` / `-` / `0` | 放大 / 缩小 / 适应窗口（沿用全局） |
  | `空格` | **视频组不占用**（第一版不做连续播放；保留给未来的播放/暂停） |
- **滑杆语义**：`input[type=range]`（原生键盘可聚焦），fps 已知时 `step = 1/fps`，未知时 `step = 0.01`；`aria-valuetext="0:41.133，第 1234 帧"`；`aria-label` 说明"两路同时定位"。
- **精度策略**：
  - 时间轴以**基准路（原视频）fps** 为步进口径；显示每路"当前帧号"，让"两路帧号不同"可见而不是被隐藏。
  - fps 未知 → 步进禁用但**给出原因与去处**（"需要 ffprobe：设置 → FFmpeg 应用内下载"），不静默。
  - 时长取交集，但读数区标注「时间轴以最短一段为准」，并在轨道上把超出部分画成不可达区（灰）。
- **验收**：只用键盘能从首帧走到末帧、能切三种模式、能缩放到 400%；每次步进时间码与帧号都正确（纯函数测试 + 桌面实测截图）。

### 提案 3 · 跑分与时间轴联动：先做"点行定位"，再谈最差帧

- **事实前提**：现有后端只产出三个全片均值，**没有任何逐帧数据**（`video.rs:47-95` 从 stderr 解析三条汇总行；`CandidateVideo` 也没有逐帧字段）。所以"点最差帧跳转"**必须改后端**，不属于纯前端重构。
- **第一步（零后端改动，本轮交付）**：
  - 结果坞「视频指标」点任意行 → 舞台切到该段（作为滑动模式的右路 / 网格第 1 格），**保留当前时间点**，画面立刻变成"原视频 vs 这一段"的同一时间点对比。
  - 检视器「跑分视频」选中行同步高亮；原视频区显示该段元信息（分辨率 / fps / 时长 / 文件大小 / 体积比 / 耗时 / 三项指标）。
  - 点失败行 → 舞台错误层显示该段后端中文原因 + 「换一段对比」。
- **第二步（Phase C，需 lead 决策与后端配合）**：
  - 在 `score_videos` 的 libvmaf 分支加 `log_path=<临时文件>:log_fmt=json`，解析 `frames[].metrics.vmaf`；**降采样**后随跑分缓存（每秒 1 点 + 段内极小值，上限 ~600 点）。
  - 存储二选一：(a) 新字段 `CandidateVideo.frameScores`（需改数据模型，与契约 §1"不改数据模型"冲突，必须显式例外）；(b) 会话内独立 IPC `video_frame_scores(groupId, roundId, candidatePath)` 现场算/缓存，**不落盘**（推荐：不动 workspace.json）。
  - UI：时间轴轨道下叠一条 VMAF 折线（同一时间刻度）+ 最差帧标记；点标记 → seek 到该帧；悬停显示该点 VMAF（不悬停也能从标记数字读到）。
  - 可行性结论：技术可行（libvmaf 标准能力），成本集中在 Rust 侧（滤镜参数、临时文件清理、**Windows 路径转义**：盘符冒号与反斜杠要转义成 `/` + `\:`）+ 数据体积；风险见 §5.7。若 lead 不批后端改动，本提案只交付第一步（本身已解决"跑分与对比割裂"）。

### 提案 4 · 检视器三区：与图片组同一套来源交互语言

- **分区**（`PanelSection`，视频组专有；id 用 lead 指定值）：
  1. **原视频**（`reference-video`，order 10）：单选 `chip`（点击替换，无 ×）+ 元信息两行（分辨率 / fps 从 `video_probe_meta` 取，时长取元素 duration；取不到显示「—」）+ 「重选」。空态：一句动作句 + 「选择原视频」+ 拖放提示。
  2. **跑分视频**（`candidates-video`，order 20）：多选 `chip` 列表（× 单独移除）+ 「添加」（多选，`Ctrl+Shift+O`）+ 每项右侧状态（待跑分 / 跑分中 / 完成 / 失败）+ 体积比。空态同原视频区。
  3. **视频跑分**（`score-video`，order 30）：「开始视频跑分」主按钮（`Ctrl+Enter`，命令 `run-score-video`）+ 一行只读参数摘要（并发档位来自设置）+ 真实进度（N/M + 不确定态条）+ 失败列表（点开就地展开原因，可复制）+ **FFmpeg 就绪状态内联**。
- **与图片组的一致**：同一套 `chip`/`emptyState`/`field`/`section` 原语，同样的「选原 X → 加跑分 X → 跑分」顺序，同样的拖放语言（图片组是原图/跑分图区，视频组是原视频/跑分视频区 + 舞台），同样的 `Ctrl+O` / `Ctrl+Shift+O` / `Ctrl+Enter` 心智（命令 id：`pick-reference-video` / `pick-candidates-video` / `run-score-video`）。
- **FFmpeg 就近提示**：分区顶部一条 `badge(danger)` + `ffmpegReason()` 原文 + 「前往设置」；全局警告条去留由 lead 决定（建议保留，因为未进视频组的用户也需要知道）。未就绪时「开始视频跑分」**可点**（点击后把原因亮在分区内并聚焦「前往设置」），而不是灰得没理由。
- **拖放**（`registerDropTarget`，`accept: 'video'`）：拖视频到原视频区 = 设为原视频；拖到跑分视频区或舞台 = 追加跑分视频；图片文件拖到视频组 → 状态栏中文提示（不静默、不弹窗）。三个落区的 `id` 分别取 `drop-reference-video` / `drop-candidates-video` / `drop-stage-video`（便于排查）。
- **文案收敛**：删除「视频评测（可选）：与图片评测互不干扰」「原视频已就位。点…再…」这类说明书式空态，改为一句动作句；口径说明只保留在「视频跑分」分区的 hint 里。

### 提案 5 · 「视频指标」结果坞页签：真实进度 + 行内失败 + 点击联动

- **目标**：把跑分结果从"页面中部的裸表格"变成坞里的稳定工作面。
- **结构**：坞头 = 页签名 + 真实进度（`N/M`，跑分中才出现）+ 排序摘要；表体列：`名称 | 文件大小 | 体积比 | VMAF | PSNR | SSIM | 耗时 | 状态`。指标列仍数据驱动、偏好序 `VMAF → PSNR → SSIM`。
- **修正两处语义**：
  - 去掉"排名 = 行序号"的含混：改为**最好值标记**（VMAF 最高、体积比最小、耗时最短各一个 `badge`），或在按指标排序时才显示序号；不排序时不显示序号。
  - 跑分中的行显示**不确定态**（"跑分中…" + 细微脉冲；不伪造百分比）；真实完成度只在坞头用 `N/M` 表达（数据来源就是 IPC Channel）。
- **行交互**：单击选中（整行高亮）并联动舞台（提案 3 第一步）；失败原因在状态列就地展开（`<details>` 语义或 `button aria-expanded`），可复制原文，不再靠 `title`。
- **排序**：沿用现规则（首点方向、再次反向、缺值沉底、按轮记忆），但跑分中表头 `disabled` 而不是静默忽略。
- **与 results 域**：格式与排序纯函数复用 `core/format.ts`；表格骨架若 results 提供可导出的纯函数则只读引用，否则本域自建 DOM（样式来自 `ui/primitives` + `video.css`，不复制 `results.css`）。
- **验收**：跑分中坞头显示真实 N/M 且行内不出现假进度；点失败行能看到中文原因；点任意行舞台切源且时间点不丢；排序在切轮后保留。

---

## 5. 风险与坑

### 5.1 WebKitGTK 媒体可靠性（最高风险）

- `<video>` 不能用 asset 协议（Linux 实测 `SRC_NOT_SUPPORTED`），必须保持回环 HTTP 服务（决策 0011）。任何"顺手改成 asset/`convertFileSrc`"的优化都会在 Linux 上直接黑屏——这条要写进代码注释。
- 媒体元素必须留在文档里（现挂在 body 下的离屏池）：新架构若把舞台做成"按需挂载/卸载"，卸载时**不要把 `<video>` 从文档里摘掉**，否则 WebKitGTK 上解码不可靠（`video-compare.ts:195`）。
- 解码器能力依赖系统：Linux 需要 GStreamer 插件（H.264 需 gst-libav），Windows 依赖 WebView2/系统 Media Foundation 编解码器。同一文件在三端可能一端能放一端报 code 3/4 —— 错误文案必须能区分"文件问题"与"系统缺解码器"（现文案已尝试区分，需实测校准）。
- `drawImage(video)` 要求 `readyState >= 2`（现已有守卫）；seek 后首帧可能短暂未就绪，必须在 `seeked` 之后再画，不能靠定时器"估"。

### 5.2 隐藏元素池与解码上限

- 每个候选路径一个常驻 `<video>`（`preload=auto`），会话内不淘汰：候选多 = 解码器实例多，Linux GStreamer 与 Windows MF 都有并发解码上限，超限表现为 code 3/4。
- 现状无释放路径（删候选/关组/换轮都不回收）。新 `media.ts` 必须提供 `releaseUnused(keep)`，在舞台 `destroy()`、候选移除、切轮时调用；同时保留"文档内池"约束。
- 池是全局单例：多个舞台实例（理论上）不能各建一份，否则同一路径两个元素。

### 5.3 时间同步精度

- 同步靠"全部 `seeked` 到齐才重绘" + 2s 兜底（`video-compare.ts:205-214,284-295`）。兜底触发时会画出**旧帧**，且清空 `pendingSeeks`，后续事件可能错位 —— 新实现要用每路 Promise + 超时结果标记「stale」，UI 上不假装已同步。
- 浏览器 seek 会对齐到帧起点，`state.time` 与实际显示帧最多差 1 帧；不同 fps 两路"同一时间点"落在不同帧号，这是物理限制，**必须在 UI 上说明**（提案 2 的逐路帧号）。
- 时长来源不一致：时间轴用 `<video>.duration`，ffprobe 的 `durationSecs` 未被使用（`video-compare.ts:33,297-301`）。MKV/TS 等封装在部分内核上 `duration` 为 `Infinity`/`NaN` → 现逻辑直接当 0 → 时间轴可能被禁用。新实现应"元素时长优先、ffprobe 兜底"。
- VFR：`r_frame_rate` 不等于真实帧间隔，±1 帧会落错帧。缓解：探测时同时取 `avg_frame_rate` 并以它为主（后端小改），或在 UI 标注「该视频为可变帧率，帧步进不精确」（需 ffprobe 判断，Phase C）。
- 1ms `step` 的滑杆 + 每次 `input` 都 seek：拖动会放大请求数。新实现必须 rAF 合并 + 只 seek 最终值。

### 5.4 视频流服务端口与生命周期

- 随机端口在进程启动时绑定，端口号只存在于返回的 URL 里；前端**不得缓存 URL 到磁盘/设置**（重启即失效）。
- 注册表只增不删，路径明文不进 URL（哈希 id）。若文件被移动/删除 → 404 → 元素报错（很可能是 code 4），文案会误导成"格式不支持"（§3.4）。缓解：错误层同时显示一次 `video_probe_meta` 的结果/失败原因，作为"文件是否还在"的旁证。
- 服务每请求一连接、无 keep-alive，每连接一个线程：同时注册/播放的路数多时线程数上升；长会话反复拖动时间轴会放大请求量（Range 请求频繁）。
- 服务启动用 `expect("视频流服务启动失败")`（`lib.rs:1602-1603`）：端口绑定失败会直接崩应用。本轮不改后端，但要在前端验收里覆盖"流 URL 拿不到"的降级（不能白屏）。

### 5.5 ffmpeg 子进程进度与取消

- 整轮单 IPC（`lib.rs:1264-1303`）：前端**拿不到**"哪一段开始/结束/失败"，只有 `{completed,total}`。任何"行内真实进度条"都是假的 —— 只能坞头 N/M + 行内不确定态。
- 无取消：长视频（分钟级）跑分期间用户只能等；关闭分组/切轮不会停子进程。UI 不要承诺可取消（除非 Phase C 加取消命令）。
- 并发上限来自设置的 `scoreConcurrency`（默认 half）：视频会同时起 N 个 ffmpeg 进程，CPU 打满时舞台 seek/解码会明显变慢 —— 忙态下舞台可降级（降低重绘频率），不要在此期间做重扫。
- Windows 子进程要 `apply_no_window`（核心库已做）；前端不需要处理黑窗口，但**不要**为了"显示进度"自己去起 ffmpeg 进程。
- 跑分中使用 `setScoring(true, 全部路径)` 会让所有按钮全局置灰（图片侧也灰）：新架构要保持"忙时禁止改数据的入口"，但允许切轮/看画面（现状也允许）。

### 5.6 重挂载、焦点与滚动

- 现状每次 `apply` 全页重建，视频对比重新挂载；`src/main.ts` 用 `contentScrollByRound` 恢复滚动（`1357-1359`），但焦点与内部控件状态丢失。
- 新契约要求舞台 `mount` 一次、`update()` 增量：**时间轴、模式分段、网格下拉一律不得在 `update()` 里重建**（否则键盘连续步进/拖动会断）。用 `paint(host, key, build)` + 直接改属性。
- `destroy()` 必须解绑：`ResizeObserver`、`requestAnimationFrame`、`pointer` 监听、2s 兜底定时器、`seeked/loadeddata/error` 监听。否则切轮后旧实例仍会绘制到已脱离的 canvas 并保持解码。
- 媒体元素进池是全局资源：舞台 `destroy()` 只解绑与释放引用，**不销毁池与已解码元素**（否则切轮回来黑屏重解码）；但要在候选移除时 `releaseUnused`。

### 5.7 逐帧 VMAF（Phase C）的额外风险

- ffmpeg 滤镜参数里的 Windows 路径必须转义（盘符 `C:` 的冒号、反斜杠），`log_path` 写错的表现是 ffmpeg 直接失败 —— 会把"能跑分的视频"变成"跑分失败"，回归面很大。
- 临时日志文件需要清理策略（跑分并发 N 个进程 → N 个文件），失败路径也要删。
- 数据体积：30fps × 10min = 18000 帧，原始 JSON 数 MB；必须降采样（每秒 1 点 + 极小值），否则 workspace.json 膨胀或 IPC 卡顿。
- 选择"不落盘、独立 IPC"路线时，会话内缓存要有上限与失效规则（换原视频后清空）。
- 最差帧定位的价值依赖"两路时间轴可精确对齐"，而 5.3 的帧对齐误差意味着"最差帧"可能差 1 帧 —— UI 上应给出 ±1 帧的邻域而不是绝对断言。

### 5.8 测试与迁移风险

- 复制而非搬运后，旧的 27 个视频测试**继续跑旧文件、保持绿**（lead 收尾删除旧文件时才会一起退役）。本域新文件必须自带测试：`metrics.test.ts`（列序/排序取值/首点方向）、`timeline.test.ts`（帧步进/钳制/时间戳/最短时长）、`sources.test.ts`（源列表/默认两路/网格槽位/行列映射）、`errors.test.ts`（四类 MediaError + 未知 code）。测试体可从旧测试复制，只补新增用例。
- `src/main-image-queue.test.ts:35-38` 用 `renderVideoGroupContent(` → `buildResultTable(` 的下标切片钉视频组内容：**本轮不动 `main.ts`**（lead 收尾时统一删），所以这条守卫暂时不红；等 lead 删旧函数时同步迁移（results-spec R10 同问）。若 lead 提前改 `main.ts`，本域要及时提供"视频组只挂导出 + 视频区块"的新位置说明。
- 5 个测试以 `?raw` 读 `./style.css`（`status-bar/advanced-ui/bubble-flip/image-entry-editor/image-queue-panel`）：lead 已把样式拆成 `styles/*.css` 并保留旧 `style.css`，本轮不动这些测试；本域只写 `video.css`，不删除旧类名（旧 `style.css` 原样留着）。交付时可删清单里列出"旧视频 CSS 段落"，由 lead 决定何时删。
- 视频 UI 没有渲染测试：新架构下"舞台挂载 → 时间轴更新 → 模式切换"只能靠截图验收，纯逻辑继续抽函数测试。
- 新增纯函数测试点：`nextFrameTime` 在末帧的行为、`fps=0/NaN` 的降级、`minDuration` 混入 0、网格槽位多于源数、`videoLoadErrorMessage` 未知 code、指标列序在只有 PSNR 时的稳定顺序、行内状态派生（busy + metrics + error 三输入的四种输出与判定顺序）。

---

## 6. Phase B 需要 lead 拍板的事项

1. **`core/ipc.ts` 的 6 个视频命令包装**（§0.4 #1）：这是唯一硬阻塞。若 lead 不补，请授权本域自建 `features/video/video-ipc.ts` 直接 invoke。
2. `registerKeyBinding` 的组合键写法（§0.4 #3）：默认按"注册单键 + `event.shiftKey` 分流"实现，不需要 lead 改壳。
3. `shell/file-drop.ts` 的视频白名单与对话框过滤器对齐（§0.4 #4）：加不加 `avi/ts/flv` 由 lead 定；本域对话框保持与拖放一致。
4. 结果坞「视频指标」页签 id/order（暂定 `video-metrics` / 40）与视频组「评分表」只读遗留图片数据的边界（results-spec 建议允许）。
5. 视频表格是否改为只读引用 results 的纯函数（§0.4 #15）；本轮先自建，不阻塞。
6. 全局 FFmpeg 警告条去留：本域必做分区内联提示；全局条建议保留。
7. `Space` 在视频组不绑定键位；若未来做连续播放再重新分配。
8. Phase C 逐帧 VMAF 是否立项：若立项，走"独立 IPC + 会话缓存、不落盘"路线（避免改数据模型），并接受 Windows 路径转义与数据降采样的成本。
9. `store.busy` 是否增加 `completed/total` 字段（§0.4 #11）：不加则坞头进度条为不确定态 + 文案 `3/8`。

## 7. 本域验收门（在契约 §8 之上补充）

- `npm run typecheck`、`npm test` 全绿；本域新增纯逻辑测试 ≥ 现状 27 个的等价覆盖（旧测试仍绿，新测试独立）。
- `npm run build` 通过（CSS 汇总入口已包含 `video.css`）。
- 桌面窗口实测截图：视频组三种模式、网格放大、时间轴首/中/末帧、解码失败错误层、源不足空态、FFmpeg 未就绪（分区内联 + 全局条）、深浅两主题。
- 手工路径：新建视频组 → 选原视频 → 加两段跑分视频 → 拖入第三段（落区生效）→ 跑分（坞头 N/M + 行内不确定态）→ 点行联动舞台 → ←/→ 逐帧 → 切模式 → 缩放到 400% → 移除一段跑分视频（源回落、媒体释放）→ 重启恢复（时间点归零、模式保留）。
- 三端冒烟（至少 Linux/Windows）：同一段 H.264 与 WebM 能出画面、能 seek；缺解码器时错误文案可读且有下一步。

## 8. 旧文件可删清单（交付时给 lead，本轮不删）

本域新实现齐备、且 lead 完成 `main.ts` 切换后，以下文件/段落可删（删除前逐个 grep 确认无引用）：

| 文件 / 段落 | 说明 | 删除前置条件 |
| --- | --- | --- |
| `src/video.ts` | 旧视频区块（选片/跑分/结果表） | `main.ts` 不再 `import { mountVideoBlock }`；`video.test.ts` 一并退役 |
| `src/video-compare.ts` | 旧逐帧对比（含媒体池与绘制） | 新 `media.ts` + `stage.ts` 通过三端冒烟；`video-compare.test.ts` 退役 |
| `src/video.test.ts` / `src/video-compare.test.ts` | 旧测试（新域已有等价测试） | 旧文件删除时同批删 |
| `src/style.css:945-1048` | 旧视频 CSS 段落（`.video-block` / `.video-compare` / `.video-timeline` / `.video-time` / `.video-compare-pool`） | 旧类名无引用；`?raw` 读取 `style.css` 的 5 个测试不受影响 |
| `src/main.ts:250-316,1564-1615` 的视频段落 | 旧警告条渲染 + 视频组内容 | lead 把全局警告条/内容区装配迁到新外壳后 |
| `index.html:43-45` 的 `#ffmpeg-warning` | 旧全局警告条元素 | 新外壳是否保留全局条定案后 |
| `src/video.ts` 里的格式化副本 | `formatSize/formatRatio/formatMetric/formatElapsed` | `core/format.ts` 已统一，旧文件删除时自然消失 |
| `src/pills.ts` / `src/util.ts` | 被 `ui/primitives.chip`、`core/util.ts` 取代 | 全仓无引用后由 lead 统一删 |

不删：`src/viewport.ts`、`src/multiview.ts`、`src/theme.ts`、`src/style.css` 的其余段落（其它域仍在用）。

---

## 9. Phase B 实现记录（video 域已交付）

### 9.1 文件清单（只动 `src/features/video/**` 与 `src/styles/video.css`）

```
src/features/video/
  index.ts                 注册入口（舞台/三分区/坞页签/三命令/全部键位）
  video-ipc.ts             6 个视频命令的 invoke 收口（lead 授权自建）
  actions.ts               选片/移除/跑分 + 拖放必需的两个导出
  timeline.ts              时间与帧纯函数（+ 单测）
  sources.ts               源列表/默认两路/分屏栏位/网格排布/槽位解析（+ 单测）
  metrics.ts               视频指标列序/排序取值/首点方向（+ 单测）
  errors.ts                MediaError 与流/探测失败文案（+ 单测）
  media.ts                 媒体服务：流地址、离屏元素池、解码缓存、seek 汇聚、
                           releaseUnused / trim / invalidate / destroy
  stage.ts                 舞台：三模式 + 时间轴 + 帧级键盘命令面 + 播放/暂停 + 覆盖层
  dock.ts                  「视频指标」页签（只读复用 results/table.ts 骨架）
  inspector/
    shared.ts              读当前轮、分区折叠持久化、打开设置、并发度文案
    reference.ts           原视频分区（胶囊 + 元信息 + 拖放）
    candidates.ts          跑分视频分区（多选胶囊 + 行内状态 + 拖放 + 行点击联动）
    scoring.ts             视频跑分分区（主按钮 + 真实进度 + FFmpeg 就近提示 + 失败展开）
src/styles/video.css       视频域全部样式（只用令牌）
```

旧文件（`src/video.ts`、`src/video-compare.ts` 及它们的测试）**未删除、未改名、未移动**，旧 `main.ts` 仍可编译。

### 9.2 注册 id

| 类型 | id | 说明 |
| --- | --- | --- |
| StageView | `video-viewer` | label「视频对比」，kinds `['video']` |
| PanelSection | `reference-video`（10）/ `candidates-video`（20）/ `score-video`（30） | 原视频 / 跑分视频 / 视频跑分 |
| DockTab | `video-metrics`（40） | label「视频指标」 |
| Command | `pick-reference-video` / `pick-candidates-video` / `run-score-video` | Ctrl+O / Ctrl+Shift+O / Ctrl+Enter 直接命中 |
| 拖放落区 id | `drop-reference-video` / `drop-candidates-video` / `drop-stage-video` | 由 `registerDropTarget` 注册，destroy 注销 |

### 9.3 舞台键位（已注册，需同步 help.ts）

| 键 | 动作 | 备注 |
| --- | --- | --- |
| `←` / `→` | ∓1 帧 | 焦点在可输入控件时不抢（时间轴滑杆用原生步进） |
| `Shift+←` / `Shift+→` | ∓10 帧 | 复用同一 binding，在 `run(event)` 里读 `event.shiftKey` |
| `Home` / `End` | 首帧 / 末帧 | 末帧按帧长回退一格，避免落到 duration 上 |
| `空格` | 播放 / 暂停 | 焦点在按钮/链接上时让给原生按钮激活 |
| `1` / `2` / `3` | 分屏 / 滑动 / 网格 | 与图片组 `1`–`6` 按 kinds 互斥 |
| `+` `=` / `-` `_` | 放大 / 缩小 | 以窗格中心缩放 |
| `0` | 适应窗口 | |

### 9.4 实现决策（与规格的差异）

1. **复用 `ui/canvas.ts`**（不再自建视口/指针实现）：它已提供 `fitViewport/zoomAt/panBy/visibleRegion/prepareCanvas/drawSource/watchSize/attachPanZoom/withZoom`，与本域需求完全吻合，且 Viewer 已在用同一套（lead 第 6 条：存在且合适就切换）。若 Viewer 后续改签名，需要 lead 在本域一起改。
2. **只读复用 results**：`features/results/table.ts`（`mountTable/nextSortState/sortRowsBy`）、`metrics.ts`（`metricMeta/formatMetricFor/metricPreferredDir/metricHeaderTitle`）、`status.ts`（四段状态文案）。本域不复制表格骨架、不改 results 文件。指标小数位因此从旧「按数值阈值 2/4 位」改为 results 的**按指标固定位**（VMAF 2、PSNR 2、SSIM 4），列内不再跳变。
3. **视频指标列序**仍用本域 `videoMetricKeys`（VMAF 优先 + 未知键按首现顺序），保留旧测试语义；未改用 `orderMetricKeys`（它把未知键按字典序排）。
4. **播放/暂停真实实现**：空格播放时所有显示中视频 `play()`，以第一路为母钟（rAF 每帧读 `currentTime`），其余偏差 >100ms 才纠偏；到末尾自动暂停；播放中禁用逐帧语义（步进先暂停）。持续同步播放仍属第二版路线图，这里是「原地暂停态对比」的补充操作。
5. **进度**：`store.busy` 写 `completed/total`（确定进度）与 `detail`；行列内仍是「跑分中」不确定态，因为后端整轮 IPC 不回传逐段事件。
6. **整轮失败就近复述**：`视频跑分失败：…` 除状态栏外，在「视频跑分」分区内复述一次（后端失败时没有工作区，行内看不到原因）。
7. **媒体生命周期**：`media.ts` 显式 `acquire / seekAll / releaseUnused / trim / invalidate / destroy`；元素常驻 body 下 `.video-media-pool`（不脱离文档），会话内最多保留 8 个解码实例，候选被移除时立即释放。
8. **错误呈现**：加载中/解码失败/源不足全部是 DOM 覆盖层（`role=status` / `role=alert`），带「重试」「换视频」；画布只画画面，不再有读屏不可达的 canvas 文字。
9. **参考分辨率变化**：换原视频时视口置 null 重新 fit；其余源增删保持视口。

### 9.5 验证结果（实测）

- `npx tsc --noEmit`：0 错误（含 video 域 0 错误）。
- `npx vitest run`：53 文件 / 912 测试全绿；其中视频纯逻辑新增 48 个（timeline 16 / sources 15 / metrics 9 / errors 8），旧 `video.test.ts` 与 `video-compare.test.ts` 仍绿（未改）。
- `src/styles/design-guards.test.ts`（lead 的设计守卫）：8 项全绿（无中点、无字面色值、无粗边框、无 `transition: all`、IPC 只在 `*-ipc.ts`）。
- `npm run build`：通过（当前 `index.html` 仍指向旧 `main.ts`，新图未进产物）。
- 额外集成冒烟：`npx esbuild src/boot.ts --bundle`（新入口全图）成功，461KB JS + 79KB CSS，证明新入口的模块图可打包。
- 未跑：dev server（按约定）、Rust 测试（本域未改 Rust）。

### 9.6 已知限制与后续

- **Phase C** 未做：逐帧 VMAF 曲线 / 最差帧定位（需后端 `libvmaf log_path` + 降采样 + 独立 IPC，规格 §4 提案 3 第二步）。
- **逐段真实进度**不可得：后端整轮 IPC 只有 N/M；要行内进度必须改后端事件协议。
- **VFR 视频**帧步进不精确（探测只读 `r_frame_rate`）；UI 已如实显示每路 fps 与帧长，不再静默。
- **时间轴取最短交集**：超出部分不可达，读数区按设计说明；如需检查尾段可临时换右路。
- **同步超时**（2s）显示「未同步」小字，不假装同帧。

### 9.7 可删清单（更新）

本域实现不依赖旧文件，lead 切换 `main.ts` / `index.html` 后可整批删除：

| 文件/段落 | 前置条件 |
| --- | --- |
| `src/video.ts`、`src/video-compare.ts` | `src/main.ts` 不再 import；新舞台三端冒烟通过 |
| `src/video.test.ts`、`src/video-compare.test.ts` | 与新测试等价（timeline/sources/metrics/errors 已覆盖） |
| `src/style.css:945-1048`（`.video-block/.video-compare/.video-timeline/.video-time/.video-compare-pool`） | 旧类名无引用；`?raw` 读 style.css 的 5 个测试不受影响 |
| `src/main.ts:250-316,1564-1615` 视频段落 | 全局 FFmpeg 警告条与内容区装配迁到新外壳后 |
| `index.html:43-45` `#ffmpeg-warning` | 新外壳是否保留全局条定案后 |
| `src/pills.ts`、`src/util.ts` 旧副本 | 全仓无引用后（`ui/primitives.chip`、`core/util` 已替代） |

不删：`src/viewport.ts`、`src/multiview.ts`、`src/theme.ts` 与 `style.css` 其余段落（其它域仍引用/尚未切换）。

### 9.8 联调小修（lead 真窗复现后）

1. **分辨率显示 —**：`media.ts` 的 ffprobe 回调原先只写 `meta/fps/duration`，宽高只从 `<video>` 的 `loadeddata` 取；检视器在解码完成前读到的 `peekVideo().width` 是 0。现补：探测成功时若 `entry.width/height === 0` 就用 `meta.width/height` 填；`loadeddata` 侧只在 `videoWidth > 0` 时覆盖，避免内核晚给尺寸时把探测值清零。两条路互补后，帧率 30 fps / 时长 3.000 / 分辨率 — 的复现路径消失。
2. **空态收敛**：结果坞「视频指标」在没有任何跑分视频时不再挂表格，改为一行 `results-empty-note`（12px，文案「跑分后这里出现视频指标」），与评分表/BD-rate 一致；「原视频」「跑分视频」两个分区的空态从大图标 + 标题 + 双行 hint + primary 按钮收敛为一行：说明 + secondary 按钮 + 「或把视频拖到这里」。
