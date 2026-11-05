# 图片对比查看器规格（viewer）

> Phase A 侦察产物。实现归属：`src/features/viewer/**` + `src/styles/viewer.css`（见 `frontend-redesign.md` §7.2）。
> 本阶段未改动 `src/` 任何文件。文中行号对应当前工作树（旧实现仍在 `src/*.ts`，重构期与新目录并存）。
> 测试基线：`npm test` 实测 **462 passed / 24 files**（2026-10-28），其中查看器相关 54 例：`viewport.test.ts` 14、`multiview.test.ts` 25、`viewer.test.ts` 8、`compare-modes.test.ts` 7。

## 1. 现有行为清单

### 1.1 模式与容器

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| 六个模式 | `split` 分屏（自动 N 栏）/ `slider` 滑动 / `grid` 网格（自动排布）/ `overlay` 叠加 / `diff` 差异 / `blink` 闪烁；T20 起 2×2、3×3 双入口已合并为单 `grid` | `viewer.ts:48-50`、`MODES` `viewer.ts:196-203` | ❌ |
| 切换模式 | 停闪烁表 → 改 `state.mode` → **`state.viewport = null`（强制重新 fit）** → 重挂整棵树 `mountViewer(container, round)` | `viewer.ts:210-220` | ❌ |
| 容器替换 | `container.replaceChildren(bar, area)`，每次切换/重挂重建全部 DOM 与监听 | `viewer.ts:305` | ❌ |
| 分屏栏数 | 第 0 栏原图 + 每张跑分图一栏（N+1 栏），同一卡片内无缝拼接、`flex:1` 平分宽度；每栏左上角是选图 `<select>`（选项含原图，无「（空）」） | `viewer.ts:327-370`、`style.css:723-742` | ⚠️ 选图回落由 `multiview.test.ts` 覆盖，栏数与 DOM 无测试 |
| 滑动对比 | 单画布 + 分割线覆盖层；右侧整幅画跑分图，再以 `divider*width` 裁剪重画原图；分割线比例钳制 `0.02–0.98`，默认 `0.5` | `viewer.ts:371-390`、`viewer.ts:658-682`、`viewer.ts:519-537`、`viewer.ts:110` | ❌（比例钳制无单测） |
| 网格 | `gridLayout(1+candidates.length)` 决定行列；每格画布 + 选图下拉（含「（空）」）；格距 0.2rem；高度 `clamp(240px, 100vh-259px, 560px)` | `multiview.ts:55-63`、`multiview.ts:174-236`、`style.css:840-861` | ✅ `multiview.test.ts`（行列表 6 例） |
| 网格放大 | 显式「放大/还原」按钮：加 `.zoomed` 类 + 写 `--grid-zoom-h = 行数×180px`，高度取 `max(内容区自然满高, 该值)`；切换后 `viewport = null` 重新 fit；状态按轮键控 | `multiview.ts:68-122`、`style.css:845-852`、`viewer.ts:270-272`、`viewer.ts:326` | ✅ `gridZoomHeight`/`gridZoomLabel`（3 例） |
| 叠加对比 | 先整幅原图，再以 `globalAlpha = opacity` 叠跑分图；不透明度 0–1，默认 **0.5**，滑杆 0–100% | `viewer.ts:694-708`、`compare-modes.ts:109-118`、`compare-modes.ts:149-170` | ❌ |
| 差异图 | 逐像素亮度差：`L=0.299R+0.587G+0.114B`，`diff≤阈值` 出 25% 灰阶底，`diff>阈值` 由黄(255,230,0)渐变到红(255,0,0)；阈值 0–100，默认 **2**；尺寸不一致显示中文提示不崩溃 | `compare-modes.ts:26-52`、`compare-modes.ts:172-193`、`viewer.ts:709-739` | ✅ `compare-modes.test.ts` 7 例（含边界：等于阈值不高亮、差到顶纯红、alpha 恒 255） |
| 差异图计算时机 | 整图在 `setTimeout(0)` 宏任务里算一次，`diffCache` 按 `原图|跑分图|阈值` 单条缓存；计算期间每帧画「正在计算差异图…」；`diffComputing` 防重入 | `viewer.ts:136-138`、`viewer.ts:719-737` | ❌ |
| 闪烁切换 | 固定 **500ms** 翻面；默认 **暂停且静止显示原图**；工具条「播放/暂停」；画布 **长按 400ms** 强制显示跑分图（位移 >5px 取消长按，平移照常）；离开模式把显示面归位原图 | `compare-modes.ts:94`、`compare-modes.ts:109-118`、`viewer.ts:412-415`、`viewer.ts:472-517`、`viewer.ts:214`、`viewer.ts:740-752` | ❌（间隔与默认值无断言） |
| 单槽模式控件 | 滑动/叠加/差异/闪烁共用一个「跑分图」下拉（在工具条）；叠加/差异/闪烁另有专属控件（滑杆/播放键）在工具条 | `viewer.ts:297-299`、`viewer.ts:277-293` | ❌ |

