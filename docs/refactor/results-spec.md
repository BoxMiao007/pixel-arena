# 结果与导出（results）重构规格

本文件是本次重构中「评分结果表 + 效率对比 + 导出 CSV/HTML」这一域的施工依据。上级契约见
[docs/refactor/frontend-redesign.md](frontend-redesign.md)：结果坞形态、视觉令牌、组件原语、注册契约与文件归属都以它为准。

**归属**：`src/features/results/**` + `src/styles/results.css`（见上级文档 §7.2）。本域不得修改 `src/core/**`、`src/ui/**`、`src/shell/**` 与其他功能域目录。

**不改的东西**：IPC 命令名/参数/返回结构（`round_export` 等）、导出文件格式（CSV/HTML 的内容由核心库 `report.rs` 生成）、数据模型。核心库 `report.rs` 的单测与 `src-tauri/tests/export.rs` 必须通过。BD-rate 已按决策 0035 整体下线（页签、IPC 与导出节一并删除），本文不再覆盖。

现状代码位置（重构前的唯一真源，实现前先读，重写后删除）：

| 内容 | 位置 |
| --- | --- |
| 指标列推导、排序取值、默认方向、结果表构建 | `src/main.ts:1620-1824` |
| 数值格式化（大小/体积比/指标） | `src/main.ts:1828-1843` |
| 导出文件名、导出动作、导出按钮 | `src/main.ts:1128-1174`、`src/main.ts:1363-1378` |
| 结果表的挂载点 | `src/main.ts:1549-1560`（图片组）、`src/main.ts:1579-1588`（视频组遗留图片内容） |
| 排序状态（按轮保存） | `src/main.ts:161-167`、`src/main.ts:1334-1336` |
| 结果表样式 | `src/style.css:582-652`、`src/style.css:1050-1073` |

已可直接复用的共享件（lead 已落到 `src/core/` 与 `src/ui/`，Phase A 已就位）：

- `src/core/format.ts`：`formatSize` / `formatRatio` / `formatMetric` / `formatElapsed` / `formatClock`。
- `src/core/util.ts`：`fileName` / `truncateFileName` / `copyText`。
- `src/core/settings.ts`：`exportDefaultPath`（默认导出目录拼路径）。
- `src/core/store.ts`：`getState` / `subscribe` / `setStatus(text, { detail, isError })` / `isBusy()` / `isPathRunning(path)`（行内「跑分中」的数据源）/ `beginBusy` / `updateBusy` / `endBusy`。
- `src/core/ui-state.ts`：`getPref` / `setPref`（全局界面偏好 + `pixel-arena.ui.` 前缀，`recordState === false` 时不读写）、`roundScoped(namespace, roundId, init)`（按轮 Map）/ `dropRoundScoped`。
- `src/ui/dom.ts`：`el` / `frag` / `paint(host, key, build)`（结构键保护）/ `hasOverlay`；`src/ui/primitives.ts`：`button` / `iconButton` / `segmented` / `section` / `emptyState` / `badge` / `progressBar` / `toolbar` / `spinner` / `metaRow`；`src/ui/overlay.ts`：`openMenu` / `openPopover` / `openModal` / `confirm`；`src/ui/toast.ts`：`toast`。
- `src/styles/tokens.css` / `base.css` / `components.css` 提供颜色、字号、圆角、间距与通用控件样式。

---

## 1. 现有行为清单（必须保留的契约）

### 1.1 列集合与顺序

表头固定从「排名」开始，之后为：

```
排名 | 跑分图 | 文件大小 | 体积比 | 编码参数 | 指标列… | 状态 |（备注）
```

- 「排名」列排序不可点，单元格文本是**当前显示序号**（`index + 1`）。
- 「跑分图」列显示 `truncateFileName(fileName(path))`（中间截断，上限 24 字符），`title` 是完整路径。
- 「文件大小」`formatSize`；「体积比」`formatRatio`，`sizeRatio === null`（未选原图）显示 `—`。
- 「编码参数」一站式模式写入的文本（如 `JPEG q75`）；外部导入为 `null` 时显示 `—`，**列始终存在**。
- 指标列**由数据驱动**：遍历所有跑分图，把出现过的指标键并集按「首次出现顺序」成列。当前后端用 `BTreeMap` 落库，键序是字典序，所以全新一轮五指标的实际列序是：

  ```
  Butteraugli, MS-SSIM, PSNR, SSIM, SSIMULACRA2
  ```

  旧轮次只跑过 PSNR/SSIM 时只有这两列。这个顺序与导出（`report.rs` 的 `IMAGE_METRIC_KEYS`：PSNR, SSIM, MS-SSIM, Butteraugli, SSIMULACRA2）**不一致**，是现存的缺陷，见 §2。
