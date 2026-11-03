# 设置与偏好（settings）现状勘察与重构规格

> 域负责人：settings。基线分支 `refactor/frontend-rebuild`。
> 本文是 Phase A（只读侦察）的产出，**不含实现**。实现归属见 §0.3。
> 读取顺序：先 `docs/refactor/frontend-redesign.md`（共同契约），再本文。

## 0. 前提

### 0.1 事实基线

- 现有实现：`src/settings-ui.ts`（831 行，全部 UI 与交互）、`src/settings.ts`（数据形状 + 纯函数）、`src/theme.ts`、`src/style.css:1076-1483`（设置面板样式）、`src/main.ts`（装配：`saveSettings`/`openSettings`/boot 加载/关闭回调）。
- 后端契约：`src-tauri/src/settings.rs`（字段、归一化、校验、serde）、`src-tauri/src/lib.rs:59-184`（6 个 IPC 命令）、`src-tauri/src/tool_status.rs`（工具状态与「关于」）、`src-tauri/src/ffmpeg_setup.rs`（下载链路）。
- lead 已落地的共享地基（**已存在，直接消费，不要复制**）：`src/core/settings.ts`（数据模型与纯函数，原样迁自 `src/settings.ts`）、`src/core/theme.ts`、`src/core/ipc.ts`（`settingsLoad`/`settingsSave`/`settingsToolStatus`/`aboutInfo`/`ffmpegCheck`/`ffmpegDownload`）、`src/core/store.ts`（`state.settings` + `setSettings`/`subscribe`）、`src/core/ffmpeg.ts`（`refreshFfmpeg()`/`ffmpegReady()`/`ffmpegReason()`）、`src/core/ui-state.ts`（`getPref`/`setPref`，`pixel-arena.ui.` 前缀）、`src/core/util.ts`（`versionLabel`/`copyText`）。

### 0.2 本轮不做

不改 Rust、不改 IPC 命令名与参数形状、不改 `settings.json` 字段、不加运行时依赖、不做设置项的功能扩张（只做信息架构与交互重写）。

### 0.3 文件归属（按 `frontend-redesign.md` §7.2）

| 归属 | 文件 |
| --- | --- |
| settings（我） | `src/features/settings/**`、`src/styles/settings.css` |
| lead | `src/core/settings.ts`（模型与读写）、`src/core/theme.ts`（主题应用）、`src/ui/overlay.ts`（`openModal`/`confirm`/`toast`）、`src/ui/primitives.ts`（`field`/`switchField`/`selectField`/`textField`/`section`/`badge`/`progressBar`）、`src/styles/tokens.css` |

设置面板不是注册式分区（不进 `registry.ts`），是浮层：需要 lead 在 `ui/overlay.ts` 提供一个设置用的打开入口（§5.2 有取舍）。

---

## 1. 现有设置项清单

### 1.1 字段全表

`settings.json` 用 serde `camelCase`（`src-tauri/src/settings.rs:93-127`）；前端 `SettingsData` 与之逐字段对应。

| 设置项 | JSON 字段 | 取值 | 默认 | 现有控件 | 落盘时机 |
| --- | --- | --- | --- | --- | --- |
| 记住上次状态 | `recordState` | bool | `true` | 自绘滑动开关（原生 `checkbox`） | 草稿 → 点「保存」 |
| 界面主题 | `theme` | `light` `dark` `system` | `dark` | 原生 `select` | **即时预览**（`change` 即 `applyTheme`）＋点「保存」落盘 |
| 跑分并发度 | `scoreConcurrency` | `quarter` `half` `threequarters` `full` | `half` | 原生 `select` | 草稿 → 保存 |
| 文件名冲突 | `conflictPolicy` | `auto` `ask` | `auto` | 原生 `select` | 草稿 → 保存 |
| 默认导出目录 | `defaultExportDir` | string\|null | `null` | `text` +「浏览…」+「清空」 | 草稿（`change`）→ 保存 |
| 最近目录 | `recentDir` | string\|null | `null` | 无控件 | 选文件后 `notePickedPath` **立即整体保存**（不经面板） |
| 窗口大小 | `window` | `{width,height}`\|null | `null` | 无控件 | 后端 `Resized` 事件写盘（`lib.rs:1532-1575`），不经面板 |
| 编码器路径 ×5 | `encoderOverrides.cjpeg/cwebp/avifenc/cjxl/avifdec` | string\|null | 全 `null` | 每行 `text` +「浏览…」+「清空」+ 发布页图标 | 草稿 → 保存 |
| FFmpeg 路径 | `ffmpegPath` | string\|null | `null` | `text` +「浏览…」+「清空」+「应用内下载」 | 草稿 → 保存；**下载按钮立即执行**（不写设置） |
| 格式版本 | `formatVersion` | number | `1` | 无控件 | 原样回传 |

面板整体语义（决策 D15–D18）：**所有改动先进 `draft`，点「保存」一次性整体提交**；只有主题例外（正文 §1.2 有说明，这是"看到实际效果"的唯一通道）。

### 1.2 保存时机与失败路径（现状）

`commitAll()`（`src/settings-ui.ts:253-269`）：

1. `host.save(clone(draft))` → `main.ts:127` → `invoke('settings_save')`；
2. 成功：`Object.assign(saved, next)`、`draft = clone(saved)`、清错误行、`applyTheme(saved.theme)`、`host.onApplied()`（= 主界面 `render()`）、`syncInputs()`（**整表重刷控件的值**）、`await refreshStatuses()`；
3. 失败：错误行写入 `String(err)`、`draft = clone(saved)`（**丢弃用户本次全部输入**）、`applyTheme(saved.theme)`、`syncInputs()`；
4. 保存期间「保存」按钮 `disabled` 且文案改「保存中…」（issue #42 的 pending 态）。