### 1.2 视口（同步缩放/平移/像素化）

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| 状态形状 | 每轮一份 `{centerX, centerY, zoom}`，坐标是**图片像素**，窗格尺寸只作换算参数；所有模式、所有栏/格读同一份 → 天然同步 | `viewport.ts:8-14`、`viewer.ts:92-93` | ✅ `viewport.test.ts` |
| fit | `min(pane.w/img.w, pane.h/img.h)`，居中；0 尺寸返回安全默认值 | `viewport.ts:37-43` | ✅ 4 例 |
| 缩放范围 | `MIN_ZOOM=0.01`、`MAX_ZOOM=64` | `viewport.ts:29-30` | ✅ 钳制 2 例 |
| 滚轮缩放 | 非 passive + `preventDefault`；`factor = 1.0015^(-deltaY)`；以光标为锚（锚点下的图片点在缩放前后屏幕位置不变） | `viewer.ts:419-432`、`multiview.ts:260-274`、`viewport.ts:75-88` | ✅ 锚点 2 例 |
| 拖拽平移 | 左键 `pointerdown` + `setPointerCapture`，`panBy(dx,dy)`，`.panning` 改光标；`pointerup/pointercancel` 收尾 | `viewer.ts:437-459`、`multiview.ts:279-301` | ✅ 平移 2 例 |
| 双击复位 | `viewport = null`，下一帧按窗格重新 fit | `viewer.ts:460-463`、`multiview.ts:302-305` | ❌ |
| 像素化阈值 | `zoom < 1` 时开平滑（high），**≥100% 关闭平滑走最近邻**（`NEAREST_ZOOM = 1`，严格小于判定）；viewer 与 multiview 各写一份 | `viewer.ts:75`、`viewer.ts:605`、`multiview.ts:48`、`multiview.ts:360` | ❌ |
| 只画可见区 | `visibleRegion` 把视口换成 `src/dst` 矩形，避免大图高倍时整图缩放；视口移出图片返回 `null` | `viewport.ts:104-125`、`viewer.ts:593-612` | ✅ 3 例 |
| 窗口尺寸变化 | `ResizeObserver(area)` → `scheduleDraw()`；视口保持不动，只重设画布背板 | `viewer.ts:540-541`、`viewer.ts:548-564`、`multiview.ts:310-311` | ❌ |
| 画布背板 | CSS 尺寸 × `devicePixelRatio` 取整设 `canvas.width/height`，`setTransform(dpr,...)`；尺寸变了才重设 | `viewer.ts:548-564` | ❌ |

### 1.3 选图与隔离

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| 单槽模式选图 | `candidateChoices: Partial<Record<SingleSlotMode,string>>`，**按「轮 × 模式」隔离**；未手选/选择已删除/候选删光 → 回落第一张或 `null` | `viewer.ts:59-72`、`viewer.ts:244-255` | ✅ `viewer.test.ts` 8 例 |
| 每帧现解析 | `draw()` 每帧重新 `resolve*` 再取解码条目（T19 回归：曾闭包捕获旧图导致画布一直画旧图） | `viewer.ts:628-634`、`viewer.ts:643-646`、`viewer.ts:654` | ✅ 选图解析有测，绘制接线无 |
| 分屏每栏/网格每格 | 通用纯函数 `resolvePaneImage(paths,i,round)`：显式有效则用、`''`=显式留空、失效回落默认、越界为 `null`；默认布局第 0 位原图、第 i 位第 i 张跑分图 | `multiview.ts:126-164` | ✅ `multiview.test.ts` 12 例 |
| 选择越界/格子数变化 | 数组缺省位走默认布局，显式位按格号保留 | `multiview.ts:134-148` | ✅ |
| 「比较哪几张」 | **无**：分屏恒为全部候选（N+1 栏），网格恒为全部图片填满 `rows×cols`，不能临时只比 2–3 张 | `viewer.ts:336`、`multiview.ts:180` | ❌ |

### 1.4 状态生命周期

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| 按轮键控 | 模块级 `viewerStates: Map<roundId, ViewerState>`；新轮按默认值创建（分屏、分割线 0.5、视口待 fit、未放大、默认控件值）；切走保留、切回还原；不持久化 | `viewer.ts:77-121` | ❌ |
| 唯一例外 | 切模式时 `viewport = null` 重新 fit（决策 0025 明确保留 T07 行为） | `viewer.ts:217`、`docs/decisions.md:139-141` | ❌ |
| 回收 | **无**：删除轮次后 Map 条目永久保留（键为 roundId，内存小但无界） | `viewer.ts:102` | ❌ |
| 闪烁定时器 | **模块级单定时器**；重挂先 `stopBlink()`，若仍处闪烁且播放中，挂载尾部重启 | `compare-modes.ts:120-134`、`viewer.ts:178-179`、`viewer.ts:756-759` | ❌ |
| 整页重渲染 | 任何数据变更（`apply()`）→ `render()` → `$content.replaceChildren()` → `mountViewer` 重建；只有 Map 里的状态活下来 | `main.ts:390-396`、`main.ts:1318-1360` | ❌ |

