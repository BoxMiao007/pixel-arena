// 编码器卡共享渲染（票 #75）：把一条编码器配置渲染成一张独立分组卡片。
//
// 为什么单独成模块：卡片的 DOM 组织（卡头 / 快速参数两列网格 / 高级参数行子区 /
// 命令行预览）此前埋在 openAdvancedPanel 的闭包与它的整卡重建出口里，只能被视频
// 侧高级创建面板使用。图片侧编辑弹窗（后续票）需要同一张卡，两处各写一份必然
// 漂移。本模块因此不持有列表、不依赖面板生命周期：编码器目录（格式清单 / 推荐
// 参数 / 帮助文本）经 EncoderCardCatalog 传入，增删排序与恢复默认经
// EncoderCardCallbacks 交还宿主，卡片自身只做布局与控件接线。
//
// 参数合并、冲突校验、命令行预览、可用性校验等纯逻辑仍归 src/advanced.ts
// （本票不改那份共享地基），这里只调用不重写。

import { infoIconSvg, wireBubbleFlip } from './settings-ui';
import {
  previewImageCommand,
  previewVideoCommand,
  type AdvancedEntry,
  type AdvancedParamRow,
  type AdvancedVideoCatalog,
  type ImageSpec,
  type KnownParam,
  type QuickSpec,
  type VideoSpec,
} from './advanced';

/** 卡片渲染所需的编码器目录：图片规格表 / 视频规格表 + ffmpeg 枚举。 */
export interface EncoderCardCatalog {
  kind: 'image' | 'video';
  imageSpecs: ImageSpec[];
  videoCatalog: AdvancedVideoCatalog | null;
}

/** 卡片对宿主的回调：卡片不持有列表状态，「排序/删除/恢复默认」由宿主落地。 */
export interface EncoderCardCallbacks {
  /** 卡内配置被修改、需要宿主重建卡片列表（编码器切换 / 模式切换 / 行增删排序等）。 */
  onChange(): void;
  /** 上移（delta = -1）或下移（delta = 1）该卡。 */
  onMove(delta: -1 | 1): void;
  /** 删除该卡。 */
  onRemove(): void;
  /** 「恢复默认」已把 entry 就地重置，宿主据此重建。 */
  onReset(): void;
  /** 复制命令行文本（提示文案由宿主决定，共用 util.copyText 出口）。 */
  onCopy(text: string): void;
}

/** 卡片渲染的可选环境信息（不影响宿主状态）。 */
export interface EncoderCardOptions {
  /** 命令行预览用的输入路径（原图/原视频）；null = 占位符。 */
  referencePath?: string | null;
  /** 该条目编码器可执行文件不可用的错误文本（卡内红标）；为空表示可用。 */
  unavailableError?: string | null;
  /** 推荐参数下拉的收起范围：同一时间至多展开一个；默认取卡片所属文档。 */
  menuRoot?: ParentNode;
}

/** 图片条目对应的规格（非图片卡或目录里没有该编码器时返回 null）。 */
export function imageSpecOf(catalog: EncoderCardCatalog, entry: AdvancedEntry): ImageSpec | null {
  if (catalog.kind !== 'image') return null;
  return catalog.imageSpecs.find((spec) => spec.id === entry.encoderId) ?? null;
}

/** 视频条目对应的规格（表外编码器返回 null，只支持参数行）。 */
export function videoSpecOf(catalog: EncoderCardCatalog, entry: AdvancedEntry): VideoSpec | null {
  if (catalog.kind !== 'video') return null;
  return catalog.videoCatalog?.specs.find((spec) => spec.ffmpegName === entry.encoderId) ?? null;
}

/** 当前条目的规格：图片按 id 查、视频按 ffmpeg 名查；表外返回 null。 */
export function specOf(catalog: EncoderCardCatalog, entry: AdvancedEntry): QuickSpec | null {
  return imageSpecOf(catalog, entry) ?? videoSpecOf(catalog, entry);
}