「恢复默认」不走草稿编辑，直接 `draft = defaultSettings()` → `applyTheme` → `syncInputs()` → `commitAll()`，即**一次点击就清空全部外部路径并落盘，无确认、无撤销**。

后端（`lib.rs:75-94`）：

```
settings_save(settings)
  ├─ normalized()：default_export_dir / recent_dir / 5 个 overrides / ffmpeg_path 的空白串 trim 成 null
  ├─ spawn_blocking {
  │    validate()?            // 见 §1.3
  │    save_to_file(path)?    // pretty JSON
  │  }
  ├─ 内存 settings 只在校验+写盘都成功后整体替换（半新半旧不返回）
  └─ apply_avifdec_env()      // 立即重算 PIXEL_ARENA_AVIFDEC（清空覆盖后回退捆绑/tools）
```

### 1.3 后端归一化与错误文案（前端要照抄进"错误就近显示"的设计）

校验（`settings.rs:189-231`），顺序固定，**首个失败即返回**：

| 触发条件 | 中文错误（原文） |
| --- | --- |
| 任一非空编码器路径不是文件 | `编码器 {tool} 的自定义路径无效：{path}（文件不存在）。请更正或在设置中清空该项（清空后恢复内置编码器）` |
| `defaultExportDir` 不是目录 | `默认导出目录无效：{dir}（目录不存在）` |
| `ffmpegPath` 指向不存在的文件 | `FFmpeg 自定义路径校验失败：ffmpeg 路径无效：{path}（文件不存在）。请更正或清空（清空后使用应用内下载的内置 ffmpeg）` |
| `ffmpegPath` 无法执行 | `FFmpeg 自定义路径校验失败：无法执行 ffmpeg（{path}）：{err}。请更正或清空（清空后使用应用内下载的内置 ffmpeg）` |
| `ffmpegPath` 退出码非 0 | `FFmpeg 自定义路径校验失败：ffmpeg（{path}）执行失败（退出码 N），请确认它是对应工具的可执行文件。请更正或清空…` |
| `ffmpegPath` 无输出 | `FFmpeg 自定义路径校验失败：ffmpeg（{path}）执行成功但未输出版本信息，无法确认可用性。请更正或清空…` |
| `ffmpegPath` 探测超时（5s，`DETECT_TIMEOUT`） | `FFmpeg 检测超时（5 秒无响应），该路径可能不是可用的 ffmpeg。请在设置页更正路径或应用内下载` |
| 写盘失败 | `写入设置文件失败: {err}` |
| 阻塞任务自身失败 | `设置保存任务执行失败: {err}` |

两个非对称要记住：

- **编码器路径只校验存在性（`is_file`），不校验可执行、不探版本**——所以坏路径能保存成功，之后状态显示「不可用」；
- **FFmpeg 路径会真的跑一次 `<path> -version`（≤5s）**——所以保存可能明显变慢，且这个探测在**每次** `settings_save` 都会跑（见风险 R2）。

读取侧：文件不存在或 JSON 损坏一律 `Settings::default()`（fail-soft，`settings.rs:155-161`），**前端拿不到任何"你的设置文件坏了"的信号**。

### 1.4 关闭面板后的刷新副作用

`openSettings()`（`main.ts:2140-2148`）只给了三个回调：`save`、`onApplied`（`render()`）、`onClosed`（`refreshFfmpegCheck()`）。落到效果：

| 项 | 何时生效 | 需要什么刷新 |
| --- | --- | --- |
| 主题 | 保存成功即 `applyTheme` → `data-theme` | `render()`（画布底色由 `canvasBg()` 现读 `--canvas-bg`，与界面同源；不重绘则旧画布颜色残留） |
| FFmpeg 路径 / 下载 | 后端每次使用现读 | **只在关闭面板时** `ffmpeg_check` → 主界面警告条 + 创建入口 `title`；面板开着时主界面看不到变化 |
| 编码器路径 | 后端每次使用现读 | 面板内 `settings_tool_status` 重探；主界面不展示编码器状态 |
| 跑分并发度 | 后端每条跑分命令现读（`score_concurrency_limit`） | 无需刷新 |
| 文件名冲突策略 | 后端每次写入前现读（`lib.rs:227-252`） | 无需刷新 |
| 默认导出目录 / 最近目录 | 下次打开对话框现读 | 无需刷新 |
| 记住上次状态 | 下次启动（`workspace_load` / `restore_window_size` 都按它门控） | 无需刷新（关掉后当前窗口不会缩回去） |
| 窗口大小 | 只在 `Resized` 时后端直写设置文件 | 面板不参与 |

`applied` 与 `closed` 的副作用是**脱钩**的：面板不关，主界面就一直拿着旧的 FFmpeg 结论。这一条在"设置常驻抽屉"的新形态下会变成真 bug（见风险 R5）。

---

## 2. FFmpeg 应用内下载完整链路

### 2.1 入口与调用

唯一入口是设置面板 FFmpeg 区的「应用内下载」按钮（`settings-ui.ts:491-512`）。视频跑分路径**不再自动下载**（决策 D1/D4，`ffmpeg_setup.rs:156-173`），缺失时只报错指引。

```
按钮 click
  → button.disabled = true（文案不变，仍是「应用内下载」）
  → ffmpegStatusHint.textContent = '准备下载…'      // 复用状态行那个 span
  → invoke('ffmpeg_download', { onProgress: Channel<String> })
      → lib.rs:170-184  spawn_blocking → ffmpeg_setup::ensure_ffmpeg(tools_dir, progress)
  → 成功后 await refreshStatuses()
  → 失败 catch: ffmpegStatusHint.textContent = `下载失败: ${String(err)}`
  → finally: button.disabled = false
```