- 「状态」列不可排序。
- 「备注」列是**条件列**：仅当任一跑分图 `note !== null`（目标大小方式不可达标注）时，追加为最后一列；文本 + `title` 全文，无备注的行留空单元格。
- 表格 `class="result-table"`，容器宽度按内容收缩（`white-space: nowrap` + 单元格右对齐，名称列左对齐并 `max-width: 16rem`）。

### 1.2 原图基准固定行

- 仅当 `round.referencePath` 存在时渲染，`tr.class="reference-row"`，**不在排序数组内**，永远在表体第一行。
- 单元格：排名列 `基准`、名称列 `{truncateFileName(fileName(referencePath))}（原图）`（`title` 全路径）、文件大小 `formatSize(referenceSize)` 或 `—`（旧文件且图已移走）、体积比 `100%`、编码参数 `—`、每个指标列 `—`、状态列 `基准`、备注列（存在时）空。
- 视觉：现状 `background: var(--active-bg)` + `font-weight: 600`；新令牌下映射为 `background: var(--surface-3)` + 600 字重（深色 #272c32 / 浅色 #eef0f2），不要用 accent 底色，避免与"最佳值高亮"撞语义。
- 基准行不参与任何行操作（无排序、无高亮、无展开）。

### 1.3 排序规则

- 状态形状：`{ key: string; dir: 1 | -1 } | null`，`null` = 按**选入顺序**（跑分图的添加顺序）显示。
- 按轮保存：模块内 `Map<roundId, SortState | null>`，切走切回保持；**不持久化**，重启归零。
- 点击表头按钮：
  - 同一列再点 → `dir` 取反；
  - 换列 → `dir = firstClickDir(key)`；
  - 更新 Map，然后**整页 `render()`**（现状代价见 §3）。
- 默认方向 `firstClickDir`：`fileSize` / `name` / `encodingParams` → **1（升序）**；`sizeRatio` 与**所有指标** → **-1（降序）**。
- 取值 `sortableValue`：
  - `name` → `fileName(path)`（字符串）
  - `fileSize` → 字节数（数值）
  - `sizeRatio` → `sizeRatio`（`null` 表示没有原图，故沉底）
  - `encodingParams` → 字符串或 `null`
  - 其他 → `candidate.metrics[key]`；`undefined` → `null`；`'inf'` 哨兵 → `Number.POSITIVE_INFINITY`
- 比较：
  - 两个字符串 → `localeCompare(other, 'zh-CN') * dir`
  - 其余 → `(a - b) * dir`
  - 任一为 `null` → **恒沉底**（与 `dir` 无关，两次都 `null` 时返回 0 保持原序）
- 没有二级比较键；等值行顺序依赖 `Array.prototype.sort` 的稳定性 + 输入数组顺序。
- **跑分进行中点击表头被静默忽略**（`if (scoring) return;`，无 disabled 语义、无提示）。
- 排序只影响渲染，不影响数据；导出顺序与当前排序**无关**（见 §1.8）。
- 「排名」列随排序改变（按文件大小升序时第 1 行是体积最小的那张），读起来像"第一名"，语义含混。

### 1.4 状态文案

| 条件 | 文本 | class |
| --- | --- | --- |
| `error !== null` | `失败：{error}`（`title` = error 原文，单元格 `max-width: 24rem` 省略） | `status-fail` |
| `scoringPaths.has(path)` | `跑分中…` | `status-running` |
| `metrics === null` | `待跑分` | `status-pending` |
| 其余 | `完成` | 无 |

这四段文案与核心库 `report.rs` 的 `status_text` 同口径（CSV/HTML 里的状态列也是这四段，只是导出时不可能处于"跑分中"）。**中文文案与判定顺序都不可改**，否则界面与导出不一致。

### 1.5 指标格式化

统一走 `formatMetric`：

- `'inf'` → `∞`
- `|v| >= 10` → `toFixed(2)`
- 否则 → `toFixed(4)`

纯按数值阈值判断，不区分指标种类（后果见 §2）。缺值显示 `—`，与数值 `0` 严格区分：Butteraugli = 0 是"完全一致"，必须渲染成数值而不是破折号。

「文件大小」`formatSize`：`<1024` → `{n} B`；`<1MiB` → 一位小数 KB；其余 → 两位小数 MB。
「体积比」`formatRatio`：`<1` → 一位小数百分数（`13.6%`）；`>=1` → `×1.25`。
表格整体 `font-variant-numeric: tabular-nums`。

### 1.6 效率对比页签

数据只有一个来源：本轮 candidates 的 `fileSize` 与 `metrics`，纯前端计算（`features/results/efficiency.ts`），不请求 IPC。BD-rate 已按决策 0035 整体下线，页签与导出里都不再有率失真汇总。