### 1.5 图片加载、空态、错误态

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| URL 来源 | `convertFileSrc(path)` → asset protocol，WebView 原生解码，不经 IPC 传像素；`assetProtocol.enable=true` 且 scope `["**","$APPDATA/**"]` | `viewer.ts:164`、`src-tauri/tauri.conf.json:24-31` | ❌ |
| 跨源声明 | 统一 `img.crossOrigin='anonymous'`（差异图要 `getImageData`，不加会被污染画布抛 SecurityError） | `viewer.ts:147-149` | ❌ |
| 解码缓存 | 会话级 `Map<path, ImageEntry{status,img,w,h,listeners}>`，同路径只解码一次；**error 状态永久保留、无失效/重试入口** | `viewer.ts:123-168` | ❌ |
| 就绪回调 | 加载中登记 `onReady`，完成/失败统一 `settle()` 后清空监听 | `viewer.ts:150-166` | ❌ |
| fit 的图源优先级 | 原图就绪优先用原图，否则用第一栏/第一张候选 | `viewer.ts:618-623`、`viewer.ts:647-648`、`viewer.ts:369-383` | ❌ |
| 加载中 | 画布居中画文字：`正在加载{原图|跑分图}…`、网格 `正在加载图片…` | `viewer.ts:582-585`、`multiview.ts:348-350` | ❌ |
| 加载失败 | 画布居中画文字：`{role}加载失败：{文件名} 可能已被移动、重命名或删除`；`#9a9a9a`、`14px system-ui` 硬编码，不跟主题令牌 | `viewer.ts:566-572`、`viewer.ts:586-588`、`multiview.ts:352-354` | ❌ |
| 尺寸不一致 | 差异图提示「原图与跑分图尺寸不一致，无法生成差异图」 | `viewer.ts:714-717` | ❌ |
| 空态（无原图/无候选） | **查看器整体不挂载**：无候选时 `main.ts` 只留一行灰字提示；查看器内部 `null` 候选会退化成「正在加载跑分图…」的永久假 loading（生产路径走不到） | `main.ts:1527-1545`、`viewer.ts:666-671` | ❌ |
| AVIF/JXL 代片 | 主进程对产物写 `<产物>.png` 代片（无损 PNG，像素与解码一致），前端 `viewerPath()` 把 `.avif/.jxl` 换成 `${path}.png`；跑分与结果表仍用真路径 | `main.ts:1023-1030`、`crates/pixel-arena-core/src/encode.rs:388-421`、`docs/decisions.md:87` | ❌ |
| 代片覆盖范围 | 只有工具生成的产物写代片（`encode_onestop` / `advanced`）；**人工导入的 AVIF/JXL 没有代片**，但 `viewerPath()` 无差别改名 → 必然 404，错误文案却提示「可能已被移动」 | `crates/pixel-arena-core/src/encode.rs:390-395`、`main.ts:1028-1030` | ❌ |

### 1.6 指针与键盘

| 行为 | 现状 | 来源 | 测试 |
| --- | --- | --- | --- |
| 滚轮 | 仅在画布上，非 passive + `preventDefault`，不与 Ctrl/Shift 组合做特殊语义 | `viewer.ts:419-432` | ❌ |
| 左键拖拽 | 平移；分割线另有独立 `pointerdown`（命中区 14px、视觉 2px、手柄 30px） | `viewer.ts:437-459`、`viewer.ts:519-537`、`style.css:778-815` | ❌ |
| 双击 | 复位 fit | `viewer.ts:460-463` | ❌ |
| 长按 | 仅闪烁模式：400ms 显示跑分图，>5px 取消；与平移共用同一指针序列 | `viewer.ts:472-517` | ❌ |
| 右键 | **无**语义（WebView 默认菜单） | — | ❌ |
| 键盘 | **完全没有**：`viewer.ts`/`multiview.ts`/`compare-modes.ts` 无 `keydown/keyup/tabindex/role`（`aria-label` 只有模式组与下拉）；画布不可聚焦 | `grep` 实测 0 处 | ❌ |
| 触屏/触控板 | 只靠 `touch-action: none` 关闭手势，无捏合缩放、无惯性 | `style.css:754-766` | ❌ |

### 1.7 性能实现（现状要点）

- rAF 节流：一帧内多次状态改动只画一次（`viewer.ts:405-409`、`multiview.ts:253-256`）。
- 只画可见区；大图高倍不整图缩放（`viewport.ts:104-125`）。
- 解码按路径复用；差异图整图一次算完再走普通 drawImage（`viewer.ts:136-138`）。
- **每帧**都会做的开销（新实现要收敛）：每栏 `getBoundingClientRect()`（`viewer.ts:549`）、每栏 `canvasBg()` → `getComputedStyle(documentElement)`（`viewer.ts:652`、`multiview.ts:345`、`theme.ts:29-31`）。
- 未做的：图片缓存上限/淘汰、DPR 变化监听、主题变化重绘、`ResizeObserver.disconnect()`。

### 1.8 测试覆盖汇总