`Channel<String>` 每帧就是一行中文进度文本，前端**只把它塞进状态行**，不解析、不进度条。

### 2.2 后端步骤与逐条进度文案（`ffmpeg_setup.rs`）

| 步骤 | 进度文本 | 备注 |
| --- | --- | --- |
| 0 | **无任何消息** | `tools/ffmpeg(.exe)` 已存在 → 直接返回（`existing_ffmpeg_is_reused_without_network` 测试锚定）。所以"已装过"的机器点按钮会毫无反馈 |
| 1 下载 | `正在下载 ffmpeg（一次性，约 {N} MB）… {a.b} / {c.d} MB`，无 `Content-Length` 时 `正在下载 ffmpeg（一次性）… {a.b} MB` | 每约 2MB 报一次；写到 `tools/ffmpeg.tar.xz.tmp`；核心库 `net::download` 复用系统代理，512MB 硬上限 |
| 2 校验 | `正在校验 ffmpeg 完整性…` | 全量 sha256 比对代码内锁定值（三端各一）。不匹配 → 删文件 + `下载的 ffmpeg 校验失败（sha256 不匹配），已删除。可能是网络劫持或上游构建变动，请重试或反馈` |
| 3 解压 | `正在解压 ffmpeg…` | Linux `tar.xz`、Windows/macOS `zip`；macOS 的 ffmpeg 与 ffprobe 是两个独立 zip，分开校验 |
| 4 落位 | `ffmpeg 就绪` | 写来源注文件；返回 ffmpeg 绝对路径字符串（前端丢弃不用） |

锁定版本：Linux 7.0.2 / Windows 7.1 / macOS 9.0.2（`FFMPEG_VERSION`，也是「关于」清单的版本源）。全部为 GPL 静态构建、含 libvmaf。

### 2.3 失败处理现状

- 唯一出口是把 `String(err)` 拼成一行红字 `下载失败: …` 塞进状态行；**没有重试按钮、没有错误分级、没有"是网络还是校验还是磁盘"的区分**；
- `refreshStatuses()` 在 `finally` 之前不会跑，失败的下载不会重置徽标（徽标仍显示下载前的状态）；
- 失败后 tmp 文件在多数分支会被删除（`download_to_file` 失败、sha256 不匹配、读文件失败），但进程被强杀会留下 `ffmpeg.tar.xz.tmp`（下次下载会覆盖）。

### 2.4 「下载中不允许关闭？」

现状：**允许关闭，且没有任何拦截或提醒**。后果一串：

1. `overlay.remove()` 后，下载闭包仍在跑，进度写进已脱离文档的 `ffmpegStatusHint`；
2. 用户回到主界面，FFmpeg 警告条**不会自己消失**（警告条只在面板关闭那一刻 `refreshFfmpegCheck`，而关闭发生时下载还没完成）；
3. 立刻重开面板，按钮已经恢复可用（新实例），可以**再点一次** → 两个并发 `ensure_ffmpeg` 写同一个 `tools/ffmpeg.tar.xz.tmp`（后端无互斥），可能得到损坏的压缩包（随后被 sha256 拦下，表现为"下载失败"）；
4. 下载完成后再关一次面板，警告条才更新。

结论：新实现必须把下载做成**脱离面板生命周期的任务**（§5.4），并且在 UI 层做单飞（模块级 inflight Promise），不依赖后端加锁。

---

## 3. 编码器区

### 3.1 行结构（现状）

每个编码器一行：状态行（徽标 + 版本简写 + ⓘ 气泡）+ 控件行（名称 + 文本框 +「浏览…」+「清空」+ 发布页图标）。

- 徽标文本来自 `sourceLabel()`：`内置` / `外部` / `未配置` / `不可用`（`core/settings.ts:111-120`）；
- 行内只显示 `versionLabel()` 简化版本（`mozjpeg version 4.1.5 (build …)` → `v4.1.5`）；完整探测原文 + `hint` 塞进 ⓘ 气泡（hover / `focus-within` 展开）；
- 5 行固定顺序：`cjpeg`(JPEG) `cwebp`(WebP) `avifenc`(AVIF 编码) `cjxl`(JPEG XL) `avifdec`(AVIF 解码，产物代片用)；字段清单是 `ENCODER_FIELDS`（单一来源，别在前端另抄一份标签）。

### 3.2 状态判定（后端唯一真源）

`settings_tool_status()` → `ToolStatus[]`，**顺序固定** `ffmpeg, cjpeg, cwebp, avifenc, cjxl, avifdec`（`tool_status.rs:256-294`）：

| 字段 | 含义 | 前端现状 |
| --- | --- | --- |
| `key` | 工具键 | 用来和行匹配 |
| `source` | `builtin` / `external` / `unconfigured` / `unavailable` | 渲染徽标 |
| `overridePath` | 设置里的覆盖路径 | 未渲染 |
| `effectivePath` | **实际生效的可执行文件绝对路径** | **未渲染**（只在 title/错误里间接出现） |
| `builtinVersion` | 锁定清单里的内置版本 | 与 `detectedVersion` 二选一显示 |
| `builtinInstalled` | 内置是否已落位 | 未渲染 |
| `detectedVersion` | 实跑探测到的版本首行 | 简化后显示 |
| `releasePage` | 官方发布页（https），ffmpeg 为 null | 渲染成图标链接 |
| `hint` | 中文补全说明（缺失/损坏时） | ⓘ 气泡里 |

判定逻辑（`tool_status.rs:139-205`）：