- 页签 `id = 'efficiency'`、`label = '效率对比'`、`order = 20`、`kinds = ['image']`；容器 `div.efficiency-tab`。
- 指标按 `IMAGE_METRIC_ORDER` 取第一个有数据的（PSNR 优先，其次 SSIM / MS-SSIM / SSIMULACRA2 / Butteraugli）；`Butteraugli` 等越小越好的指标按方向取反后再比较。没有可比指标时主表隐藏，只给「先跑分」提示。
- 列：`跑分图 | 体积 | 体积比 | <指标> | 判定 | 说明`，**按体积升序**（同体积画质高的在前），不提供表头排序。
- 判定用帕累托支配：体积不更大、画质不更低，且至少一项严格更好才算「有人比你划算」。行数 ≥2 才判；`划算` 用 `badge('划算','ok')`，被支配行显示弱化的「不划算」；只有 1 张时判定列 `—`，提示行说明「再加一张就能标出谁更划算」。
- 说明列：划算行「没有更小又更高画质的图」；被支配行「不如 JPEG q75：体积多 12.0%、画质低 0.62 dB」——支配者取体积最接近的一张；同体积写「体积相同」，都无损写「画质相同（都无损）」，越小越好的指标写「画质差」。
- 未跑分 / 失败 / 缺当前指标的行不参与对比，行数写在提示行。
- 点行 = 选中该跑分图（`setActiveCandidate`），舞台切图，与评分表一致。

### 1.7 导出 CSV / HTML 的字段与默认文件名

入口：工具栏两个按钮「导出 CSV」「导出 HTML」（`class="add-btn export-btn"`），`disabled = scoring || !exportable`，`exportable = candidates.length > 0 || videoCandidates.length > 0`。悬浮提示写明 CSV 含视频节、HTML 是自包含报告。

导出动作 `exportRound(kind)`：

1. 取当前轮；没有则返回。
2. `save({ title: '导出 CSV' | '导出 HTML 报告', defaultPath: exportDefaultPath(settings.defaultExportDir, '{baseName}.{csv|html}'), filters: [{ name: 'CSV（逗号分隔）' | 'HTML 报告', extensions: [...] }] })`。
3. 返回 `null`（用户取消）→ **静默返回**，不写状态。
4. `invoke('round_export', { groupId, roundId, kind, path, generatedAt })`，`generatedAt = new Date().toLocaleString('zh-CN', { hour12: false })`（只作展示，前端生成）。
5. 成功 → `setStatus('已导出：{返回的路径}')`；失败 → `setStatus('导出失败：{err}', true)`。没有 toast、没有进度、没有"打开所在目录"。

默认文件名 `exportBaseName(round)`：

- 优先原图文件名主干（`photo.png` → `photo`；`dot > 0` 才算扩展名，`.hidden` 视为无扩展名）；
- 清洗非法字符 `\ / : * ? " < > |` → `_`，`trim()`；
- 清洗后为空 → 回落 `sanitizeFileName(round.name)`；仍为空 → `评测轮`。
- 当前**未处理** Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1`…）与结尾点/空格。

CSV（核心库 `export_csv`）：

- 首字符 UTF-8 BOM（Excel 中文环境不乱码）；
- 头部注释行：`# 像素竞技场评测报告`、`# 跑分组：`、`# 评测轮：`、`# 原图：`（未设置时 `未设置`）、`# 生成时间：`；
- `# 【图片跑分结果】` + 固定表头 `candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status`，任一跑分图有备注才追加 `,note`；
- 图片行：完整路径、编码参数（无则空）、字节数、体积比 6 位小数、五指标 6 位小数（缺列留空，`inf`/`nan` 哨兵）、中文状态；
- 视频节：仅当有原视频或视频跑分图时输出，表头 `candidate,candidate_bytes,size_ratio,vmaf,psnr,ssim,status`；
- RFC 4180 最小转义（含 `,` `"` 换行 回车时加引号、内部引号翻倍）；字段顺序不受前端排序影响，按**存储顺序**（选入顺序）。

HTML（核心库 `export_html`）：自包含单文件，内联 `REPORT_CSS`，`lang="zh-CN"`，`<title>像素竞技场 · {轮名}</title>`（这是导出文件格式，不是界面文案，重构时不动），含元信息、原图（文件名 + 全路径 `code`）、图片表（名称/路径/大小/体积比/编码参数/五指标/状态[/备注]）、视频表（有条件）、页脚"报告不含图片正文"。所有文本 HTML 转义。

### 1.8 导出与排序的关系（易被误解）

导出按 `round.candidates` 的**存储顺序**序列化，与结果表当前排序无关。界面没有任何提示，用户按 PSNR 排序后导出会以为 CSV 也是排好的。新设计必须显式处理这一点（见 §4.3 文案约定），**不得为此给 IPC 加参数**。

### 1.9 数据与 IPC 契约（不可改）