| 文件 | 例数 | 守护什么 |
| --- | --- | --- |
| `viewport.test.ts` | 14 | fit（宽/竖/小图/0 尺寸）、坐标往返、锚点缩放、上下限钳制、平移方向、可见区 src/dst、移出返回 null |
| `multiview.test.ts` | 25 | `gridLayout` 六档映射、默认布局、网格/分屏共用选图语义（显式/留空/失效/越界）、网格放大高度与文案 |
| `viewer.test.ts` | 8 | 单槽槽位解析、按「轮×模式」隔离、删除后回落 |
| `compare-modes.test.ts` | 7 | 逐像素差异：灰底、黄→红渐变、边界相等、纯红端点、阈值 0、混合同图、长度与 alpha |
| 无覆盖 | — | 模式切换/重挂、叠加不透明度、闪烁间隔与默认值、滚轮/拖拽/双击/长按/分割线、加载与错误文案、按轮状态、画布 DPR、代片与 URL |

> 规格明确「界面与交互不写 DOM 级自动化，以截图/录屏验收」（`viewer.ts:6`）。Phase B 保持这一分工：**纯逻辑进 vitest，交互走截图**。

## 2. 公共 API 与可复用纯逻辑

### 2.1 现有导出

| 模块 | 导出 | 性质 | 处置建议 |
| --- | --- | --- | --- |
| `viewport.ts` | `ViewportState`、`Size`、`Rect`、`MAX_ZOOM=64`、`MIN_ZOOM=0.01`、`fitViewport`、`imageToScreen`、`screenToImage`、`zoomAt`、`panBy`、`visibleRegion` | 纯几何，0 DOM | **原样搬运**（`features/viewer/geometry.ts`），测试一并搬 |
| `compare-modes.ts` | `PixelBuffer`、`computeDiffData`、`renderDiffCanvas` | 纯像素 + 一张离屏 canvas | `computeDiffData` 原样搬（`diff.ts`）；`renderDiffCanvas` 搬但需加缓存上限 |
| 同上 | `BLINK_INTERVAL_MS=500`、`CompareUiState`、`defaultCompareUi`、`startBlink`、`stopBlink`、`buildT09Controls` | 状态形状 + 模块级定时器 + DOM 控件 | 状态形状搬；定时器改为**实例级**并挂 `destroy()`；控件改用新原语（`segmented`/`sliderField`/`button`） |
| `multiview.ts` | `MultiviewState`、`MultiviewRound`、`MultiviewImageEntry`、`LoadImage` | 类型接口 | 搬（`types.ts`） |
| 同上 | `gridLayout`、`gridZoomHeight`、`gridZoomLabel`、`defaultPaneImage`、`resolvePaneImage`、`defaultCellImage`、`resolveCellImage` | 纯逻辑 | `gridLayout`/`resolvePaneImage`/`defaultPaneImage` **原样搬**（`selection.ts`/`layout.ts`）；`gridZoom*` 建议退休（见 4.1） |
| 同上 | `mountMultiview`、`applyGridZoom`、`buildGridZoomButton` | DOM | 随新舞台重写 |
| `viewer.ts` | `ViewerRound`、`resolveCandidatePath`、`SingleSlotMode`、`isSingleSlotMode`、`ModeCandidateChoices`、`resolveModeCandidatePath`、`mountViewer` | 前五个纯逻辑，末一个 DOM | 前五个搬（`selection.ts`）；`mountViewer` 重写 |
| `theme.ts` | `canvasBg()`（读 `--canvas-bg`） | 每帧 `getComputedStyle` | 建议废弃：画布容器用 CSS `background`，canvas 只 `clearRect`；如保留则缓存 + 主题变化失效 |
| `util.ts` | `fileName`、`truncateFileName` | 纯 | 已由 lead 收口到 `core/util.ts`，改为引用 |

### 2.2 依赖关系（现状）

```
video-compare.ts ──> viewport.ts
                 └─> multiview.ts（resolveCellImage / gridLayout / applyGridZoom / buildGridZoomButton）
                 └─> theme.ts
viewer.ts ───────> viewport.ts + compare-modes.ts + multiview.ts + theme.ts + util.ts
main.ts ─────────> viewer.ts（mountViewer，唯一调用点，viewer.ts:1539）
```

- 唯一外部调用点：`main.ts:1539-1544`，入参 `{ roundId, referencePath, candidates:[{path}] }`，其中候选路径**已被 `viewerPath()` 换成代片路径**（`main.ts:1543`）。
- `video-compare.ts` 复用 `.viewer-area/.viewer-pane/.viewer-split-card/.viewer-slider/.viewer-divider/.viewer-handle/.viewer-tag/.viewer-grid/.viewer-cell-select` 九个类名与 `gridLayout/gridZoom*`；改类名会直接打断视频侧样式。
- 查看器不感知体积、指标、编码参数——这些属于检视器/结果坞，不要塞进查看器入参。

### 2.3 需要 lead 决策的共享层

查看器与视频逐帧对比都要「画布按 DPR 定尺寸 + 滚轮锚点缩放 + 拖拽平移 + 可见区绘制 + 加载/错误占位」。现状是两份复制（`viewer.ts:418-464` 与 `multiview.ts:259-307`、`video-compare.ts` 内还有第三份），像素化阈值、光标态、双击复位已经出现「改一处漏一处」。建议 lead 在 `src/ui/canvas.ts` 提供：