- 有覆盖 → 路径是文件才能探测；探测成功 `external`，失败 `unavailable` + `{err}。请更正该路径，或清空该项回退内置`；
- 无覆盖 → 内置（捆绑 `resource_dir/encoders/<member>` 优先，回落 `tools/<name>/<version>/<member>`）：探测成功 `builtin`，失败 `unavailable` + 捆绑损坏/内置损坏两套文案；
- 两边都没有 → `unconfigured`，hint 为：
  - ffmpeg：`视频跑分前需要 FFmpeg：可在设置页点击「应用内下载」，或指定本机已有的 ffmpeg`
  - 编码器：`内置文件缺失（可能被安全软件移除，或旧版本安装包未捆绑）：请从官方发布页下载编码器，保存后在下方指定其路径，或重新安装应用`

探测细节（决定 UI 的"检测中"能挂多久）：`probe_tool_version` 依次试 `--version` 与 `-version`，stdout 空回退 stderr，**阻塞 `.output()`，没有超时**。6 个工具最坏 12 次子进程；外部路径挂死时这个请求永不返回（见风险 R7）。

`advanced_encoder_status(keys)`（`lib.rs:123-142`）与设置页**完全同源**（`tool_status_for_keys`），供高级创建建轮前批量查；键序按请求序、未知键跳过。

### 3.3 内置/外部切换的用户心智

- 文本框留空 = 用内置（placeholder「内置」）；填路径 = 优先用外部；
- 「官方发布页」图标按钮：`releasePageHref()` 过 `https://` 白名单，安全则给 `href`，否则 `removeAttribute('href')` + `aria-disabled="true"`；`target="_blank" rel="noopener noreferrer"` 由 opener 插件转系统浏览器（`capabilities/default.json` 已放行 `opener:allow-open-url`）；
- 缺失时的中文指引目前只写在 `hint` 与 ⓘ 气泡里，**没有任何可点的下一步**（除了那个 12px 的图标），用户读完还得自己找文件夹。

---

## 4. 现有交互问题清单

按影响排序，每条都带证据位置。

### P1 长面板 + 双层滚动，保存按钮会滚出视野

`600px` 宽、`max-height: calc(100vh - 4rem)`、整块 `overflow: auto`（`style.css:1089-1099`）。只有 `.settings-head` 是 `sticky`；`.settings-actions`（保存/恢复默认）、`.settings-error`、`.settings-about`（注释写着"固定底部"，实现是流程内最后一个 section）都随内容滚走。内容总高在小屏上要滚 3 屏以上才看得到「保存」。

### P2 没有焦点管理，没有 Esc

- 打开面板不聚焦任何元素、不捕获 Tab（Tab 可以跑到遮罩后面的主界面）、关闭不还原焦点；
- **设置面板没有 Esc 关闭**（`settings-ui.ts` 全文无 `keydown`），而共享的 `modal-card.ts` 有 Esc——同一应用两套浮层两种规则；
- 遮罩关闭只认点击 `e.target === overlay`。

### P3 没有"未保存改动"保护，失败即丢输入

主题以外的改动都在 `draft` 里，点遮罩 / × 直接 `overlay.remove()` 销毁，无提示、无草稿恢复。保存失败时 `draft = clone(saved)` + `syncInputs()`：**刚填的 1 条导出目录 + 5 条编码器路径 + FFmpeg 路径一次性全部回退**，只留一行红字说明第一个错在哪。

### P4 保存成功/失败都"整表闪一次"

`commitAll` 的两个分支都调 `syncInputs()`（每个控件都重设 `.value`），失败还会把主题弹回去。成功分支紧接着 `await refreshStatuses()`：徽标先被 `renderStatus` 推回"检测中…"，再等 6 个工具的探测结果逐个回填——视觉上是一次可感知的闪烁，外部编码器慢时能闪好几秒。

### P5 错误无法定位到具体项

错误只有一行 `.settings-error`（`style.css:1278-1283`），5 个编码器行、导出目录行、FFmpeg 行都没有各自的错误位。后端错误语义其实已经能定位（文案里带 `{tool}` / `{path}`），但前端只做字符串直出，用户要在 6 个输入框里自己找是哪一条。

### P6 「恢复默认」是无声的破坏性操作

一次点击 = 清空 6 条外部路径 + 改并发/主题/目录，并立即落盘（`settings-ui.ts:657-668`）。没有确认、没有"将被清空的 N 条路径"预览、没有撤销。这是全应用唯一一处无确认的高影响操作（对比：关闭有内容的分组都要 `confirm`）。

### P7 看不到"实际生效的是什么"

`effectivePath`（实际会用的可执行文件）后端已经给了，前端从不渲染：用户只能看到「外部」两个字，看不到生效路径，也没法在面板里确认"我这台机器现在到底用的是哪个 ffmpeg"。要判断能不能跑视频，得关掉面板去看主界面警告条。

### P8 下载进度寄生在状态行里

进度文本、版本号、错误文案共用同一个 `ffmpegStatusHint` span；没有进度条、没有百分比条、没有取消按钮；按钮只 `disabled` 不改文案（用户读不到"正在进行"）；关面板即失联（§2.4）。

### P9 表单与无障碍细节欠账（web-design-guidelines 逐条对得上）

- 标签用 `<span class="settings-label">`，**不是 `<label>`**，与控件无关联，点标签不聚焦输入框；
- 输入框没有 `name`、没有 `autocomplete="off"`、没有 `spellcheck="false"`（路径字段）；
- 「×」关闭按钮只有 `title`，没有 `aria-label`；发布页图标 `<a>` 无 `href` + `aria-disabled`（不可聚焦，键盘用户拿不到）；
- 异步状态（检测结果、下载进度、保存错误）没有 `aria-live`；
- 发布页图标点击区 1.5rem（24px），低于 32px 控件高度基线；
- `settings-bubble` 用 `hover`/`focus-within`，键盘可达但**触屏不可达**（桌面应用可接受，但要在新实现里保留 `focus-visible` 等价物）。

---

## 5. 新交互提案（5 条，按价值排序）