- `CandidateImage`：`path`、`fileSize`、`sizeRatio: number | null`、`metrics: Record<string, number | 'inf'> | null`、`encodingParams?: string | null`、`note?: string | null`、`error: string | null`。
- `Round`：`referencePath: string | null`、`referenceSize: number | null`、`candidates`、`videoReferencePath?`、`videoCandidates?`、`note?`。
- `round_export` 的参数/返回见 §1.7；命令要求 `groupId` + `roundId`。
- `sizeRatio` 只在有原图时非空（后端 `file_size / reference_size`），这是它会在排序时沉底的根因，不是前端 bug。

### 1.10 冻结清单（改了就破坏兼容，实现时逐条对照）

1. 四段状态文案与判定顺序：`失败：{error}` / `跑分中…` / `待跑分` / `完成`。
2. 原图基准行：仅在有原图时出现、永远是第一行、不参与排序/高亮/展开、体积比固定 `100%`。
3. 缺值（`undefined` / `sizeRatio === null` / 无 `encodingParams`）恒沉底，与升降序无关。
4. 备注列只在"任一跑分图有 note"时出现；表格列序中「备注」在最后。
5. 指标格式化：`inf` → `∞`；缺值 → `—`；数值 = 0 不等于缺值。
6. 导出文件名 `{原图主干或轮名}.{csv|html}` + 非法字符替换 + 空名回落 `评测轮`。
7. CSV 的 BOM、`#` 注释头、五指标固定列序与 6 位小数、`inf`/`nan` 哨兵、RFC 4180 转义、视频节条件输出。
8. 导出按存储顺序（选入顺序）序列化，与表格排序无关。
9. IPC 命令与参数以 Rust 注册表为准，前端不自拼；BD-rate 的 `round_bdrate` 已按决策 0035 移除。

---

## 2. 指标键名与 UI 文案对应关系

| 存储键 | 现有列名 | 含义 | 单位 | 优方向 | 现有格式 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `PSNR` | `PSNR` | 峰值信噪比 | dB（界面与导出文件都不写单位；HTML 报告图例只说明"画质轴：PSNR"） | 越大越好 | `>=10` 两位，否则四位；`inf` → `∞` | 与原图逐像素一致时为 `inf` |
| `SSIM` | `SSIM` | 结构相似度 0–1 | 无 | 越大越好 | 恒四位（永远 `<10`） | |
| `MS-SSIM` | `MS-SSIM` | 多尺度 SSIM 0–1 | 无 | 越大越好 | 恒四位 | |
| `Butteraugli` | `Butteraugli` | 感知差异距离 | 无（距离，非分数） | **越小越好** | 四位 | 0 = 完全一致 |
| `SSIMULACRA2` | `SSIMULACRA2` | 感知质量分 0–100 | 无 | 越大越好 | `>=10` 两位，否则四位 | 同一列位数会变 |
| `VMAF`（视频） | `VMAF` | 视频质量分 0–100 | 无 | 越大越好 | 两位（`video.ts`） | 本域只在导出里出现 |

现存缺陷（Phase B 修正，均属**逻辑改动**）：

1. **列序是字典序**（`Butteraugli` 开头），与导出固定序（PSNR, SSIM, MS-SSIM, Butteraugli, SSIMULACRA2）不一致。应统一为语义序，未知键追加在末尾（保 T04 的"新增指标自动多列"能力）。
2. **默认方向对所有指标一律降序** → Butteraugli 是距离，降序把最差的行排到最前。需要按 `better: 'higher' | 'lower'` 元数据决定首次点击方向。
3. **同一列小数位不固定**（SSIMULACRA2 在 9.5 与 90.2 时分别是四位与两位）。应按指标固定小数位。
4. **单位缺失**：PSNR 的 dB 在界面无处体现；用户无法判断"42.13"是什么量纲。建议单位只进表头文案，不进单元格（保持数值可复制、列宽稳定）。
5. **列名是英文键名**，与中文列（跑分图/文件大小/体积比）混排，且缩写不解释。

推荐元数据（实现时可放 `features/results/metrics.ts`，待 Phase B 确认归属）：

```ts
interface MetricMeta {
  key: string;          // 存储键，导出与排序都用它
  label: string;        // 表头文案：PSNR dB / SSIM / MS-SSIM / Butteraugli（越低越好）/ SSIMULACRA2
  decimals: number;     // 固定小数位：2 / 4 / 4 / 3 / 2
  better: 'higher' | 'lower';
}
```

排序比较的细节（新实现必须逐条覆盖）：

- 缺值（`metrics[key] === undefined`）恒沉底，与升降序无关；这是现有正确行为，保留。
- `'inf'` 参与排序时按 `+Infinity` 处理；降序时排最上，升序时排最下；高亮"最优"时应把 `inf` 视为最优（若该指标方向为"越大越好"）。
- 字符串比较用 `localeCompare(..., 'zh-CN')`；数值用差值。两者不可混比（同一列类型恒定）。
- 需要显式的二级键（`path`）保证等值行稳定，否则跑分过程中局部刷新会让等值行互换位置。
- 「排名」语义要重新定义：建议改名为"序号"，并在有排序时用一句状态文本说明"按 X 降序"，避免被读成质量名次。