```ts
prepareCanvas(canvas): { ctx, size } | null          // DPR 定尺寸 + clearRect
drawSource(ctx, size, source, w, h, vp): void        // visibleRegion + 平滑开关
attachPanZoom(canvas, getViewport, setViewport, onChange, opts?): () => void  // 返回 detach
```

两个域都从这里取，纯几何仍由 `viewport.ts` 提供。若 lead 认为共享层收益不足，则 viewer 自带一份并接受视频侧重复——但要在 spec 里写明，别指望后续同步。

## 3. 现有交互的问题清单（桌面工具视角）

以「用户想干的事」为单位，标注现需步数与打断点：

1. **换一张对比图（单槽模式）**：切模式 → 去工具条找「跑分图」下拉 → 点开 → 选。**3 次点击 + 一次视觉搜索**；而分屏的换图下拉在画布上、网格的下拉在格子里，同一个动作在 6 个模式里有 **3 种控件、3 个位置**。用户必须记住「这个模式的下拉在哪」。
2. **只比 3 张候选**：做不到。分屏恒 N+1 栏、网格恒排满，10 张候选时分屏每栏 <100px。要么忍，要么删候选（破坏数据）。
3. **放大看局部再切模式**：滚轮+拖拽定位（数秒）→ 切模式 → **`viewport=null` 重新 fit**，刚才的位置全丢 → 重新缩放定位。一次对比流程里这个动作会重复十几次。这是最大的体验损耗。
4. **判断「现在是不是 1:1 像素」**：无读数。`NEAREST_ZOOM=1` 的阈值对用户不可见，只能靠肉眼猜；也无法一键跳到 100%。
5. **全屏看细节**：没有全屏/沉浸。窗口最大化后画布仍固定 420px（`style.css:718-721`），上方工具条多行换行、下方结果表，需要滚动页面才能看到完整舞台。
6. **差异图调阈值**：滑杆每 `input` 都触发整图重算，缓存只有 1 条 → 来回拖动 = 反复重算；3000×2000 图每次约几十毫秒到数百毫秒并闪「正在计算差异图…」，手感是「越拖越卡」。
7. **图被移动/删除**：画布上一行灰字，**不可选中、不可复制路径、不可重试、不能定位文件**；且缓存把 error 永久钉死，文件放回去也不恢复（只能重启或切走重挂）。
8. **正在拖分割线时跑分结束**：`apply()` → 整页 `replaceChildren()` → 查看器重挂，**拖拽被硬中断**（pointer capture 丢失）、下拉展开状态关闭、按钮焦点消失。看图和跑分本应互不干扰。
9. **网格放大**：矮窗口 + 多图时靠「放大」把页面撑高 → 页面滚动 → 舞台与结果坞错位；放大后 `viewport=null` 再 fit 一次，又丢位置。
10. **键盘用户/高频用户**：完全不可用（画布不可聚焦、无快捷键）；右键无菜单（想「设为原图」「在文件夹中显示」都没有）。
11. **空态**：没有跑分图时舞台整块消失（`main.ts:1527-1533` 只留一行灰字），用户看不到「这里将是对比舞台」，也没有拖放/选图入口。
12. **窗口变窄**：6 个模式按钮与提示文字换行成两行（`.viewer-bar` 只 `flex-wrap`，`style.css:656-661`），画布高度不变，整页更长。

## 4. 新交互提案（≤5 条，按价值排序）

### 4.1 舞台三件套：工具栏 + 画布 + 模式分段

- **现状**：工具条/画布/选图控件分散，选图入口随模式漂移；空态消失；网格靠页面级「放大」拉高。
- **新做法**：
  1. 舞台固定两段：`toolbar()`（一行，不换行，超出用 `openMenu` 收）→ 画布区 `flex:1; min-height:0`，四周内边距 `--s-2`（分屏左右各留 8px，画布不贴死左栏与右侧检视器；多视图见第 5 条）。
  2. 模式切换用 `segmented`（`role=radiogroup`，方向键可切），顺序按设计契约键盘映射：`1 分屏 / 2 滑动 / 3 叠加 / 4 差异 / 5 闪烁 / 6 网格`（**注意与现有 `MODES` 数组顺序不同**，id 不变）。
  3. 选图入口随模式而定：单槽四模式（滑动/叠加/差异/闪烁）点工具栏上的「<模式>：<当前图>」打开候选菜单，写 `candidateChoices[mode]`；分屏写各栏 `panePaths[i]`、网格写各格 `cellPaths[i]`，入口是每栏/每格的下拉胶囊。选图落点由 `applyPick` 统一收口，可单测。
  4. 网格/分屏的每栏/每格用就地小胶囊（`chip` + `openMenu`）选图，不再用覆盖在画面上的原生 `<select>`；胶囊与单槽模式的工具栏菜单写同一份状态，任何一处改动都会同步高亮。
  5. 网格行列仍用 `gridLayout`，行高 `minmax(120px, 1fr)`，容器满高、内部滚动，右侧不留内边距（竖直滚动条贴到舞台右缘，网格可用宽度比原来多 8px）；**退休「放大/还原」按钮与 `gridZoomed` 状态**（矮窗口问题由「舞台满高 + 网格内滚动」解决）。