### 5.1 逐字段即时生效，把"保存"从一次冒险改成一次无感操作

**做法**：主题、记住状态、并发度、冲突策略、导出目录、编码器路径、FFmpeg 路径全部改为「改完即存」，但保存单位是**单字段**而不是整份对象：

- 内存里维护 `latest: SettingsData`（以 `store.state.settings` 为基线），每次编辑 `latest = merge(latest, patch)`，进一个**串行队列**（同一时刻只有一个 `settings_save` inflight，后来的排队，合并成一次）；
- 文本类字段（路径、导出目录）在 `change`/`blur` 时提交，输入过程中只更新界面；`compositionend` 后不抢焦点；
- 保存成功：`setSettings(返回的归一化对象)`，**只回写该字段对应控件**，不 `syncInputs` 全量重刷；
- 保存失败：该字段就地显示后端中文原因（错误文案已带路径，够具体），**输入框保留用户输入**并标 `aria-invalid`，旁边给「清空该项」按钮（后端文案本身就说了"清空恢复内置"）；
- 面板顶部右侧显示轻量的保存态：`已保存` / `保存中…` / `未保存`（`aria-live="polite"`），不需要"保存"主按钮。

**为什么排第一**：P3、P4、P5 三个问题的根因都是"整份提交 + 失败整份回滚"。改完即存之后，面板从"一次性提交的大表单"变成"无状态的视图"，关闭面板不再有"丢了没"的焦虑，也不再需要 `onClosed` 兜副作用。

**依赖**：需要 `core/settings.ts` 提供一个收口函数（例如 `saveSettingsPatch(patch)`：merge + 串行 + 失败抛出但不改 store），否则每个域都要自己写队列。**这条要找 lead 确认归属**；退一步的实现是在 `features/settings/` 内自持队列，只允许设置面板调用。

**验收**：保存失败时输入框内容仍在；连续改 3 个字段只产生 ≤2 次 IPC（合并）；改完后关面板不丢改动。

### 5.2 居中窗口 + 分区导航（外观 / 记录 / 跑分与导出 / FFmpeg / 编码器 / 关于）

**做法**：面板改为居中弹出的窗口，宽 720px、高 640px（窄窗按「视口 − 浮层上下留白」收敛），左侧一条分区导航，右侧内容区独立滚动；头部只放标题 + 关闭，底部状态条显示保存态与「全部恢复默认」。

**为什么**：解决 P1（不用滚 3 屏）、左侧导航让分区一眼可见；固定高度保证换分区时窗口不跳（各分区内容量差得多）。

**取舍**：原先落成的是右侧抽屉（`overlay--drawer`，满窗高度贴右边缘）。维护者看过后要求「设置窗口居中显示」：抽屉只占半个窗口、视觉重心偏右，满窗高度语义也与居中打架，于是抽屉变体整体删除（只有设置一处使用），全部走 `openModal` 的居中外壳，居中后 `:has` 给设置定高。代价是设置会遮住舞台中部——但设置是短时操作，且遮罩语义本来就要求「先处理设置」。

**验收**：`Ctrl+,` 打开、Esc 关闭、焦点进面板并被捕获、关闭后焦点回到顶部栏「设置」按钮；内容区滚动时头部与状态条固定。

### 5.3 「全部恢复默认」加确认与影响预览

**做法**：`ui/overlay.confirm({ title: '恢复默认设置？', message: '将清空 3 条编码器路径与 1 条 FFmpeg 路径，并恢复默认主题、并发度和导出目录。', confirmLabel: '恢复默认', danger: true })`。文案里的数字**按当前实际非空项算**，为 0 时不提路径。

**为什么**：P6；这是唯一一处无确认的破坏性操作，成本极低，收益确定。

**验收**：取消 → 设置一个字节都不变；确认 → 全部路径清空、主题回默认、状态徽标重探。

### 5.4 FFmpeg 下载改成独立任务，进度与面板解耦

**做法**：

- 模块级 `let inflight: Promise<string> | null`，`startFfmpegDownload()` 做到单飞（第二次点击直接复用同一个 Promise）；
- 进度进 `store`（`beginBusy('ffmpeg-download', '正在下载内置 FFmpeg', …)` + `updateBusy` 的 detail 显示后端文本），面板内 FFmpeg 区显示 `progressBar`（解析 `{a.b} / {c.d} MB` 得确定进度，解析不出走不确定态 + 文本），关面板后主界面状态栏/结果坞仍能看到同一条任务；
- 完成 → `refreshFfmpeg()` + `refreshStatuses()`，`toast('内置 FFmpeg 已就绪', 'ok')`；失败 → `toast(原因, 'danger', { label: '重试', onSelect: startFfmpegDownload })`，并保留原文在状态栏详情里；
- 文案改成进行中可见：按钮在跑时文案 `下载中…` 且 `disabled`；已安装时按钮文案 `重新下载并校验`（后端幂等覆盖，同时补齐 ffprobe）。

**注意**：真"取消"需要后端配合（没有 cancel 通道），本轮不做；但**关闭面板不中断 + 单飞 + 回到主界面仍可见**这三件事纯前端就能做到，能消掉 §2.4 的全部四个坑。

**验收**：下载中关面板 → 主界面仍有任务提示；重开面板 → 按钮是「下载中…」且不可重复点击；完成后 FFmpeg 警告条与徽标同步更新（不依赖关面板）。

### 5.5 版本与诊断信息可复制

**做法**：关于区（或"诊断"折叠区）给一个「复制诊断信息」按钮，内容用纯文本：

```
Pixel Arena v0.1.x / 核心库 v0.1.x
FFmpeg: 7.1（内置，C:\...\tools\ffmpeg.exe）
cjpeg: v4.1.5（内置）
cwebp: 未配置（内置文件缺失）
...
设置文件: 前端拿不到路径（无 IPC），本轮不展示
```