---

## 3. 现有交互问题清单

按用户在结果坞里的四个真实动作归类。每条都能在现状代码里定位。

### 3.1 比较十几行

1. 最多 12 列（排名/名称/大小/体积比/参数/五指标/状态/备注），坞宽不足时必须横向滚动；**名称列不冻结**，滚到指标列就不知道这一行是谁。编码参数列 `nowrap` 且可能很长（`AVIF q60 4:2:0 …`），进一步把表撑宽。
2. 指标列序是字典序，最常看的 PSNR 排在第 3 位；列序在"新跑一轮/旧轮次"之间还会变（并集顺序），肌肉记忆失效。
3. 没有最佳值标记，也没有格式列，横向比较只能逐格读数字；十几行时眼动成本极高。
4. 「排名」随排序变成"显示序号"，按文件大小升序时第 1 行是最小文件，容易被误读为"画质第一"。
5. 每行都写「完成」，失败行只有红色文字区分；数值与状态同字重同色阶，噪声大。
6. 备注列（不可达标注）在最后一列，横向滚到底才看得到，等于半隐藏。

### 3.2 切换排序

7. 排序入口只是表头里的小按钮 + `title="点击排序（再点反向）"`；箭头是拼进 `textContent` 的字符，列宽会抖，且没有 `aria-sort`，键盘/读屏拿不到"当前按哪列、什么方向"。
8. 点表头触发**整页 `render()`**：重挂对比查看器、滚动位置靠一次补偿恢复、焦点落回 `body`。为了换个顺序付出的代价过大，视觉上就是闪一下。
9. 没有"取消排序回到选入顺序"的路径（只有降→升→降的来回）。
10. 跑分中表头仍可点但**静默无效**，用户会认为排序坏了。
11. 默认方向不按指标语义（Butteraugli 越差越靠前），且没有任何提示说明"这一列现在是升序还是降序、为什么默认这个方向"。

### 3.3 看失败原因

12. 状态列写 `失败：{整段错误}`，`max-width: 24rem` 截断，只能靠 `title` 悬浮看全文：键盘用户摸不到，鼠标用户要悬停等 1 秒，**不能选中复制**去提 issue。
13. 失败行与其他行等高同列，不能就地展开；导出里的状态是全文（CSV/HTML），界面与导出的可读性不一致。
14. 失败原因往往很长（解码失败、路径不存在、非单调等），即使悬浮也难定位关键信息（哪个文件、哪一步）。

### 3.4 导出

15. 两个导出按钮在操作区工具栏，离结果表很远；按钮文案只有「导出 CSV」「导出 HTML」，看标题才知道 CSV 里还含视频节。
16. 没有"导出中"状态，没有进度；成功后信息只落在顶栏状态条（远处、会被下一次状态覆盖），用户得自己去文件管理器找文件；没有"复制路径"或"打开所在目录"（后端也没有这类 IPC）。
17. 失败同样只落状态条，且对话框已关闭、路径丢失，不能重试同一个路径。
18. 没有剪贴板路径：想把结果贴进 issue/文档只能自己排版 Markdown 表格。
19. 导出顺序与表格排序不一致（§1.8），界面无任何说明。
20. 按钮的 disabled 只看"本轮有没有跑分内容"，用户无法在导出前确认这次文件里会包含什么。

---

## 4. 新交互提案（按价值排序，≤5 条）

标注约定：**【呈现】**只换视觉/文案/布局；**【逻辑】**改变行为或计算，需要新测试。

### 4.1 结果表骨架与排序交互（最高价值）

- **【逻辑】**表头三态：无排序 → 首选方向 → 反向 → 无排序（第三次点击回到选入顺序）。首选方向由列元数据决定（大小/名称/参数升序，体积比与指标按 `better`）。
- **【逻辑】**指标列固定语义序 `PSNR, SSIM, MS-SSIM, Butteraugli, SSIMULACRA2`，未登记的键追加在后（保留 T04 自动多列的能力）。列序不再随数据键序变化。
- **【逻辑】**排序只重排 `tbody`（`DocumentFragment` 一次提交），不调用整页渲染；表头按钮节点复用，焦点留在原按钮上。等值行用 `path` 兜底，保证跑分中局部刷新不跳行。
- **【逻辑】**排序状态用 `roundScoped('results.sort', roundId, () => null)`（切轮保持、重启归零，与现状一致）；展开态用 `roundScoped('results.expanded', roundId, () => new Set<string>())`。
- **【呈现】**`th` 上写真实 `aria-sort="ascending|descending|none"`；箭头换成 16px 线性图标（12px 字号门禁以外只做图标），当前排序列字重 600 + accent；数字列右对齐 + `tabular-nums`；`table-layout: fixed` + 显式列宽，避免换列时列宽跳动。表头用 `paint(host, 'head', ...)` 保护，值变化时只改文本与属性，不重建按钮。
- **【呈现】**「排名」改「序号」，有排序时在表格左上角用一行 `--fs-meta` 文本说明 `按 PSNR 降序`（这行同时充当读屏的 live region，`aria-live="polite"`）。
- **不改**：`firstClickDir` 对 `fileSize/name/encodingParams` 的升序偏好；缺值沉底；按轮保存排序（仍不持久化）；排序不影响导出顺序。
- **验收**：点三次表头回到选入顺序；排序后焦点仍在同一按钮；`aria-sort` 与实际顺序一致；Butteraugli 首次点击为升序（最差值在底）。