/** 条目的展示名：命中规格用规格名，否则退回编码器 id。 */
export function encoderLabel(catalog: EncoderCardCatalog, entry: AdvancedEntry): string {
  return specOf(catalog, entry)?.displayName ?? entry.encoderId;
}

/** 当前条目的推荐参数目录（含各参数说明，供下拉与 ⓘ 气泡使用）。 */
export function knownParamsOf(catalog: EncoderCardCatalog, entry: AdvancedEntry): KnownParam[] {
  return imageSpecOf(catalog, entry)?.knownParams ?? videoSpecOf(catalog, entry)?.knownParams ?? [];
}

/** 收起 root 范围内全部推荐参数下拉（同一时间至多展开一个；点外部统一收起）。
 * root 由宿主传入（面板传卡片列表容器、编辑弹窗传右栏），避免不同布局互相收掉。 */
export function closeEncoderMenus(root: ParentNode): void {
  for (const menu of root.querySelectorAll<HTMLElement>('.adv-known-menu')) {
    menu.hidden = true;
  }
}

/**
 * 把一条编码器配置恢复成「刚添加时」的默认状态（票 #75）」。
 *
 * 口径与 src/advanced.ts 的 newEntry 初始值一致：质量优先、规格默认质量、
 * 目标大小 200 KB、非无损、参数行清空（自定义行一并删除）。条目 id 与编码器选择
 * 保留——用户换过编码器后点恢复默认，应按当前编码器的规格回到它的默认值，而不是
 * 跳回添加时的旧编码器。表外视频编码器没有规格（spec = null），只清参数行。
 */
export function resetEntryToDefault(
  entry: AdvancedEntry,
  spec: (QuickSpec & { qualityDefault?: number }) | null,
): void {
  entry.lossless = false;
  entry.mode = 'quality';
  // 表外视频编码器没有规格表，质量不参与命令行；仍回到 newEntry 的默认 75，
  // 保证「恢复默认」与「刚添加时」逐字段一致
  entry.quality = spec?.qualityDefault ?? 75;
  entry.targetBytes = 200 * 1024;
  entry.unit = 'KB';
  entry.rows = [];
}

/**
 * 渲染一张编码器卡（不依赖面板生命周期，可直接放进任意容器）。
 *
 * entry 会被就地修改（与既有会话态约定一致），宿主在 onChange 里重建列表即可。
 */