- 复制走 `core/util.copyText`，成功后按钮文案就地变「已复制」2 秒（不做 toast，符合"表单错误不用 toast 代替"的同源取向）；
- 数据源：`about_info`（app/core 版本）+ `settings_tool_status`（每行的 `source`/`effectivePath`/版本）；`settings.json` 路径前端拿不到，**先不写**（不新增 IPC）。

**为什么**：顺手解决 P7 的一半——用户能一眼看到"实际生效路径"，出问题也能一次复制给别人。

**验收**：点按钮 → 剪贴板内容包含 6 个工具的生效路径与版本；无权限/不可用时按钮不静默失败（显示「复制失败」）。

### 5.6 文案对照（改的地方，遵循 active voice + 具体按钮名）

| 现状 | 建议 | 理由 |
| --- | --- | --- |
| 「应用内下载」 | 空闲：`下载内置 FFmpeg`；已装：`重新下载并校验`；进行中：`下载中…` | 按钮说清动作；进行态可读 |
| 「恢复默认」 | `全部恢复默认`（弹确认） | 说清影响范围 |
| 「保存」 | 顶部状态条 `已保存` / `保存中…` / `未保存` | 改完即存后不需要主按钮 |
| 「下载失败: {err}」 | `下载失败：{原因}。请检查网络后重试` + 重试入口 | 错误给下一步 |
| 「检测中…」 | 保留，但加超时降级：`检测超时，点此重试` | 后端探测无超时 |
| 「检测失败」（徽标） | `检测失败，点此重试`（可点） | 后端探测无超时，必须有重试出口 |
| 「恢复默认」后无反馈 | `已恢复默认设置`（状态条，3 秒静默） | 破坏性动作完成后要能确认结果 |

---

## 6. 风险与坑

### R1 全量覆盖的保存竞态（最高优先级）

`settings_save` 是**整份对象覆盖**。面板的 `draft` 是打开那一刻的快照，而 `recentDir` 会被 `notePickedPath` 随时整份保存（`main.ts:139-146`），`window` 会被后端 `Resized` 直写（`lib.rs:1532-1575`）。于是：面板打开期间用户选了文件 → 后端写进 `recentDir`；面板随后点保存 → 把打开时的旧 `recentDir` 写回去。窗口大小同理（后端内存里是新值，但面板提交的对象里是旧值，`lib.rs:89` 会用它覆盖内存）。

**对策**：新实现必须在提交前**以 `store.state.settings` 的最新值为基线做字段级 merge**（只发送被改的字段覆盖到最新基线上），并且全局串行化；不能沿用"打开时快照 + 整份提交"。这条要在 lead 确认 `core/settings.ts` 是否提供 merge 收口。

### R2 每次选图都在跑 FFmpeg 探测

`notePickedPath` → `saveSettings(整份)` → 后端 `validate()` → 若 `ffmpegPath` 非空，**每次选图都 spawn 一次 `ffmpeg -version`（≤5s）**（issue #42 只把它挪到 `spawn_blocking`，没消除重复探测）。改完即存（§5.1）会让写入频率更高，症状放大。

**对策**：前端层面把"轻量偏好写入"（`recentDir`、主题、并发度）与"会触发校验的写入"（任何路径字段）分开；轻量写入走同一队列但**不要每次都带路径字段**（字段级 merge 天然满足）；后端优化属另一张票，不在本轮范围。

### R3 重渲染丢焦点 / 丢输入

现状 `syncInputs()` 全量重刷；新实现若继续"保存成功后重建控件"，用户正在输入的下一个框会失焦、`selectionStart` 丢失。**对策**：字段级 `setValue()` 只改值不改 DOM；保存回写前判断 `document.activeElement === input && value 相同` 就跳过；所有异步回写都在 `compositionend` 之后（中文路径输入尤其要注意 IME 组合态）。

### R4 主题切换与画布颜色必须同源

`applyTheme()` 只写 `data-theme`；画布底色由 `canvasBg()` **现读** `--canvas-bg`（`core/theme.ts:28-32`）。新实现若把底色缓存进变量、或在 `requestAnimationFrame` 里画之前不重新读，切主题后画布会停在旧色。**对策**：主题变更后显式通知 stage 重绘（`store` 通知已有，视图 `update()` 里重读 `canvasBg()`）；不走任何硬编码色值。

### R5 「关闭面板才刷新 FFmpeg」在常驻形态下会失效

`onClosed → refreshFfmpegCheck()` 是唯一的刷新时机。若设置改成抽屉/常驻、或"下载完不关面板"，主界面警告条会停在旧状态。**对策**：把刷新时机从"关闭"改为"保存成功 / 下载完成"，直接在 `features/settings` 里调 `core/ffmpeg.refreshFfmpeg()`；`onClosed` 只留作"关闭后焦点还原"。

### R6 下载并发无互斥（后端）

`ensure_ffmpeg` 直接写 `tools/ffmpeg.tar.xz.tmp`，两个并发调用会互相踩。后端无锁、无下载状态查询。**对策**：UI 层模块级单飞 + 不因面板关闭而取消；不要给用户留"再点一次"的入口。

### R7 工具探测无超时

`probe_tool_version` 用阻塞 `.output()`，没有超时（对比 `probe_executable_version_timed` 有 5s）。外部编码器路径指向一个挂死的程序时，`settings_tool_status` 永不返回，面板永远"检测中…"，且**没有重试按钮**。**对策**：前端做 8s 软超时 → 显示「检测超时，点此重试」；状态区永远给"重新检测"入口；不要用 `disabled` 锁死其它设置项。

### R8 状态刷新风暴