### 4.2 最佳值高亮与失败行内联展开

- **【呈现】**每列最优值（按 §2 的方向，`inf` 视为最优，并列全标高亮）加 `accent-soft` 底色 + 字重 600；可访问名不能只靠颜色：在单元格内放一个视觉隐藏的「（最佳）」文本（`td` 上的 `aria-label` 支持不可靠），并用 `title` 补一句"PSNR 最佳，42.13 dB"。基准行与失败行不参与最优判定。
- **【呈现】**状态列：失败行状态文本变成一个可点按钮（`aria-expanded`），点击在该行下方插入一条跨列详情行，等宽字体 12px 展示完整错误原文（可选中、可换行），右侧一个「复制错误」按钮（复用 `core/util.ts` 的 `copyText`）。
- **【逻辑】**展开态按 `roundScoped('results.expanded', roundId, () => new Set<string>())`（`path` 集合）保存在本域，不持久化；排序/局部刷新后保持展开；切轮丢弃、删轮走 `dropRoundScoped`。
- **【呈现】**「完成」降为 `--text-subtle`、400 字重；失败与跑分中使用语义色 + 文案双通道（不靠颜色单独表达）。
- **不改**：四段状态文案的原文与判定顺序（§1.4）。
- **验收**：失败行可键盘展开/收起；复制得到的文本与 `error` 字段逐字一致；跑分中行不参与高亮。

### 4.3 结果坞页签 + 导出合并为一个菜单

- **【呈现】**结果坞页签：图片组 `评分表` / `效率对比`；视频组 `评分表` / `视频指标`（由 video 域注册）。表格在页签内独立滚动，不推动坞外布局。效率对比页签复用同一套表格样式。
- **【逻辑/兼容】**旧工作区的视频组可能含遗留图片跑分图（现状 `renderVideoGroupContent` 会渲染只读图片结果表）。为保证这些数据仍可看，`评分表` 页签的 `kinds` 建议取 `['image', 'video']`：在视频组里仅当存在遗留图片 candidates 时显示内容，否则显示空态"这个跑分组只有视频结果"。删掉 `main.ts` 里的只读分支前必须确认这条路径还在。
- **【呈现】**工作栏一个「导出」按钮 + 菜单（`Ctrl+E`）：`导出 CSV…` / `导出 HTML…` / `复制为 CSV` / `复制为 Markdown`。菜单项在跑分中或本轮无可导出内容时禁用并给出原因（不是静默无效）。
- **【逻辑】**导出中按钮进入 `导出中…` 禁用态（防重复触发），完成后 toast + 状态栏双写；失败用 danger toast，文案带下一步（"检查目录是否可写或换一个位置"），并保留上次路径以便重试。
- **【逻辑】**`复制为 CSV` / `复制为 Markdown` 是**纯前端新增产物**：文件导出仍以 `round_export` 为唯一真源，**不在前端复刻 HTML/CSV 文件生成**。剪贴板 CSV 允许与文件 CSV 不同（无 BOM、无 `#` 注释头，表头与图片行列序对齐）；Markdown 为 GFM 表格 + 轮次元信息。
- **【逻辑】**效率对比页签全部是纯前端计算（不调 IPC），因此没有异步竞态：切换轮次/分组时以 `liveRound(roundId)` 读当前数据，不缓存旧轮结果；行选中态按轮存在 `ui-state`。
- **【呈现】**导出菜单里用一行 `--fs-meta` 说明"按选入顺序导出，与表格排序无关"（解决 §1.8 的误解，不加 IPC）。
- **验收**：`Ctrl+E` 可开合菜单且焦点回到触发按钮；复制出的 CSV 能被 Excel 正确分列（逗号分隔，引号规则与文件 CSV 的 RFC 4180 实现相同）；复制出的 Markdown 能直接贴进 GFM 渲染器；导出失败不丢失路径。

### 4.4 列管理 + 格式列 + 首列冻结

