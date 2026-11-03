// 编码器卡（共享渲染）：一条编码器配置 = 一张卡。
//
// 谁在用：参数变体编辑（features/encoding）、视频高级创建（features/video）。
// 因此本模块**不持有列表、不依赖面板生命周期**：目录（格式规格 / 推荐参数）由
// EncoderCardCatalog 传入，增删排序 / 恢复默认 / 复制由 EncoderCardCallbacks 交还宿主。
//
// 参数合并、冲突校验、命令行预览等纯逻辑仍在 features/encoding/logic/advanced.ts
// （本模块只调用不重写；那边有单测）。这里只有布局与控件接线。
//
// 结构：卡头（折叠开关 + 序号 + 编码器选择 + 收起时的参数摘要 + 恢复默认 / ↑↓×）→
// 参数（模式 + 跟着模式切换的单一主参数；无损开关只对支持的编码器出现）→
// 高级参数行（默认收起）→ 命令行预览（默认收起）。整卡与两个折叠区都按
// data-entry-id × data-adv-region 双层键控，宿主整卡重建时照原样回写。

import { el } from './dom';
import { icon } from './icons';
import { button, iconButton, segmented, switchField } from './primitives';
import {
  availableKnownParams,
  baseFlagsOf,
  conflictingRows,
  previewImageCommand,
  previewVideoCommand,
  type AdvancedEntry,
  type AdvancedParamRow,
  type ImageSpec,
  type KnownParam,
  type RowConflict,
  type QuickSpec,
  type VideoSpec,
} from '../features/encoding/logic/advanced';

/** 卡片渲染所需的编码器目录。视频目录只用到 specs 与 encoderNames（表外编码器）。 */
export interface EncoderCardCatalog {
  kind: 'image' | 'video';
  imageSpecs: ImageSpec[];
  videoCatalog: { specs: VideoSpec[]; encoderNames: string[] } | null;
}

/** 卡片对宿主的回调：卡片不持有列表状态。 */
export interface EncoderCardCallbacks {
  /** 卡内配置被修改、需要宿主重建卡片列表（编码器切换 / 模式切换 / 行增删排序等）。 */
  onChange(): void;
  /** 上移（-1）或下移（1）该卡。 */
  onMove(delta: -1 | 1): void;
  /** 删除该卡。 */
  onRemove(): void;
  /** 「恢复默认」已把 entry 就地重置，宿主据此重建。 */
  onReset(): void;
  /** 复制命令行文本（提示文案由宿主决定）。 */
  onCopy(text: string): void;
}

/** 卡片渲染的可选环境信息（不影响宿主状态）。 */
export interface EncoderCardOptions {
  /** 命令行预览用的输入路径（原图 / 原视频）；null = 占位符。 */
  referencePath?: string | null;
  /** 该条目编码器不可用的中文原因（卡内红标）。 */
  unavailableError?: string | null;
  /** 整卡是否展开（默认展开）。条目多时宿主只展开正在编辑的那一条。 */
  open?: boolean;
}

/** 图片条目对应的规格（非图片卡或目录里没有该编码器时返回 null）。 */
export function imageSpecOf(
  catalog: EncoderCardCatalog,
  entry: AdvancedEntry,
): ImageSpec | null {
  if (catalog.kind !== 'image') return null;
  return catalog.imageSpecs.find((spec) => spec.id === entry.encoderId) ?? null;
}