一次 `refreshStatuses` = 6 个工具 × 最多 2 次子进程。改完即存后若不防抖，每改一个字符都可能触发一轮。**对策**：只在影响工具的字段（`ffmpegPath`、`encoderOverrides.*`）变化时重探，其余字段跳过；再加 300ms 防抖 + 单飞。

### R9 错误文案只能字符串直出

后端错误没有结构化字段（错误里只有中文），前端要"错误就近显示"就得靠文案里的 `{tool}` / `{path}` 反解——脆。**对策**：前端做**提交前归属**（这次提交改的是哪个字段，就把失败文案挂到哪个控件旁），不解析字符串；批量失败（不会发生，validate 遇错即返回）也不猜。

### R10 移动共享代码会破现有引用

`src/encoder-card.ts:17` 从 `./settings-ui` 导入 `infoIconSvg` 与 `wireBubbleFlip`；`src/bubble-flip.test.ts`、`src/advanced-ui.test.ts` 也依赖它们（`wireBubbleFlip` 还是 `export`，有测试锚定）。设置面板重写后这两个符号不能随旧文件一起消失。**对策**：气泡与 ⓘ 图标在新架构里属于 `ui/popover` 或 `ui/icons`（lead 的地盘）；在 lead 提供前，`features/settings` 不做删除动作，由 lead 决定是平移还是换 API（**需要 Phase B 明确**）。

### R11 后端 fail-soft 读取不可见

`settings.json` 损坏时静默回落默认值。新面板可以在"关于/诊断"区展示当前生效值供对照，但**不要**假装能读到"文件已损坏"（没有 IPC）。若要提示，需 lead 加 IPC，本轮不做。

---

## 7. 硬约束提炼（本仓库 skills，实现时必须遵守）

### 7.1 桌面工程（`desktop-agent-ui` + `references/desktop-pitfalls.md`）

- **弹窗打开时页面跳动**：根滚动容器用 `scrollbar-gutter: stable` 预留槽位，**禁止**手写 `padding-right` 补偿（§4）。
- **焦点**：浮层做捕获与还原；`sticky` 头不得盖住聚焦元素；关闭后焦点回触发按钮。
- **发丝线**：一律 `0.5px solid var(--line)`，不用 1px 实线；高亮态 `--line-strong`。
- **字号阶梯**：只用 `12/13/15` 三档，**最小 12px 硬门禁**，靠字重与灰阶造层次。
- **同心圆角**：`R_inner = max(0, R_outer - padding)`；`padding >= R_outer` 时内层取 0–2px。
- **禁中点「·」**：一律改 `flex + gap` 或 0.5px 细分隔线；**禁左边缘彩条**；**禁每个卡片一段解释性副标题**。
- 状态语义不能只靠颜色；真实进度不能用假动画；`overflow: hidden` 不得为了阴影随手全局改 `visible`。

### 7.2 动效（`frontend-animation-patterns`）

- `selection-matrix` 对应行：**Modal open/close**（大位移要避免、退出要快）、**Panel reveal**（侧栏/抽屉，优先 `transform`）、**Toggle**（原生语义 + 状态可见）、**Progress**（确定进度必须有文本值，禁止假百分比）、**Toast**（普通状态更新不上庆祝动效，关键错误不自动消失）。
- 面板开合 160ms，只动 `transform`/`opacity`；不要 `transition: all`；开关 150ms 背景 + 滑块位移。
- **口径冲突已裁决**（`frontend-redesign.md` §5，记入 decisions）：`frontend-animation-patterns` 要求忽略系统减少动效设置，`desktop-agent-ui` 与 `web-design-guidelines` 要求尊重——取交集：**功能性反馈保留，装饰性/循环动效砍**。设置面板里没有装饰动效，因此不写 `prefers-reduced-motion` 分支，也不新增"动效开关"设置项。

### 7.3 文案（`frontend-design`）

- 主动语态；按钮说清按下发生什么（`下载内置 FFmpeg`，不是 `确定`）。
- 一个动作全流程同名（按钮「删除」→ 提示「已删除」）。
- 错误说明发生了什么 + 下一步；不道歉、不含糊。失败不是情绪，是方向。
- 不写装饰性副标题；标签让布局说话。

### 7.4 表单与可访问性（`web-design-guidelines`）

- 每个控件有 `<label>`（包裹或 `for`），点标签聚焦控件；
- `autocomplete="off"`（非认证字段）、路径字段 `spellcheck="false"`、等宽字体；
- 错误**就近**写在控件旁，不用 toast 代替；提交失败聚焦第一个错误控件；
- 交互元素必须有 `:focus-visible`（禁 `outline: none` 无替代）；
- 破坏性操作要确认或可撤销（§5.3）；
- 异步状态文本 `aria-live="polite"`；图标按钮必带 `aria-label`（`aria-label` 落到按钮，`title` 只是补充）；
- 加载文案以「…」结尾（`下载中…`）；数字列 `tabular-nums`；
- `prefers-reduced-motion`：本项目按 §7.2 的裁决处理（功能性动效不砍），不因系统设置关闭面板开合动效。

---

## 8. 契约速查（实现时照这个写，不要猜）