- **【呈现】**名称列 `position: sticky; left: 0`（表头同时冻结），横向滚动时始终可见行身份；`table-layout: fixed` 下用 `max-width` + 中间截断 + `title` 全路径。
- **【逻辑】**列显隐菜单（表头右键或表格工具条）：可勾选「编码参数」「备注」与各指标列；默认规则沿用现状的"全空不显示"（编码参数全为 `null` 时默认隐藏，备注列仍按"任一行有备注"出现）。显隐状态走 `getPref` / `setPref`，但 **`UiPrefs` 里还没有这一项**（`readonly UiPrefs` 只认已声明的键），需 lead 在 `core/ui-state.ts` 加 `resultsColumns: string[]`；`recordState === false` 时由 `canPersist` 自动不写。
- **【逻辑】**新增「格式」列：按扩展名映射 `JPEG / WebP / AVIF / JPEG XL / PNG / 其他大写 / 未知格式`（`jpg|jpeg` → JPEG，空扩展名 → 未知格式）。可作为排序键，供按格式分组浏览。
- **【逻辑】**当前排序键被隐藏时不允许隐藏该列（菜单项置灰说明"当前按此列排序"），避免"排序依据不可见"。
- **验收**：横向滚动时名称列与表头对齐无 1px 偏移；隐藏列不丢排序数据；格式映射与 `core/format-label.ts` 的固定表逐字一致。

### 4.5 行选中联动查看器（可选，跨域依赖）

- **【呈现】**单击行 = 选中（整行 `accent-soft` 底，**不用左边缘彩条**，符合铁律），再次点击取消；键盘上下键在行间移动，Enter 打开详情（失败行展开 / 其余高亮）。
- **【逻辑/数据流】**单击行把"当前活动跑分图"写进按轮的共享界面状态，舞台分屏右图切到该图。现有 `roundScoped(namespace, roundId, init)` 已经能做这件事，不需要改数据流架构：
  ```
  results 行点击 ──> roundScoped('active-candidate', roundId, () => null) = path
                              │
                              └─> viewer 订阅并读出同一 namespace，把分屏右图切到该 path
                                  （只改主视图，不改多视图每格选图）
  ```
  两个域都 import `core/ui-state.ts`，**不新增 IPC、不修改对方文件**。缺的是一个双方共用的读写入口：建议 lead 在 `core/ui-state.ts` 加 `getActiveCandidate` / `setActiveCandidate`（也可以约定 namespace 字符串，但共享常量更稳）。
- **【降级】**若 Phase B 契约不允许扩共享状态：本条退化为"双击行复制文件路径 + 表内选中"，不做跨域联动。
- **验收**：选中态与舞台右图一致；切轮不串；多视图各自选图不被覆盖；`Esc` 清空选中。

> 不做的：虚拟滚动表（见风险 R1）、表头拖拽调宽（收益低于复杂度，先固定列宽）、表格内直接改跑分图参数（属于 encoding 域）。

---

## 5. 风险与坑

**R1 大列表渲染性能。** 现状一次性 `createElement` 全部单元格，行数 10–60 属常见（一站式默认取点约 13 行：4 个有损格式 × 3 档 + 无损组；高级创建与多次追加可达 60+）。约束：排序只做节点重排（一次 fragment 提交），不做逐行 `innerHTML`；行高固定 28px，超过 80 行再启用 `content-visibility: auto` + `contain-intrinsic-size`；**不要在渲染中读 `offsetWidth`/`getBoundingClientRect`**（布局抖动）。虚拟化会破坏 Tab 顺序、sticky 列与读屏导航，非必要不做。

**R2 排序丢焦点。** 现状整页 `render()` 会重建表头按钮，焦点回到 `body`。新实现必须复用表头节点，排序后 `focus({ preventScroll: true })` 兜底；`aria-sort` 写在 `th` 上而不是按钮上。仓库 vitest 是 node 环境（不引 jsdom），所以要把排序比较、最优值、列序抽成纯函数单测，DOM 结构用 `?raw` 源码守卫（沿用 `src/main-scoring.test.ts` 的做法）。

**R3 跑分中局部刷新。** 现状 `scoring` / `scoringPaths` 是 `main.ts` 的模块级全局，每次跑分都会整页重渲染：查看器重挂、表格整表重建。新架构要求 `update()` 增量更新：按 `path` 做行身份，只改变化的单元格文本与 class；行序按当前排序重排。若仍选择"跑分中禁止排序"，必须给按钮 `disabled` + `title` 说明，禁止静默 `return`。

**R4 页签不发起 IPC。** 效率对比页签全部是纯前端计算，没有异步请求可竞态；切换分组/轮次/页签时以 `liveRound(roundId)` 读当前数据，删轮后不得把旧轮结果写进新轮。