- **契约**：模式语义、N+1 栏、自动排布、按轮×模式隔离、视口共享全部不变；变化的是选图控件位置与网格放大机制。
- **验收**：单槽模式换对比图 = 工具条上下文 1 次点击 + 菜单 1 次点击；分屏/网格换图 = 那一栏/格的下拉 1 次点击；窄窗口工具栏不换行；网格 16 张图在 950×525 下每格可读（≥120px 高）。
- **2026-11-02 调整**：底部胶片条已整体移除（决策 0037），舞台不再有缩略图栏；选图入口按上面第 3 条分工。

### 4.2 舞台挂载一次、切模式不重挂、保留视口

- **现状**：切模式重挂整树 + `viewport=null`；数据变更整页重渲染打断拖拽。
- **新做法**：
  1. 按注册契约实现 `StageView.mount()` 一次，`update()` 只增量改：模式子容器切换用 `paint()` 结构键；工具栏上下文与每栏/每格下拉只改文案/选中态。
  2. 模式切换只换画布子结构（分屏 N 栏 / 单画布 / 网格），**保留 `viewport`**。技术上成立：视口是图片坐标 + zoom，换窗格尺寸只是「同一位置、不同视野大小」，不会错位。仅在「首次进入/该轮没有视口/用户双击复位/窗口几何突变导致 zoom 越界」时 fit。
  3. `destroy()` 里 `ResizeObserver.disconnect()`、`cancelAnimationFrame`、清所有 `setTimeout`、`stopBlink()`、移除 window 级监听。
- **契约变更（需 lead 拍板）**：决策 0025 明确「切模式重新 fit」是刻意保留的 T07 行为（`docs/decisions.md:139-141`）。本提案要求改为「保留视口」。**这是本轮唯一会改变既有可观察行为的项**，建议批准并记入 `docs/decisions.md`。
- **验收**：放大到 400%、拖到某个编码块 → 依次切 6 个模式 → 位置不漂移；跑分结束/加删候选时正在拖分割线不中断、焦点不丢。

### 4.3 键盘与沉浸模式

- **现状**：零键盘支持。
- **新做法**（与设计契约 §3.2 对齐，新增项标注）：
  - `1`–`6` 切模式；`空格` 播放/暂停（仅闪烁模式）；`+`/`-` 以视口中心缩放（1.25 步进）；`0` 适应窗口；**`Shift+0` 1:1**（新增，设计契约未定义，需确认）。
  - 画布 `tabindex=0` + `role=img` + `aria-label="对比画布：滚轮缩放，拖拽平移"`；获焦后方向键平移 10px（Shift 100px），`:focus-visible` 焦点环用 `--focus-ring`。
  - `F` 沉浸（隐藏左栏/检视器/结果坞，`Esc` 退出）；`Esc` 顺序：先关浮层 → 再退沉浸（`ui/dom.ts:hasOverlay()` 已提供判定）。
  - 全局快捷键只在「舞台容器内且焦点不在输入控件」时响应（`isTypingTarget()`），避免与外壳 `Ctrl+N/O/E` 抢。
- **契约**：纯新增，不改变鼠标路径与既有语义。
- **验收**：不使用鼠标可完成「切模式 → 缩放 → 1:1 → 播放闪烁 → 退出沉浸」；焦点在输入框时 `1`–`6` 不生效；空格不会误触已聚焦的按钮。

### 4.4 缩放读数与快速档位

- **现状**：无读数、无法一键 100%。
- **新做法**：工具栏右侧常显 `zoom%`（`tabular-nums`，12px），点击开 `openMenu`：`50% / 100% / 200% / 400% / 适应窗口 / 1:1`；滚轮改动在 rAF 里写一次 DOM（不在 wheel 里直接改布局）。当 `zoom ≥ 1` 时旁挂一个「像素」`badge`，让最近邻阈值可感知。
- **契约**：fit 公式、`[0.01, 64]` 范围、光标锚点缩放全部不变；只是把内部状态显示出来。
- **验收**：滚轮后读数跟随；点 100% 后画面 1 图元=1 屏幕像素且徽标出现；读数在 6 个模式间保持同一个值（共享视口）。

### 4.5 加载/空/错误态改为 DOM 覆盖层

- **现状**：canvas `fillText` 灰字，不可点击/不可选中/不跟主题；error 永久缓存。
- **新做法**：画布上叠一层 DOM 覆盖层（`pointer-events:none`，仅动作按钮 `auto`）：
  - 加载中：`spinner()` + 「正在加载…」+ 文件名；超过 3s 补一行「大图或网络盘可能较慢」。
  - 失败：`emptyState` 变体，标题「无法显示这张图」，正文给出**实际尝试的路径**与三种可能（文件被移动 / 格式不支持 / AVIF·JXL 代片缺失），动作「重试」「复制路径」；重试调用新增的 `invalidateImage(path)` 清缓存后重现加载。
  - 尺寸不一致：保留原文案，加「改用叠加/滑动对比」的引导动作（切模式）。
  - 空态：无原图 → 「选择原图」+ 拖放提示；有原图无候选 → 舞台照常存在，画面中央给「还没有跑分图」提示与「添加跑分图」按钮（点击走 `Ctrl+O` 同一动作）。
  - 文案与 `--text-muted` 同源，字号 12/13px，全部 `aria-live="polite"`（加载/失败变化时播报）。