/** 视频条目对应的规格（表外编码器返回 null，只支持参数行）。 */
export function videoSpecOf(
  catalog: EncoderCardCatalog,
  entry: AdvancedEntry,
): VideoSpec | null {
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

/** 当前条目的推荐参数目录（供下拉与说明使用）。 */
export function knownParamsOf(catalog: EncoderCardCatalog, entry: AdvancedEntry): KnownParam[] {
  return imageSpecOf(catalog, entry)?.knownParams ?? videoSpecOf(catalog, entry)?.knownParams ?? [];
}

/**
 * 把一条配置恢复成「刚添加时」的默认状态（与 logic/advanced.ts 的 newEntry 同口径）：
 * 质量优先、规格默认质量、目标大小 200 KB、非无损、参数行清空。条目 id 与编码器保留
 * ——用户换过编码器后点恢复默认，应按当前编码器的规格回到默认值。
 */
export function resetEntryToDefault(
  entry: AdvancedEntry,
  spec: (QuickSpec & { qualityDefault?: number }) | null,
): void {
  entry.lossless = false;
  entry.mode = 'quality';
  entry.quality = spec?.qualityDefault ?? 75;
  entry.targetBytes = 200 * 1024;
  entry.unit = 'KB';
  entry.rows = [];
}

/** 从推荐参数造一条参数行（预填名称 / 标志 / 说明 / 默认值与控件种类）。 */
function rowFromKnown(known: KnownParam): AdvancedParamRow {
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
}

/**
 * 渲染一张编码器卡（不依赖面板生命周期，可直接放进任意容器）。
 *
 * entry 会被就地修改（与既有会话态约定一致）；结构性改动（编码器切换 / 模式 / 行增删 /
 * 无损开关）经 callbacks.onChange 交宿主重建；连续输入（质量滑杆、文本）只刷新预览。
 */
export function renderEncoderCard(
  entry: AdvancedEntry,
  index: number,
  catalog: EncoderCardCatalog,
  callbacks: EncoderCardCallbacks,
  options: EncoderCardOptions = {},
): HTMLElement {
  const card = el('div', { class: 'enc-card', dataset: { entryId: entry.id } });
  const referencePath = options.referencePath ?? null;
  const spec = specOf(catalog, entry);
  const imageSpec = imageSpecOf(catalog, entry);

  // 行内容变化时只刷新预览与折叠栏计数，不重建（保住输入焦点）
  const liveCallbacks: (() => void)[] = [];
  const onChangeLive = (): void => {
    for (const fn of liveCallbacks) fn();
  };

  // ---------- 卡头 ----------
  const encoderSelect = el('select', {
    class: 'select enc-card__encoder',
    attrs: { 'aria-label': `第 ${index + 1} 项的编码器`, title: '选择编码器（同一编码器可多次添加，各自参数独立）' },
    on: {
      change: () => {
        entry.encoderId = encoderSelect.value;
        const nextSpec = specOf(catalog, entry);
        // 换编码器后质量按新规格夹回范围
        if (nextSpec) {
          entry.quality = Math.min(Math.max(entry.quality, nextSpec.qualityMin), nextSpec.qualityMax);
        }
        callbacks.onChange();
      },
    },
  }) as HTMLSelectElement;
  if (catalog.kind === 'image') {
    for (const item of catalog.imageSpecs) {
      encoderSelect.append(el('option', { text: item.displayName, attrs: { value: item.id } }));
    }
  } else if (catalog.videoCatalog) {
    for (const item of catalog.videoCatalog.specs) {
      encoderSelect.append(el('option', { text: item.displayName, attrs: { value: item.ffmpegName } }));
    }
    const inTable = new Set(catalog.videoCatalog.specs.map((item) => item.ffmpegName));
    const extras = catalog.videoCatalog.encoderNames.filter((name) => !inTable.has(name));
    if (extras.length > 0) {
      const group = el('optgroup', { attrs: { label: 'ffmpeg 枚举（无推荐参数）' } });
      for (const name of extras) group.append(el('option', { text: name, attrs: { value: name } }));
      encoderSelect.append(group);
    }
  }
  encoderSelect.value = entry.encoderId;
  if (encoderSelect.value !== entry.encoderId) {
    // 会话里的编码器不在当前目录（如表外编码器遇到枚举失败）：补一个占位项
    encoderSelect.append(
      el('option', { text: `${entry.encoderId}（不在当前枚举中）`, attrs: { value: entry.encoderId } }),
    );
    encoderSelect.value = entry.encoderId;
  }

  // ---------- 卡头：折叠开关 + 编码器 + 收起时的一句话摘要 + 操作 ----------
  const summary = el('span', { class: 'enc-card__summary' });
  const collapseToggle = el(
    'button',
    { class: 'enc-card__toggle', attrs: { type: 'button' } },
    icon('chevronDown', 'icon enc-card__chevron'),
    el('span', { class: 'enc-card__index', text: `第 ${index + 1} 项` }),
  );

  const head = el(
    'div',
    { class: 'enc-card__head' },
    collapseToggle,
    encoderSelect,
    summary,
    el(
      'div',
      { class: 'enc-card__actions' },
      button({
        label: '恢复默认',
        variant: 'quiet',
        size: 'sm',
        title: '把这条配置的质量、模式、目标大小、无损开关与全部参数行恢复到刚添加时的状态',
        onClick: () => {
          resetEntryToDefault(entry, spec);
          callbacks.onReset();
        },
      }),
      iconButton({
        label: '上移（排序影响创建顺序）',
        icon: 'chevronUp',
        variant: 'quiet',
        size: 'sm',
        onClick: () => callbacks.onMove(-1),
      }),
      iconButton({
        label: '下移',
        icon: 'chevronDown',
        variant: 'quiet',
        size: 'sm',
        onClick: () => callbacks.onMove(1),
      }),
      iconButton({
        label: '删除该编码器配置',
        icon: 'trash',
        variant: 'quiet',
        size: 'sm',
        onClick: () => callbacks.onRemove(),
      }),
    ),
  );
  card.append(head);

  const body = el('div', { class: 'enc-card__body' });
  card.append(body);

  if (options.unavailableError) {
    body.append(el('p', { class: 'enc-card__error', text: options.unavailableError }));
  }

  // ---------- 参数：模式 + 主参数（质量或目标大小，跟着模式切换） ----------
  if (spec) {
    const paramsGrid = el('div', { class: 'enc-card__params' });

    // 无损时「模式 / 质量 / 目标大小」都不生效：整块不渲染，只留无损开关，
    // 不摆一堆按了没反应的禁用控件，也不写解释这些控件为什么不能用。
    if (!entry.lossless) {
      const mode = segmented({
        items: [
          { id: 'quality', label: '质量优先', title: '按质量值直接编码' },
          { id: 'size', label: '大小优先', title: '按目标大小自动搜索最接近的质量点' },
        ],
        value: entry.mode,
        ariaLabel: '编码模式',
        size: 'sm',
        onChange: (id) => {
          entry.mode = id === 'size' ? 'size' : 'quality';
          callbacks.onChange();
        },
      });
      paramsGrid.append(el('span', { class: 'enc-card__param-label', text: '模式' }), mode.node);

      if (entry.mode === 'size') {
        const sizeInput = el('input', {
          class: 'input enc-card__size',
          attrs: { type: 'number', min: '0', step: 'any', 'aria-label': '目标大小' },
        }) as HTMLInputElement;
        const unitBytes = entry.unit === 'KB' ? 1024 : 1024 * 1024;
        const shown = entry.targetBytes / unitBytes;
        sizeInput.value = Number.isInteger(shown) ? String(shown) : shown.toFixed(2);
        sizeInput.addEventListener('change', () => {
          const bytes = Math.round(Number(sizeInput.value) * unitBytes);
          if (Number.isFinite(bytes) && bytes >= 1) entry.targetBytes = bytes;
          // 非法输入不落状态（提交时由 validateEntry 汇总报错），回显当前真值
          const current = entry.targetBytes / unitBytes;
          sizeInput.value = Number.isInteger(current) ? String(current) : current.toFixed(2);
        });
        const unitSelect = el('select', {
          class: 'select enc-card__unit',
          attrs: { 'aria-label': '目标大小单位' },
          on: {
            change: () => {
              entry.unit = unitSelect.value === 'MB' ? 'MB' : 'KB';
              callbacks.onChange();
            },
          },
        }) as HTMLSelectElement;
        for (const unit of ['KB', 'MB'] as const) {
          unitSelect.append(el('option', { text: unit, attrs: { value: unit } }));
        }
        unitSelect.value = entry.unit;
        paramsGrid.append(
          el('span', { class: 'enc-card__param-label', text: '目标大小' }),
          el('div', { class: 'enc-card__param-control enc-card__size-row' }, sizeInput, unitSelect),
        );
      } else {
        const qualityValue = el('span', {
          class: 'enc-card__value-text',
          text: String(entry.quality),
        });
        const qualityRange = el('input', {
          class: 'slider enc-card__value',
          attrs: {
            type: 'range',
            min: String(spec.qualityMin),
            max: String(spec.qualityMax),
            step: String(imageSpec?.qualityStep ?? 1),
            value: String(entry.quality),
            'aria-label': `质量（${spec.qualityFlag}）`,
          },
        }) as HTMLInputElement;
        qualityRange.addEventListener('input', () => {
          entry.quality = Number(qualityRange.value);
          qualityValue.textContent = qualityRange.value;
          onChangeLive();
        });
        paramsGrid.append(
          el('span', { class: 'enc-card__param-label', text: `质量（${spec.qualityFlag}）` }),
          el('div', { class: 'enc-card__param-control' }, qualityRange, qualityValue),
        );
      }
    }
    body.append(paramsGrid);

    // 不支持无损的编码器（如 JPEG）不渲染开关：不摆了却按不下去，也不解释。
    // 开关落进同一张参数网格，和上面的「模式 / 质量」左缘对齐。
    if (spec.losslessSupported) {
      const lossless = switchField({
        label: '无损',
        checked: entry.lossless,
        onChange: (next) => {
          entry.lossless = next;
          callbacks.onChange();
        },
      });
      lossless.button.title = spec.losslessNote;
      lossless.button.setAttribute('aria-label', '无损（像素与原图逐位一致）');
      paramsGrid.append(
        el('span', { class: 'enc-card__param-label', text: '无损' }),
        el('div', { class: 'enc-card__param-control' }, lossless.button),
      );
    }
  } else {
    body.append(
      el('p', {
        class: 'enc-card__hint',
        text: '表外编码器（无推荐参数）：用下面的高级参数行自行配置，命令行预览可自查。',
      }),
    );
  }

  // ---------- 折叠区（高级参数行 / 命令行预览）：同一套开关，不用两种折叠样式 ----------
  const makeRegion = (
    name: string,
    label: string,
    openByDefault: boolean,
  ): { root: HTMLDivElement; body: HTMLDivElement; labelEl: HTMLElement } => {
    const labelEl = el('span', { class: 'enc-card__region-label', text: label });
    const btn = el(
      'button',
      { class: 'enc-card__region-btn', attrs: { type: 'button' } },
      icon('chevronDown', 'icon enc-card__chevron'),
      labelEl,
    );
    const regionBody = el('div', { class: 'enc-card__region-body' });
    const root = el(
      'div',
      {
        class: 'enc-card__region',
        dataset: { advRegion: name, open: String(openByDefault) },
      },
      btn,
      regionBody,
    );
    const apply = (open: boolean): void => {
      regionBody.hidden = !open;
      root.dataset.open = String(open);
      btn.setAttribute('aria-expanded', String(open));
      btn.querySelector('.icon')?.classList.toggle('is-flipped', !open);
    };
    btn.addEventListener('click', () => apply(regionBody.hidden));
    apply(openByDefault);
    return { root, body: regionBody, labelEl };
  };

  // 命令行预览（默认收起）
  const cmdEl = el('code', { class: 'enc-card__cmd' });
  const preview = makeRegion('preview', '命令行预览', false);
  preview.body.append(
    el(
      'div',
      { class: 'enc-card__preview-row' },
      cmdEl,
      button({
        label: '复制',
        variant: 'quiet',
        size: 'sm',
        title: '复制这条命令行（可直接粘贴到终端执行）',
        onClick: () => callbacks.onCopy(cmdEl.textContent ?? ''),
      }),
    ),
  );

  const refreshPreview = (): void => {
    const currentImageSpec = imageSpecOf(catalog, entry);
    cmdEl.textContent =
      catalog.kind === 'image'
        ? currentImageSpec
          ? previewImageCommand(currentImageSpec, entry, referencePath)
          : entry.encoderId
        : previewVideoCommand(videoSpecOf(catalog, entry), entry, referencePath);
    cmdEl.title =
      catalog.kind === 'image' && entry.mode === 'size' && !entry.lossless
        ? '大小优先：实际质量点由目标大小搜索决定，此预览按当前质量值估算'
        : '输入为原图路径，产物写到原图旁的 Pixel Arena 文件夹';
  };

  // 高级参数行（默认收起：条目一多，展开的参数行会把卡撑得很长）
  const rowsBox = el('div', { class: 'enc-card__rows' });
  const knownList = knownParamsOf(catalog, entry);
  // 基础命令行占用的标志（由模式 / 质量 / 无损开关决定）：与 mergeArgs 同口径，
  // 这里提前算出来，让推荐参数下拉直接禁用这些项、自定义行即时红字提示。
  // 无损开关 / 模式变化会经宿主重建整卡，因此这份集合随控件切换自动更新。
  const baseFlags = baseFlagsOf(spec, entry);
  const baseFlagSet = new Set(baseFlags);
  const baseConflictText = (flag: string): string =>
    `与基础命令行冲突：基础参数里已经带了 ${flag}（由模式 / 质量 / 无损开关决定）`;

  // 顶部推荐参数下拉只列「还没有被任何行占用」的项；与基础命令行冲突的项仍然列出
  // 但禁用——用户需要看到它为什么不能选，而不是从列表里莫名消失（原生 option
  // disabled 是真的不可选，不是只变灰）。
  const knownOptions = availableKnownParams(knownList, entry.rows, null);
  const selectableKnown = knownOptions.filter((known) => !baseFlagSet.has(known.flag));

  const knownSelect = el('select', {
    class: 'select enc-card__known',
    attrs: { 'aria-label': '推荐参数' },
  }) as HTMLSelectElement;
  for (const known of knownOptions) {
    const conflict = baseFlagSet.has(known.flag);
    knownSelect.append(
      el('option', {
        text: conflict
          ? `${known.name}（${known.flag}）（与基础命令行冲突）`
          : `${known.name}（${known.flag}）`,
        attrs: {
          value: known.flag,
          title: conflict ? baseConflictText(known.flag) : known.note,
          disabled: conflict,
        },
      }),
    );
  }
  // 默认停在第一个真正能添加的项上，避免「下拉显示一个禁用项、点添加没反应」
  knownSelect.value = (selectableKnown[0] ?? knownOptions[0])?.flag ?? '';
  const addKnown = button({
    label: '添加推荐参数',
    variant: 'secondary',
    size: 'sm',
    disabled: selectableKnown.length === 0,
    title:
      knownOptions.length === 0
        ? '推荐参数都已经在参数行里了'
        : selectableKnown.length === 0
          ? '剩余的推荐参数都与基础命令行冲突：先调整模式或无损开关'
          : '把选中的推荐参数加成一行（已过滤掉已占用与冲突的项）',
    onClick: () => {
      const known = knownOptions.find((item) => item.flag === knownSelect.value);
      // 禁用项在原生下拉里点不到，这里再挡一次：防御程序化改 value 或旧内核仍允许选禁用项
      if (!known || baseFlagSet.has(known.flag)) return;
      entry.rows.push(rowFromKnown(known));
      callbacks.onChange();
    },
  });
  const addCustom = button({
    label: '＋ 自定义参数',
    variant: 'quiet',
    size: 'sm',
    title: '添加一行自由参数（标志自由填写，参数名自动带出）',
    onClick: () => {
      entry.rows.push({ name: '', flag: '', value: '', note: '', kind: 'text', options: [], enabled: true });
      callbacks.onChange();
    },
  });
  // 基础命令行占用的标志始终写清在折叠区里：推荐参数下拉的「（冲突）」与自定义行
  // 的红字都指回这一句，不让悬浮说明成为唯一出口。
  const baseNote =
    baseFlags.length > 0
      ? el('p', {
          class: 'enc-card__known-note',
          text:
            `基础命令行已带 ${baseFlags.join('、')}（由模式 / 质量 / 无损开关决定）：` +
            '这些标志不能再作为高级参数添加。',
        })
      : null;
  const addRow = el(
    'div',
    { class: 'enc-card__add-row' },
    knownOptions.length > 0 ? knownSelect : el('span', { class: 'enc-card__hint', text: '推荐参数已全部添加' }),
    addKnown,
    addCustom,
    baseNote,
  );

  const advanced = makeRegion('advanced', '高级参数行', false);
  advanced.body.append(addRow, rowsBox);

  const syncSummary = (): void => {
    const active = entry.rows.filter((row) => row.enabled).length;
    advanced.labelEl.textContent = `高级参数（${active} 项生效 / 共 ${entry.rows.length} 行）`;
  };
  syncSummary();

  /** 参数行的值控件：布尔 = 开/关分段；下拉 = select；数值/文本 = input。 */
  const valueWidget = (row: AdvancedParamRow): HTMLElement => {
    if (row.kind === 'bool') {
      const toggle = segmented({
        items: [
          { id: 'on', label: '开' },
          { id: 'off', label: '关' },
        ],
        value: row.enabled ? 'on' : 'off',
        ariaLabel: `是否在命令行中启用 ${row.flag || '该参数'}`,
        size: 'sm',
        onChange: (id) => {
          row.enabled = id === 'on';
          callbacks.onChange();
        },
      });
      return toggle.node;
    }
    if (row.kind === 'choice') {
      const select = el('select', {
        class: 'select enc-card__value',
        attrs: { 'aria-label': row.name || row.flag },
        on: {
          change: () => {
            row.value = select.value;
            onChangeLive();
          },
        },
      }) as HTMLSelectElement;
      for (const option of row.options) {
        select.append(el('option', { text: option, attrs: { value: option } }));
      }
      select.value = row.value;
      return select;
    }
    const input = el('input', {
      class: 'input enc-card__value',
      attrs: {
        type: row.kind === 'number' ? 'number' : 'text',
        'aria-label': row.name || row.flag || '参数值',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    }) as HTMLInputElement;
    input.value = row.value;
    input.addEventListener(row.kind === 'number' ? 'change' : 'input', () => {
      row.value = input.value;
      onChangeLive();
    });
    return input;
  };

  /** 参数行的冲突视图：输入时只更新红字与 aria，不重建整卡（保住输入焦点）。 */
  interface RowConflictView {
    rowEl: HTMLDivElement;
    flagControl: HTMLElement;
    issueEl: HTMLParagraphElement;
    issueId: string;
  }
  const conflictViews: RowConflictView[] = [];

  /** 用同一份纯函数刷新所有行的冲突提示（首渲染与输入时的即时提示不两套口径）。 */
  const applyConflicts = (): void => {
    const byRow = new Map<number, RowConflict[]>();
    for (const conflict of conflictingRows(spec, entry)) {
      const list = byRow.get(conflict.index);
      if (list) list.push(conflict);
      else byRow.set(conflict.index, [conflict]);
    }
    conflictViews.forEach((view, index) => {
      const message = (byRow.get(index) ?? []).map((conflict) => conflict.message).join('；');
      // 文案没变就不重写 textContent：避免输入时 aria 提示被重复播报
      if (view.issueEl.textContent !== message) view.issueEl.textContent = message;
      view.issueEl.hidden = message === '';
      view.rowEl.classList.toggle('enc-row--conflict', message !== '');
      if (message === '') {
        view.flagControl.removeAttribute('aria-invalid');
        view.flagControl.removeAttribute('aria-describedby');
      } else {
        // 红字是视觉提示，aria 说明并行给出：读屏用户也要知道这一行为什么不能用
        view.flagControl.setAttribute('aria-invalid', 'true');
        view.flagControl.setAttribute('aria-describedby', view.issueId);
      }
    });
  };

  entry.rows.forEach((row, rowIndex) => {
    const rowEl = el('div', { class: 'enc-row' });
    const issueId = `enc-row-issue-${entry.id}-${rowIndex}`;
    const issueEl = el('p', {
      class: 'enc-row__issue',
      attrs: { id: issueId, role: 'alert' },
    }) as HTMLParagraphElement;
    issueEl.hidden = true;
    // 行 + 红字说明作为一个整体参与纵向排布；红字不挤进横向控件行
    const rowWrap = el('div', { class: 'enc-row-wrap' }, rowEl, issueEl);

    // 命令框：命中推荐目录的行走只读下拉（选项来自目录），自定义行走自由文本
    const known = knownList.find((item) => item.flag === row.flag.trim());
    let flagControl: HTMLElement;
    if (known) {
      // 其它行已占用的项不再出现在这个下拉里，避免在这里又制造一次重复；本行当前
      // 标志必须保留（即使被别处占用或与基础参数冲突），否则下拉无法回显当前值。
      const options = availableKnownParams(knownList, entry.rows, rowIndex);
      const pick = el('select', {
        class: 'select enc-row__flag',
        attrs: { 'aria-label': '推荐参数', title: known.note },
        on: {
          change: () => {
            const next = knownList.find((item) => item.flag === pick.value);
            if (!next || baseFlagSet.has(next.flag)) return;
            entry.rows[rowIndex] = rowFromKnown(next);
            callbacks.onChange();
          },
        },
      }) as HTMLSelectElement;
      for (const item of options) {
        const conflict = baseFlagSet.has(item.flag);
        const self = item.flag === row.flag.trim();
        pick.append(
          el('option', {
            text:
              conflict && !self
                ? `${item.name}（${item.flag}）（与基础命令行冲突）`
                : `${item.name}（${item.flag}）`,
            attrs: {
              value: item.flag,
              title: conflict ? baseConflictText(item.flag) : item.note,
              disabled: conflict && !self,
            },
          }),
        );
      }
      pick.value = row.flag.trim();
      flagControl = pick;
    } else {
      const flagInput = el('input', {
        class: 'input enc-row__flag',
        attrs: {
          type: 'text',
          placeholder: '标志（如 -threads）',
          'aria-label': '参数标志',
          autocomplete: 'off',
          spellcheck: 'false',
        },
      }) as HTMLInputElement;
      flagInput.value = row.flag;
      flagInput.addEventListener('input', () => {
        row.flag = flagInput.value;
        // 参数名从标志自动派生（核心库 mergeArgs 要求 name 非空）
        row.name = row.flag.trim().replace(/^-+/, '');
        onChangeLive();
      });
      // 失焦时重建一次：标志变了会影响其它行下拉的可用项，选项列表要跟着刷新；
      // 输入过程中不重建（否则焦点会丢），只即时更新红字说明。
      flagInput.addEventListener('change', () => callbacks.onChange());
      flagControl = flagInput;
    }
    rowEl.append(
      flagControl,
      valueWidget(row),
      iconButton({
        label: '上移该参数行',
        icon: 'chevronUp',
        variant: 'quiet',
        size: 'sm',
        onClick: () => {
          if (rowIndex <= 0) return;
          const [moved] = entry.rows.splice(rowIndex, 1);
          entry.rows.splice(rowIndex - 1, 0, moved);
          callbacks.onChange();
        },
      }),
      iconButton({
        label: '下移该参数行',
        icon: 'chevronDown',
        variant: 'quiet',
        size: 'sm',
        onClick: () => {
          if (rowIndex >= entry.rows.length - 1) return;
          const [moved] = entry.rows.splice(rowIndex, 1);
          entry.rows.splice(rowIndex + 1, 0, moved);
          callbacks.onChange();
        },
      }),
      iconButton({
        label: '删除该参数行',
        icon: 'close',
        variant: 'quiet',
        size: 'sm',
        onClick: () => {
          entry.rows.splice(rowIndex, 1);
          callbacks.onChange();
        },
      }),
    );
    conflictViews.push({ rowEl, flagControl, issueEl, issueId });
    rowsBox.append(rowWrap);
  });
  applyConflicts();

  body.append(advanced.root, preview.root);

  // ---------- 整卡折叠：收起后只留「第 N 项 + 编码器 + 参数摘要」 ----------
  const summaryText = (): string => {
    if (entry.lossless) return '无损';
    if (entry.mode === 'size') {
      const unitBytes = entry.unit === 'KB' ? 1024 : 1024 * 1024;
      const shown = entry.targetBytes / unitBytes;
      const text = Number.isInteger(shown) ? String(shown) : shown.toFixed(2);
      return `目标 ${text} ${entry.unit}`;
    }
    return `质量 ${entry.quality}`;
  };

  const applyOpen = (next: boolean): void => {
    body.hidden = !next;
    summary.hidden = next;
    card.dataset.open = String(next);
    collapseToggle.setAttribute('aria-expanded', String(next));
    collapseToggle.querySelector('.icon')?.classList.toggle('is-flipped', !next);
  };
  collapseToggle.addEventListener('click', () => applyOpen(body.hidden));
  summary.textContent = summaryText();
  applyOpen(options.open ?? true);

  liveCallbacks.push(() => {
    refreshPreview();
    syncSummary();
    // 自定义行边输入边判重复 / 基础冲突（结构变化另走 onChange 重建，不在这里重建）
    applyConflicts();
  });
  refreshPreview();
  return card;
}