**R5 导出路径与默认目录。** `defaultPath` 由 `exportDefaultPath(settings.defaultExportDir, fileName)` 用 `/` 拼成（Windows 反斜杠目录会得到 `C:\导出/r.csv`，这是被单测钉住的现状，不要改）；`save` 返回用户最终选择，用户可改目录与文件名。补齐文件名清洗：Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`）、结尾点与空格；否则 Windows 上写入会报错，而错误只在状态条一闪而过。用户取消（`null`）必须静默。

**R6 导出与界面一致性。** CSV/HTML 由 Rust 生成，是唯一真源；前端不得为了"复制"而复刻文件导出逻辑（一旦漂移，用户拿到的文件与界面不一致）。剪贴板 CSV/Markdown 是独立产物，需在菜单里写明"复制"，不要叫"导出"。导出顺序恒为存储顺序，与排序无关，必须有可见说明。

**R7 状态文案与后端对齐。** `report.rs::status_text` 与界面共用四段文案（`失败：X` / `待跑分` / `完成`；导出时不会出现"跑分中"）。改文案会同时改变导出文件内容，属于破坏性变更，需同步改核心库并更新断言。

**R8 指标方向修正会反转用户既有习惯。** Butteraugli 首次点击从"降序（最差在上）"改为"升序（最好在上）"，是行为变更，要在提交说明与交付说明里写清；`inf` 参与高亮/排序要有专门用例（`∞` 与数值混排、全列 `∞`、全列缺值）。

**R9 列宽与数字抖动。** `table-layout: fixed` + 显式列宽能消除换列抖动，但名称列会被硬裁，必须配合中间截断（`core/util.ts` 的 `truncateFileName`）+ `title`，不要用 CSS `ellipsis` 假装（中间截断才能保留扩展名）。

**R10 现有测试会失效。** `src/main-scoring.test.ts` 用 `?raw` 切片钉 `scoreAllCandidates` 的实现；`src/main-image-queue.test.ts` 以 `renderVideoGroupContent(` 到 `buildResultTable(` 的下标切片钉视频组只挂导出与视频区块。重写后 `main.ts` 不再包含结果表函数，第二个切片会直接变红。删除旧函数时必须同步迁移守卫到新文件（建议新增 `features/results/*.test.ts`：`metrics.ts` 的列序/方向/格式化、`sort.ts` 的比较与三态、`export-name.ts` 的文件名清洗），否则等于丢掉防回归网。

**R11 视频域并行改动。** 视频表（`src/video.ts`）与本域是两套平行实现，函数名相同（`firstClickDir`/`formatMetric`/`formatSize`）。若 Phase B 要让两个域共用表格骨架，应由 lead 决定放进 `src/ui/` 或允许 video 只 import 本域导出的纯函数；**不做跨域文件修改**。

---

## 6. Phase B 拍板结果（已落地）

Phase A 提出的 5 个待确认项，lead 已在 Phase A 末拍板，实现按此执行：

1. **`UiPrefs.resultsColumns: string[] | null`** 已加到 `core/ui-state.ts`（null = 默认列集），本域用 `getPref` / `setPref` 读写。
2. **跨域联动**：`core/ui-state.ts` 提供 `getActiveCandidate(roundId)` / `setActiveCandidate(roundId, path)`；结果表行点击写它，再调 `shell/controller` 的 `requestRender()` 让舞台跟着更新。
3. **指标语义与 `formatBdRate` 归本域**：`features/results/metrics.ts` 独占（`core/model` 里重复的 metricLabel / better / bestMetricValue 已删除，别再引用）。列序修正为 PSNR → SSIM → MS-SSIM → SSIMULACRA2 → Butteraugli → 其余字典序；每指标固定小数位；Butteraugli 首次点击升序。
4. **表格骨架共享**：通用部分在 `features/results/table.ts`（列配置 + 行渲染 + 三态排序），不掺图片语义；video 只 import 不修改。
5. **导出置灰口径** = `store.isBusy()`（任一长任务在跑都不开新导出）；写文件期间占 `beginBusy('export', …)`。

外壳接线：`src/boot.ts` 已 `import './features/results'`；导出入口是工作栏的「导出」按钮（`runCommand('export-menu')`）与 `Ctrl+E`，结果坞里不再重复放导出按钮（避免同一动作两处入口）。

## 7. 本域验收门

1. `npm run typecheck`、`npm test` 通过；新增纯函数单测覆盖列序/方向/三态/最优值/文件名清洗/效率对比判定。
2. `cargo test --workspace` 通过（`report.rs` 与 `src-tauri/tests/export.rs` 已按决策 0035 去掉 BD-rate 断言）。
3. 手工路径：选原图 + 多格式跑分图 → 排序三次回到选入顺序 → 最佳值高亮正确 → 失败行展开并复制错误 → 切效率对比页签（看划算判定）→ 导出 CSV/HTML 到默认导出目录 → 复制 Markdown 贴进编辑器。
4. 截图：深/浅主题各一张，含窄坞横向滚动（名称列冻结）与失败行展开态。
5. 不新增 IPC、不改导出文件格式；`Ctrl+E` 可开合导出菜单。