- **契约**：三种状态的**语义与文案要点**不变；新增「重试」「复制路径」「添加跑分图」三个动作（新增能力，需 lead 同意）。
- **验收**：把一张图改名 → 舞台给出可点击的重试；改回文件名 → 点重试即可恢复，无需重启；无候选时舞台仍在并给出添加入口。

### 4.6 需要 lead 拍板的清单

| # | 事项 | 建议 | 影响 |
| --- | --- | --- | --- |
| 1 | 切模式是否保留视口（决策 0025） | 保留 | 唯一行为变更，体验收益最大 |
| 2 | `viewerMode` 按全局偏好（`UiPrefs.viewerMode`）还是按轮键控（现状） | 按全局偏好（设计契约 §7） | 换轮后模式跟随上次，不再每轮独立 |
| 3 | 网格「放大/还原」按钮与 `gridZoomed` 是否退休 | 退休，改舞台满高 + 网格内滚动 | 少一个控件与一份状态，需视频侧同步（视频网格共用 `buildGridZoomButton`） |
| 4 | 新增动作：错误态「重试/复制路径」、空态「添加跑分图」、快捷键 `Shift+0` | 批准 | 只增不减 |
| 5 | 是否提供 `ui/canvas.ts` 共享层（见 2.3） | 批准 | 视频侧可复用，避免第三份复制 |
| 6 | `viewerPath()`（AVIF/JXL 代片映射）归属 | 提到 `core/model.ts` 为 `viewPath()`，大小写不敏感 | 查看器/检视器共用同一口径 |

## 5. 风险与坑