export function renderEncoderCard(
  entry: AdvancedEntry,
  index: number,
  catalog: EncoderCardCatalog,
  callbacks: EncoderCardCallbacks,
  options: EncoderCardOptions = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'adv-entry';
  // 卡片根元素带条目 id：宿主的整卡重建按它回写折叠区开合（id 键控）
  card.dataset.entryId = entry.id;
  const menuRoot: ParentNode = options.menuRoot ?? card.ownerDocument;
  const referencePath = options.referencePath ?? null;
  const spec = specOf(catalog, entry);
  const imageSpec = imageSpecOf(catalog, entry);

  // 行内容变化时只刷新预览与折叠栏计数，不重建（保住输入焦点）
  const liveCallbacks: (() => void)[] = [];
  const onChangeLive = (): void => {
    for (const fn of liveCallbacks) fn();
  };

  // -- 卡头：序号 + 编码器选择 + 恢复默认 + 排序/删除 --
  const headRow = document.createElement('div');
  headRow.className = 'adv-entry-head';
  const label = document.createElement('span');
  label.className = 'adv-entry-label';
  label.textContent = `第 ${index + 1} 项`;
  const select = document.createElement('select');
  select.className = 'adv-encoder-select';
  select.title = '选择编码器（同一编码器可多次添加，各自参数独立）';
  if (catalog.kind === 'image') {
    for (const imageSpecItem of catalog.imageSpecs) {
      const opt = document.createElement('option');
      opt.value = imageSpecItem.id;
      opt.textContent = imageSpecItem.displayName;
      select.append(opt);
    }
  } else if (catalog.videoCatalog) {
    const inTable = document.createElement('optgroup');
    inTable.label = '按格式（有推荐参数）';
    for (const videoSpecItem of catalog.videoCatalog.specs) {
      const opt = document.createElement('option');
      opt.value = videoSpecItem.ffmpegName;
      opt.textContent = videoSpecItem.displayName;
      inTable.append(opt);
    }
    select.append(inTable);
    const tableNames = new Set(catalog.videoCatalog.specs.map((item) => item.ffmpegName));
    const extras = catalog.videoCatalog.encoderNames.filter((name) => !tableNames.has(name));
    if (extras.length > 0) {
      const outTable = document.createElement('optgroup');
      outTable.label = 'ffmpeg -encoders 枚举（无推荐值）';
      for (const name of extras) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        outTable.append(opt);
      }
      select.append(outTable);
    }
  }
  select.value = entry.encoderId;
  if (select.value !== entry.encoderId) {
    // 会话里存的编码器不在当前目录里（如表外编码器遇到枚举失败）：补占位项
    const opt = document.createElement('option');
    opt.value = entry.encoderId;
    opt.textContent = `${entry.encoderId}（不在当前枚举中）`;
    select.append(opt);
    select.value = entry.encoderId;
  }
  select.addEventListener('change', () => {
    entry.encoderId = select.value;
    const nextSpec = specOf(catalog, entry);
    // 换编码器后质量按新规格夹回范围；无损能力变化由重建后的控件反映
    if (nextSpec) {
      entry.quality = Math.min(Math.max(entry.quality, nextSpec.qualityMin), nextSpec.qualityMax);
    }
    callbacks.onChange();
  });
  const resetBtn = document.createElement('button');
  resetBtn.className = 'settings-mini-btn adv-entry-reset';
  resetBtn.textContent = '恢复默认';
  resetBtn.title = '把这条配置的质量、模式、目标大小、无损开关与全部参数行恢复到刚添加时的状态';
  resetBtn.addEventListener('click', () => {
    resetEntryToDefault(entry, spec);
    callbacks.onReset();
  });
  const upBtn = document.createElement('button');
  upBtn.className = 'settings-mini-btn';
  upBtn.textContent = '↑';
  upBtn.title = '上移（排序影响创建顺序）';
  upBtn.addEventListener('click', () => callbacks.onMove(-1));
  const downBtn = document.createElement('button');
  downBtn.className = 'settings-mini-btn';
  downBtn.textContent = '↓';
  downBtn.title = '下移';
  downBtn.addEventListener('click', () => callbacks.onMove(1));
  const delBtn = document.createElement('button');
  delBtn.className = 'settings-mini-btn';
  delBtn.textContent = '×';
  delBtn.title = '删除该编码器条目';
  delBtn.addEventListener('click', () => callbacks.onRemove());
  headRow.append(label, select, resetBtn, upBtn, downBtn, delBtn);
  card.append(headRow);

  // 编码器可执行文件不可用的红标（AC5）：点「创建」时批量检测，报错指向设置页
  if (options.unavailableError) {
    const errEl = document.createElement('p');
    errEl.className = 'settings-error adv-entry-error';
    errEl.textContent = options.unavailableError;
    card.append(errEl);
  }

  // -- 命令行预览：默认收起，展开后复制（快速参数改动即时刷新内容） --
  const previewDetails = document.createElement('details');
  previewDetails.className = 'adv-preview';
  // 折叠区按 region 标记：宿主的整卡重建按 (条目 id, region) 回写开合，两类折叠区
  // （高级参数子区 / 命令行预览）互不干扰
  previewDetails.dataset.advRegion = 'preview';
  const previewSummary = document.createElement('summary');
  previewSummary.textContent = '命令行预览';
  const previewRow = document.createElement('div');
  previewRow.className = 'adv-preview-row';
  const cmdEl = document.createElement('code');
  cmdEl.className = 'adv-cmd';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'settings-mini-btn';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制这条命令行（可直接粘贴到 shell 执行）';
  copyBtn.addEventListener('click', () => callbacks.onCopy(cmdEl.textContent ?? ''));
  previewRow.append(cmdEl, copyBtn);
  previewDetails.append(previewSummary, previewRow);

  /** 刷新命令行预览（宽松合并：半填的参数行不打断渲染，错误创建时权威报出）。 */
  const refreshPreview = (): void => {
    const currentImageSpec = imageSpecOf(catalog, entry);
    let line: string;
    if (catalog.kind === 'image') {
      line = currentImageSpec
        ? previewImageCommand(currentImageSpec, entry, referencePath)
        : entry.encoderId;
    } else {
      line = previewVideoCommand(videoSpecOf(catalog, entry), entry, referencePath);
    }
    cmdEl.textContent = line;
    cmdEl.title =
      catalog.kind === 'image' && entry.mode === 'size' && !entry.lossless
        ? '大小优先模式：实际质量点由目标大小搜索确定，此预览按当前滑杆值估算'
        : '复制后可直接粘贴到 shell 执行（输入为原图路径，产物写在原图旁的 Pixel Arena 文件夹）';
  };

  liveCallbacks.push(() => {
    refreshPreview();
    syncSummary();
  });

  // -- 子区一：快速参数（两列网格；表外视频编码器没有规格，只给提示） --
  if (spec) {
    const quickZone = document.createElement('section');
    quickZone.className = 'adv-quick-zone';
    const quickTitle = document.createElement('div');
    quickTitle.className = 'adv-zone-title';
    quickTitle.textContent = '快速参数';
    const quickGrid = document.createElement('div');
    quickGrid.className = 'adv-quick-grid';

    // 无损开关（按能力禁用，票面验收 2）
    const losslessWrap = document.createElement('label');
    losslessWrap.className = 'adv-lossless';
    const losslessCheck = document.createElement('input');
    losslessCheck.type = 'checkbox';
    losslessCheck.checked = entry.lossless;
    losslessCheck.disabled = !spec.losslessSupported;
    losslessCheck.title = spec.losslessSupported
      ? spec.losslessNote || '无损：像素与原图逐位一致，质量参数不参与'
      : spec.losslessNote;
    losslessCheck.addEventListener('change', () => {
      entry.lossless = losslessCheck.checked;
      callbacks.onChange();
    });
    losslessWrap.append(losslessCheck, document.createTextNode('无损'));
    quickGrid.append(losslessWrap);

    // 质量滑块（显示值/范围/步长）
    const qualityWrap = document.createElement('label');
    qualityWrap.className = 'adv-quality';
    const qualityText = document.createElement('span');
    qualityText.className = 'adv-quality-text';
    const syncQualityText = (): void => {
      qualityText.textContent = `质量 ${entry.quality}（范围 ${spec.qualityMin}–${spec.qualityMax}，步长 ${
        imageSpec?.qualityStep ?? 1
      }）`;
    };
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'adv-quality-slider';
    slider.min = String(spec.qualityMin);
    slider.max = String(spec.qualityMax);
    slider.step = String(imageSpec?.qualityStep ?? 1);
    slider.value = String(entry.quality);
    slider.title = `${spec.displayName} 质量参数（${spec.qualityFlag}），范围 ${spec.qualityMin}–${spec.qualityMax}`;
    slider.disabled = entry.lossless;
    slider.addEventListener('input', () => {
      entry.quality = Number(slider.value);
      syncQualityText();
      onChangeLive();
    });
    syncQualityText();
    qualityWrap.append(document.createTextNode('质量'), slider, qualityText);
    quickGrid.append(qualityWrap);

    // 目标大小（KB/MB，真值字节；与一站式同约定）
    const unitBytes = entry.unit === 'KB' ? 1024 : 1024 * 1024;
    const sizeWrap = document.createElement('label');
    sizeWrap.className = 'adv-size';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.className = 'adv-size-input';
    sizeInput.min = '0';
    sizeInput.step = 'any';
    sizeInput.disabled = entry.lossless || entry.mode === 'quality';
    const display = entry.targetBytes / unitBytes;
    sizeInput.value = Number.isInteger(display) ? String(display) : display.toFixed(2);
    sizeInput.addEventListener('change', () => {
      const bytes = Math.round(Number(sizeInput.value) * unitBytes);
      if (Number.isFinite(bytes) && bytes >= 1) {
        entry.targetBytes = bytes;
      }
      // 无效输入不落状态；「创建」时由 validateEntry 汇总报错
      const shown = entry.targetBytes / unitBytes;
      sizeInput.value = Number.isInteger(shown) ? String(shown) : shown.toFixed(2);
    });
    const unitSelect = document.createElement('select');
    unitSelect.className = 'adv-size-unit';
    unitSelect.disabled = entry.lossless || entry.mode === 'quality';
    unitSelect.title = '大小单位（KB/MB，真值一律字节）';
    for (const unitName of ['KB', 'MB'] as const) {
      const opt = document.createElement('option');
      opt.value = unitName;
      opt.textContent = unitName;
      unitSelect.append(opt);
    }
    unitSelect.value = entry.unit;
    unitSelect.addEventListener('change', () => {
      entry.unit = unitSelect.value as 'KB' | 'MB';
      callbacks.onChange();
    });
    sizeWrap.append(document.createTextNode('目标大小'), sizeInput, unitSelect);
    quickGrid.append(sizeWrap);

    // 模式二选一：质量优先 / 大小优先（决定搜索语义；无损时整体置灰）
    const modeWrap = document.createElement('div');
    modeWrap.className = 'adv-mode';
    modeWrap.role = 'group';
    modeWrap.ariaLabel = '快速参数模式';
    for (const [mode, modeLabel, modeTitle] of [
      ['quality', '质量优先', '按质量滑杆取值直接编码'],
      ['size', '大小优先', '按目标大小自动搜索最接近的质量点'],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = modeLabel;
      btn.title = modeTitle;
      btn.disabled = entry.lossless;
      btn.classList.toggle('active', entry.mode === mode);
      btn.ariaPressed = entry.mode === mode ? 'true' : 'false';
      btn.addEventListener('click', () => {
        if (entry.mode !== mode) {
          entry.mode = mode;
          callbacks.onChange();
        }
      });
      modeWrap.append(btn);
    }
    quickGrid.append(modeWrap);
    quickZone.append(quickTitle, quickGrid);
    card.append(quickZone);
  } else {
    const offTable = document.createElement('p');
    offTable.className = 'settings-hint adv-off-table';
    offTable.textContent =
      '表外编码器（枚举可得但无推荐参数）：请用下方高级参数行自行配置，命令行预览自查。';
    card.append(offTable);
  }

  // -- 子区二：高级参数行（带标题与分隔线，默认展开） --
  const details = document.createElement('details');
  details.className = 'adv-advanced';
  details.dataset.advRegion = 'advanced';
  details.open = true;
  const summary = document.createElement('summary');
  const syncSummary = (): void => {
    const active = entry.rows.filter((row) => row.enabled).length;
    summary.textContent = `高级参数行（${active} 项生效 / 共 ${entry.rows.length} 行）`;
  };
  syncSummary();
  details.append(summary);

  /** 从 KnownParam 造一条参数行（预填名称/标志/说明/默认值与控件种类）。 */
  const rowFromKnown = (known: KnownParam): AdvancedParamRow => {
    const row: AdvancedParamRow = {
      name: known.name,
      flag: known.flag,
      value: '',
      note: known.note,
      kind: 'text',
      options: [],
      enabled: true,
    };
    switch (known.kind.type) {
      case 'bool':
        row.kind = 'bool';
        break;
      case 'number':
        row.kind = 'number';
        row.value = String(known.kind.default);
        row.note = `${known.note}（范围 ${known.kind.min}–${known.kind.max}，步长 ${known.kind.step}）`;
        break;
      case 'choice':
        row.kind = 'choice';
        row.options = [...known.kind.options];
        row.value = known.kind.default;
        break;
      case 'text':
        row.kind = 'text';
        break;
    }
    return row;
  };

  /** #45 气泡机制的挂载点：wrap 挂设置页同款 .settings-status-info 类（其
   * :hover/:focus-within 展开规则在样式表里全局生效），图标用 settings-ui 导出的
   * infoIconSvg，气泡用 .settings-bubble——观感与设置页一致。菜单选项里 ⓘ 与
   * 选中按钮是兄弟节点，悬浮不会触发选中；收起态命令按钮里 ⓘ 在按钮内部（票
   * #53），点它 = 点按钮展开下拉。气泡从宿主盒外弹出，祖先不得设 overflow
   * 裁剪。 */
  const buildInfoBubble = (text: string): HTMLElement => {
    const info = document.createElement('span');
    info.className = 'settings-status-info';
    const icon = document.createElement('span');
    icon.className = 'settings-status-info-icon';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', '参数说明');
    icon.setAttribute('tabindex', '0');
    icon.append(infoIconSvg());
    const bubble = document.createElement('span');
    bubble.className = 'settings-bubble';
    bubble.textContent = text;
    info.append(icon, bubble);
    wireBubbleFlip(info, bubble); // 票 #57：出界翻转，保证气泡完整可读
    return info;
  };

  /** 参数行的值控件（布尔开关 / 下拉 / 数值 / 自由文本，票面验收 3）。
   * 票 #51：值控件一律不设原生 title——说明统一走行内 ⓘ 气泡，避免气泡与
   * 系统 tooltip 双弹。 */
  const buildValueWidget = (row: AdvancedParamRow): HTMLElement => {
    if (row.kind === 'bool') {
      // 票 #53：裸 checkbox 无样式、与 ↑↓× 挤在一起，换 开/关 双态按钮（复用
      // .adv-mode 分段样式，与质量优先/大小优先同观感）；语义不变：开 = 命令行
      // 带此标志（row.enabled），折叠标题「N 项生效」按它计数
      const wrap = document.createElement('div');
      wrap.className = 'adv-mode';
      wrap.role = 'group';
      wrap.ariaLabel = '是否在命令行中启用该参数';
      for (const on of [true, false]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = on ? '开' : '关';
        btn.classList.toggle('active', row.enabled === on);
        btn.ariaPressed = row.enabled === on ? 'true' : 'false';
        btn.addEventListener('click', () => {
          if (row.enabled !== on) {
            row.enabled = on;
            callbacks.onChange();
          }
        });
        wrap.append(btn);
      }
      return wrap;
    }
    if (row.kind === 'choice') {
      const selectEl = document.createElement('select');
      selectEl.className = 'adv-param-value';
      for (const option of row.options) {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        selectEl.append(opt);
      }
      selectEl.value = row.value;
      selectEl.addEventListener('change', () => {
        row.value = selectEl.value;
        onChangeLive();
      });
      return selectEl;
    }
    const input = document.createElement('input');
    input.type = row.kind === 'number' ? 'number' : 'text';
    input.className = 'adv-param-value';
    input.value = row.value;
    input.addEventListener(row.kind === 'number' ? 'change' : 'input', () => {
      row.value = input.value;
      onChangeLive();
    });
    return input;
  };

  /** 推荐行的自制下拉命令框（原生 select 放不进选项内图标）：收起态 = 按钮显示
   * 所选「参数名（标志）」+ ⓘ；展开 = 弹出列表，每项 = 命令文字 + 末尾 ⓘ（悬浮
   * 出该选项参数说明），点击项选中 = 整行替换为 rowFromKnown 结果（参数名/标志/
   * 说明/值类型/默认值整体更新，值控件随 kind 重建、值重置默认）。已被其他行占用
   * 的参数在选项中禁用（本行自身除外）。 */
  const buildKnownDropdown = (
    rowIndex: number,
    row: AdvancedParamRow,
    known: KnownParam,
  ): HTMLElement => {
    const knownList = knownParamsOf(catalog, entry);
    const usedFlags = new Set(
      entry.rows.filter((_, i) => i !== rowIndex).map((item) => item.flag.trim()),
    );
    const wrap = document.createElement('span');
    wrap.className = 'adv-known';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'adv-known-toggle';
    // 票 #53：ⓘ 挪进按钮内文字后面（原来悬在 flex 行中间）。点 ⓘ = 点按钮展开
    // 下拉，悬浮仍出说明气泡；文字包内层 span 承担 ellipsis——按钮自身不能设
    // overflow:hidden，否则 ⓘ 的气泡会被裁没（#52 弹出菜单同款教训）
    const toggleText = document.createElement('span');
    toggleText.className = 'adv-known-toggle-text';
    toggleText.textContent = `${known.name}（${known.flag}）`;
    toggle.append(toggleText, buildInfoBubble(row.note));
    const menu = document.createElement('div');
    menu.className = 'adv-known-menu';
    menu.hidden = true;
    for (const item of knownList) {
      const option = document.createElement('div');
      option.className = 'adv-known-option';
      const optionBtn = document.createElement('button');
      optionBtn.type = 'button';
      optionBtn.className = 'adv-known-option-btn';
      optionBtn.textContent = `${item.name}（${item.flag}）`;
      optionBtn.disabled = usedFlags.has(item.flag);
      optionBtn.addEventListener('click', () => {
        // 切换选中 = 整行替换为目录数据，值控件由重建按新 kind 生成
        entry.rows[rowIndex] = rowFromKnown(item);
        callbacks.onChange();
      });
      option.append(optionBtn, buildInfoBubble(item.note));
      menu.append(option);
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation(); // 别让 document 的「点外部收起」把展开那一下立刻关掉
      const wasOpen = !menu.hidden;
      closeEncoderMenus(menuRoot);
      menu.hidden = wasOpen;
    });
    wrap.append(toggle, menu);
    return wrap;
  };

  // 添加参数行：编码器推荐参数（下拉）+ 自定义（布尔/数值/下拉能力来自推荐项）。
  // 票 #53：固定在顶部 summary 正下方，不随新建条目排到行列表末尾。
  // 票 #54：原生 select 放不进选项内图标，换与推荐行同款的自制下拉——按钮显示
  // 已选「参数名（标志）」+ ⓘ，菜单项末尾 ⓘ 悬浮出对应说明；点条目只选中不
  // 添加，添加仍走「添加推荐参数」（先选后加不变）。按钮不设原生 title，说明
  // 统一走 ⓘ 气泡（#51 原则，避免悬浮双弹）
  const addRow = document.createElement('div');
  addRow.className = 'adv-add-row';
  const knownList = knownParamsOf(catalog, entry);
  const usedFlags = new Set(entry.rows.map((row) => row.flag.trim()));
  const available = knownList.filter((known) => !usedFlags.has(known.flag));
  let chosen = available[0];
  const addDropdown = document.createElement('span');
  addDropdown.className = 'adv-known';
  const addToggle = document.createElement('button');
  addToggle.type = 'button';
  addToggle.className = 'adv-known-toggle';
  addToggle.disabled = !chosen;
  const addToggleText = document.createElement('span');
  addToggleText.className = 'adv-known-toggle-text';
  const paintAddToggle = (): void => {
    addToggleText.textContent = chosen ? `${chosen.name}（${chosen.flag}）` : '无可用推荐参数';
    // ⓘ 随选中项换说明；无选中时无说明可弹，ⓘ 退场
    addToggle.replaceChildren(
      addToggleText,
      ...(chosen ? [buildInfoBubble(chosen.note)] : []),
    );
  };
  paintAddToggle();
  const addMenu = document.createElement('div');
  addMenu.className = 'adv-known-menu';
  addMenu.hidden = true;
  for (const item of available) {
    const option = document.createElement('div');
    option.className = 'adv-known-option';
    const optionBtn = document.createElement('button');
    optionBtn.type = 'button';
    optionBtn.className = 'adv-known-option-btn';
    optionBtn.textContent = `${item.name}（${item.flag}）`;
    optionBtn.addEventListener('click', () => {
      chosen = item;
      paintAddToggle();
      addMenu.hidden = true;
    });
    option.append(optionBtn, buildInfoBubble(item.note));
    addMenu.append(option);
  }
  addToggle.addEventListener('click', (e) => {
    e.stopPropagation(); // 别让 document 的「点外部收起」把展开那一下立刻关掉
    const wasOpen = !addMenu.hidden;
    closeEncoderMenus(menuRoot);
    addMenu.hidden = wasOpen;
  });
  addDropdown.append(addToggle, addMenu);
  const addKnownBtn = document.createElement('button');
  addKnownBtn.className = 'settings-mini-btn';
  addKnownBtn.textContent = '添加推荐参数';
  addKnownBtn.disabled = available.length === 0;
  addKnownBtn.addEventListener('click', () => {
    if (!chosen) return;
    entry.rows.push(rowFromKnown(chosen));
    callbacks.onChange();
  });
  const addCustomBtn = document.createElement('button');
  addCustomBtn.className = 'settings-mini-btn';
  addCustomBtn.textContent = '＋ 自定义参数';
  addCustomBtn.title = '添加一行自由参数（标志自由填写，参数名自动带出）';
  addCustomBtn.addEventListener('click', () => {
    entry.rows.push({
      name: '',
      flag: '',
      value: '',
      note: '',
      kind: 'text',
      options: [],
      enabled: true,
    });
    callbacks.onChange();
  });
  addRow.append(addDropdown, addKnownBtn, addCustomBtn);
  details.append(addRow);

  const rowsBox = document.createElement('div');
  rowsBox.className = 'adv-rows';
  entry.rows.forEach((row, rowIndex) => {
    // 票 #51：按「标志是否命中当前条目编码器的推荐目录」二分——命中走推荐行
    //（命令只能从目录里选，参数名随选择带出），未命中走自定义行（命令自由
    // 填写，参数名从标志派生）。
    const known = knownParamsOf(catalog, entry).find((item) => item.flag === row.flag.trim());
    const rowEl = document.createElement('div');
    rowEl.className = known
      ? 'adv-param-row adv-param-row-known'
      : 'adv-param-row adv-param-row-custom';

    // -- 命令框：推荐行 = 自制下拉命令框；自定义行 = 自由文本 --
    if (known) {
      rowEl.append(buildKnownDropdown(rowIndex, row, known));
    } else {
      const flagInput = document.createElement('input');
      flagInput.type = 'text';
      flagInput.className = 'adv-param-flag';
      flagInput.placeholder = '标志（如 -threads）';
      flagInput.value = row.flag;
      flagInput.addEventListener('input', () => {
        row.flag = flagInput.value;
        // 票 #51：参数名从标志自动派生（去前导 -，核心库 mergeArgs 要求 name 非空）
        row.name = row.flag.trim().replace(/^-+/, '');
        onChangeLive();
      });
      rowEl.append(flagInput);
    }

    const valueWidget = buildValueWidget(row);

    const rowUp = document.createElement('button');
    rowUp.className = 'settings-mini-btn';
    rowUp.textContent = '↑';
    rowUp.title = '上移该参数行';
    rowUp.addEventListener('click', () => {
      if (rowIndex <= 0) return;
      const [moved] = entry.rows.splice(rowIndex, 1);
      entry.rows.splice(rowIndex - 1, 0, moved);
      callbacks.onChange();
    });
    const rowDown = document.createElement('button');
    rowDown.className = 'settings-mini-btn';
    rowDown.textContent = '↓';
    rowDown.title = '下移该参数行';
    rowDown.addEventListener('click', () => {
      if (rowIndex >= entry.rows.length - 1) return;
      const [moved] = entry.rows.splice(rowIndex, 1);
      entry.rows.splice(rowIndex + 1, 0, moved);
      callbacks.onChange();
    });
    const rowDel = document.createElement('button');
    rowDel.className = 'settings-mini-btn';
    rowDel.textContent = '×';
    rowDel.title = '删除该参数行';
    rowDel.addEventListener('click', () => {
      entry.rows.splice(rowIndex, 1);
      callbacks.onChange();
    });

    rowEl.append(valueWidget, rowUp, rowDown, rowDel);
    rowsBox.append(rowEl);
  });
  details.append(rowsBox);
  card.append(details);

  card.append(previewDetails);
  refreshPreview();
  return card;
}