```ts
// src/core/ipc.ts（已存在，直接调用；禁止在组件里裸 invoke）
settingsLoad(): Promise<SettingsData>
settingsSave(settings: SettingsData): Promise<SettingsData>   // 失败 reject(中文)
settingsToolStatus(): Promise<ToolStatus[]>                    // 顺序：ffmpeg, cjpeg, cwebp, avifenc, cjxl, avifdec
aboutInfo(): Promise<AboutData>
ffmpegCheck(): Promise<FFmpegCheck>
ffmpegDownload(onProgress: (message: string) => void): Promise<string>

// src/core/store.ts
getState().settings: SettingsData | null
setSettings(settings: SettingsData): void
subscribe(fn): () => void
beginBusy(id, label, running?) / updateBusy(id, patch) / endBusy(id)
setStatus(text, { detail?, isError? })

// src/core/ffmpeg.ts
refreshFfmpeg(): Promise<FFmpegCheck>   // 并发复用同一次探测
ffmpegReady() / ffmpegReason()

// src/core/settings.ts
SettingsData / ToolStatus / AboutData / ENCODER_FIELDS / sourceLabel / releasePageHref
defaultSettings() / isSafeLibraryUrl / versionLabel(core/util)

// src/ui/overlay.ts（lead 提供）
openModal({ title, body, footer?, width?, onClose? }): { close(), setBody(node), setFooter(node) }
confirm({ title, message, confirmLabel, cancelLabel?, danger? }): Promise<boolean>
toast(message, kind?, action?)
```

`SettingsData` 全字段见 `src/core/settings.ts:30-44`；`ToolStatus` 见 `src/core/settings.ts:96-108`。

---

## 9. 待 lead 拍板（Phase B 需要回答）

1. **保存收口归属**：`core/settings.ts` 是否提供 `saveSettingsPatch(patch)`（字段级 merge + 串行队列 + 失败语义）？如果不提供，我在 `features/settings/` 内自持队列，但 `notePickedPath` 那条并发写入路径仍需 lead 处理（R1）。
2. **浮层形态**：`ui/overlay.ts` 加 `openDrawer`，还是先用 `openModal` 的宽变体？（§5.2）
3. **气泡与 ⓘ 图标的归属**：`wireBubbleFlip`/`infoIconSvg` 迁到哪里（R10）？`encoder-card` 的引用由谁改？
4. **`paint(host, key, build)` 的具体签名**（`ui/dom.ts`），设置面板要用它保护正在编辑的输入框。
5. **进度进 store 的约定**：`beginBusy('ffmpeg-download', …)` 这个 id 是否允许外部域占用，状态栏是否展示 busy detail。
6. **验收方式**：设置面板的截图清单（深/浅两主题 + 下载中 + 保存失败 + 一个「不可用」编码器行）。

## 10. Phase B 落地骨架（提案，等 lead 确认后执行）

```
src/features/settings/
├─ index.ts          // openSettings()：外壳 + 分区导航 + 生命周期（唯一对外导出）
├─ state.ts          // 纯逻辑：草稿合并、字段归属、串行保存队列、状态文本格式化（可单测）
├─ sections/
│  ├─ appearance.ts  // 主题（分段控件 or selectField）
│  ├─ recording.ts   // 记住上次状态 + 默认导出目录
│  ├─ scoring.ts     // 并发度 + 文件名冲突
│  ├─ ffmpeg.ts      // 状态行 + 路径 + 下载任务 + 进度
│  ├─ encoders.ts    // 5 行状态 + 路径 + 发布页 + 重探
│  └─ about.ts       // 版本 + 库清单 + 复制诊断
└─ state.test.ts     // 纯函数单测（不依赖 DOM）
src/styles/settings.css   // 只写面板自身；浮层/控件外观来自 ui 与 tokens
```

- 纯逻辑（`state.ts`）必须能脱离 DOM 单测：合并、串行、错误归属、进度文本解析（`{a.b} / {c.d} MB` → 0–1）。
- 不新增运行时依赖；不写 `innerHTML`；所有可聚焦元素有 `:focus-visible`。
- 交付验证：`cargo test --workspace`、`npm run typecheck`、`npm test`、`cargo run -p pixel-arena-cli -- --version`，加桌面窗口截图（见 §9.6）。

## 11. Phase B 实现注记（已完成）

实际落点（与上面的提案骨架有几处合并，理由随行）：

```
src/features/settings/
├─ index.ts          // 注册 open-settings 命令（外壳 import 即生效）
├─ dialog.ts         // 居中外壳：导航 / 分区装配 / 生命周期 / 底部状态
├─ context.ts        // SettingsCtx 与 SectionModule 接口（分区只依赖它）
├─ model.ts          // 纯逻辑：选项、四态映射、并发换算、进度解析、诊断文本
├─ model.test.ts     // 33 个纯函数/状态机用例（node 环境，无 DOM）
├─ fields.ts         // attemptSave、pathField、selectWithError、switchWithError
├─ tool-row.ts       // 工具状态行（就地 update）
├─ tools.ts          // 工具状态观察器：8s 软超时 + 晚到结果丢弃
├─ download.ts       // FFmpeg 下载模块级状态机（单飞、不随面板关闭中断）
└─ sections/{appearance,recording,scoring,ffmpeg,encoders,about}.ts
```

与提案的差异与理由：

1. **没有 `state.ts`**：保存收口在 `core/settings-save.ts`（lead 提供），本域只留 `attemptSave` 薄封装与纯逻辑，不需要自持草稿/队列。
2. **路径字段不用 `field()`**：`field()` 输出 `<label>` 包控件，而路径行要放「浏览…」「清空」两个 `<button>`；`label` 内除被标注控件外不能再有可标注元素。改为等价的可访问结构：`<label for>` + `<div class="field__row">` + `.field__error`。下拉与开关仍走 `selectField`/`switchField` 原语。
3. **两个「重新检测」按钮共用一次探测**：后端只有 `settings_tool_status`（一次返回全部工具），没有按键探测的命令；点任一区的按钮刷新的是同一份快照，界面上只更新本区可见的行。
4. **`attemptSave` 从状态栏读回失败原因**：`core/settings-save` 的失败语义是「只写状态栏、不改内存」，前端要就地报错就得摘那条文案（前缀常量在两个模块之间，改动需同步）。
5. **下载的「取消」不做**：后端没有取消通道；已做到单飞、关面板不中断、状态可重开、失败可重试。