1. **canvas 尺寸与 0 尺寸**：`display:none`/折叠态下 `getBoundingClientRect()` 为 0，`prepare` 取 `max(1)` 后按 1×1 fit 会**把错误视口写进状态**（现状 `ensureFitted` 就会这么干，`viewer.ts:618-623`）。新实现必须：尺寸 < 8px 时不 fit、不写状态，等下一次 RO 回调。
2. **ResizeObserver 回环与泄漏**：在 RO 回调里同步改布局会报 `ResizeObserver loop`；现状靠 rAF 规避（对）。但**旧 observer 从不 disconnect**（`viewer.ts:540` 无 teardown），每次重挂新增一个 → 长时间使用泄漏。`destroy()` 必须收口。
3. **DPR 变化**：拖到另一块屏/系统缩放变化时，`devicePixelRatio` 变但 canvas CSS 尺寸可能不变 → 画面糊。现状每帧读 dpr 但只有宽高变化才重设背板；建议 `matchMedia('(resolution: Xdppx)')` 监听或每帧比较 dpr 并重设。
4. **asset URL 只能走 `convertFileSrc`**：CSP 是 `img-src 'self' asset: http://asset.localhost; media-src ...`（`tauri.conf.json:24`），**没有 `connect-src`** → `fetch(assetUrl)`/XHR 会被拦，`createImageBitmap(fetch(...))`、Worker 里抓像素都不可行。解码只能用 `<img>`。另外：Windows 路径含空格/中文/`#`/`%`、盘符、UNC 都靠 `convertFileSrc` 编码，**任何手拼 `asset://` 都会 404**；`convertFileSrc` 依赖 `window.__TAURI_INTERNALS__`，**不能在模块顶层调用**（纯浏览器/单测环境会抛）。
5. **缓存键 = 展示路径**：缓存键用代片路径（`a.avif.png`），与真实候选路径不同；若用真实路径做键会重复解码，若两处混用会让差异图缓存 key 失配。统一「展示路径进缓存，真实路径进结果表/导出」。
6. **代片缺失**：人工导入的 AVIF/JXL 没有 `<产物>.png`（`encode.rs:390-395` 只给产物写代片），`viewerPath()` 无差别改名 → 必然失败且文案误导。前端拿不到 `file_exists` IPC，只能：错误态点名「AVIF/JXL 需要由本工具生成代片」，并给出真实路径；若要根治需 Rust 侧在导入时补代片（超出本轮「不改 Rust」的边界）。
7. **解码失败无原因**：`img.onerror` 不区分 404 / CORS / 格式不支持。`crossOrigin='anonymous'` 必须保留（差异图要读像素），但 asset protocol 若不回 CORS 头会整体失败——改动这里等于改全局解码路径，先在真实窗口验证一次再动。**error 状态会永久钉死**，加载/错误态必须带 `invalidate` 重试。
8. **差异图内存峰值**：整图 `getImageData` 两张 + 输出 = `w*h*4*3` 字节（4000×3000 ≈ 138MB），再加两张解码位图。缓存只能留 1 份并给尺寸上限（如 > 4000 万像素降到按需/提示）；阈值拖动要 debounce（80–120ms）并做「上一帧结果 + 计算中角标」，别每 input 都重算。
9. **同步缩放的数值精度**：`zoom` 连续累乘会漂移，`1.0000001` 会让 `zoom < 1` 的严格比较关掉最近邻 → 用 epsilon（如 `1e-6`）判定 100%；`visibleRegion` 的 `src` 是浮点，不同尺寸/DPR 的格子并排看边缘会出现半像素错位 → `src` 取整（floor/ceil 对齐）并保证 `dst` 与 `src` 同比例。
10. **滚轮/指针冲突**：浮层/菜单打开时画布滚轮必须让位（`overscroll-behavior: contain`，别 `preventDefault` 全局滚轮）；原生 `<select>` 会吃掉滚轮并改值 → 换成 `openMenu` 后要确保菜单不穿透；沉浸模式锁页面滚动要配 `scrollbar-gutter: stable` 防页面横跳；HTML5 拖放（拖文件进舞台）与 pointer 拖拽共用左键，`pointercancel`/`dragstart` 必须收尾平移状态。
11. **快捷键冲突**：`1`–`6`、空格、`F`、`0` 都是外壳级快捷键；空格在按钮聚焦时会触发点击。判定顺序必须「有浮层 → 让浮层；焦点在输入控件 → 让控件；否则才归舞台」。参考 `ui/dom.ts` 的 `isTypingTarget()`/`hasOverlay()`。
12. **测试环境限制**：Vitest 默认 `environment: 'node'`（`vitest.config.ts` 只开了 `css: true`），**没有 DOM**。新逻辑要保持「纯函数可测」风格；要测 DOM 就得加 jsdom（违背「零新增依赖」口径，至少是 devDependency）。建议纯模块：`geometry.ts`（视口）、`selection.ts`（选图解析与落点）、`diff.ts`（像素差）、`zoom.ts`（档位/百分比/epsilon）、`layout.ts`（行列与最小行高）。
13. **与视频侧的 CSS 契约**：`video-compare.ts` 复用 9 个 `.viewer-*` 类名（见 2.2）。本轮两边都重写，正确做法是**各自拥有 CSS**（`viewer.css` / `video.css`），共享的只有 `viewport.ts`；切换类名必须与 video 负责人同一提交窗口完成，否则视频侧样式全丢（旧 `style.css` 里的 `.video-compare .viewer-area` 覆盖规则 `style.css:978-991` 会失效）。
14. **主题令牌迁移**：设计契约的画布令牌是 `--canvas` / `--canvas-checker`，旧代码读的是 `--canvas-bg`（`theme.ts:29-31`）。若 `core/theme.ts` 不跟着改，新画布会拿不到值 → 落到兜底 `#2b2b2b`，浅色主题下出现深色孤岛。建议画布底色完全交给 CSS（容器背景 + canvas `clearRect`），删掉每帧 `getComputedStyle`。
15. **大候选集**：分屏 N+1 栏在 10 张以上不可用；网格行高设下限并内部滚动。单槽模式的候选菜单在几十张候选时要能滚动，不把菜单撑出窗口。
16. **整页重渲染期的瞬时状态**：拖拽/长按/下拉展开都是 DOM 内瞬态，一旦 `update()` 重建对应节点就丢。`update()` 必须「结构键不变就不重建」，并把瞬态挂在节点之外（闭包）而不是每次重建重置。

## 6. Phase B 交接（文件与接口草案）

```
src/features/viewer/
  index.ts         注册 StageView（id 建议 'compare'，kinds:['image']），mount 一次 + update()
  stage.ts         舞台骨架：工具栏 / 画布区 / 覆盖层
  modes/split.ts | slider.ts | grid.ts | overlay.ts | diff.ts | blink.ts   六个绘制器，各含 attach/detach
  geometry.ts      ← viewport.ts 原样（含测试）
  selection.ts     ← resolveCandidatePath / resolveModeCandidatePath / isSingleSlotMode / resolvePaneImage / defaultPaneImage
  layout.ts        ← gridLayout（gridZoom* 退休）
  diff.ts          ← computeDiffData + 缓存策略（容量 1，带 key 与像素上限）
  decode.ts        ← 会话级图片缓存（LRU + invalidate + 就绪回调）
  zoom.ts          档位/百分比格式化/epsilon/键盘步进
src/styles/viewer.css   只含 .stage-* 与查看器私有类，不写别人目录的类
```

- 状态落位：`viewerMode` → `core/ui-state.ts` 的 `getPref/setPref`；其余 → `roundScoped('viewer', roundId, init)`；删除轮时由 lead 调 `dropRoundScoped(roundId)`（现状缺失的回收点）。
- 入参：沿用 `{ roundId, referencePath, candidates }`，**不要**把体积/指标塞进来；代片映射改为 `viewPath()`（归属见 4.6 第 6 项）。
- 提交前自检：`npm run typecheck`、`npm test`（纯逻辑新用例 + 既有 54 例不回归）、真实窗口截图（六模式 × 深浅主题 + 空态 + 错误态 + 沉浸）。
