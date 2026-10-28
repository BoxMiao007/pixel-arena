// 编码器卡（共享渲染）：一条编码器配置 = 一张卡。
//
// 谁在用：图片条目队列的逐图编辑（features/encoding）、视频高级创建（features/video）。
// 因此本模块**不持有列表、不依赖面板生命周期**：目录（格式规格 / 推荐参数）由
// EncoderCardCatalog 传入，增删排序 / 恢复默认 / 复制由 EncoderCardCallbacks 交还宿主。
//
// 参数合并、冲突校验、命令行预览等纯逻辑仍在 features/encoding/logic/advanced.ts
// （本模块只调用不重写；那边有单测）。这里只有布局与控件接线。
//
// 结构：卡头（序号 + 编码器选择 + 恢复默认 + ↑↓×）→ 快速参数（无损 / 质量 / 目标大小 /
// 模式）→ 高级参数行（默认展开）→ 命令行预览（默认收起）。折叠区按
// data-entry-id × data-adv-region 双层键控，宿主整卡重建时照原样回写。

import { el } from './dom';
import { icon } from './icons';
import { button, field, iconButton, segmented, sliderField } from './primitives';
import {
  previewImageCommand,
  previewVideoCommand,
  type AdvancedEntry,
  type AdvancedParamRow,
  type ImageSpec,
  type KnownParam,
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

  const head = el(
    'div',
    { class: 'enc-card__head' },
    el('span', { class: 'enc-card__index', text: `第 ${index + 1} 项` }),
    encoderSelect,
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
  );
  card.append(head);

  if (options.unavailableError) {
    card.append(el('p', { class: 'enc-card__error', text: options.unavailableError }));
  }

  // ---------- 命令行预览（默认收起） ----------
  const cmdEl = el('code', { class: 'enc-card__cmd' });
  const previewDetails = el(
    'details',
    { class: 'enc-card__preview', dataset: { advRegion: 'preview' } },
    el('summary', { class: 'enc-card__summary', text: '命令行预览' }),
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

  // ---------- 快速参数 ----------
  if (spec) {
    const quick = el('div', { class: 'enc-card__quick' });

    // 无损（不支持时禁用并给出原因）
    const losslessButton = button({
      label: entry.lossless ? '无损：开' : '无损：关',
      variant: entry.lossless ? 'primary' : 'secondary',
      size: 'sm',
      title: spec.losslessSupported ? spec.losslessNote || '无损：像素与原图逐位一致' : spec.losslessNote,
      disabled: !spec.losslessSupported,
      onClick: () => {
        entry.lossless = !entry.lossless;
        callbacks.onChange();
      },
    });
    quick.append(
      field({ label: '无损', control: losslessButton, hint: spec.losslessSupported ? undefined : spec.losslessNote }),
    );

    // 质量
    const quality = sliderField({
      label: `质量（${spec.qualityFlag}）`,
      min: spec.qualityMin,
      max: spec.qualityMax,
      step: imageSpec?.qualityStep ?? 1,
      value: entry.quality,
      onInput: (value) => {
        entry.quality = value;
        onChangeLive();
      },
      format: (value) => String(value),
    });
    quality.input.disabled = entry.lossless;
    quick.append(quality.node);

    // 目标大小（KB / MB；真值一律字节）
    const sizeInput = el('input', {
      class: 'input enc-card__size',
      attrs: { type: 'number', min: '0', step: 'any', 'aria-label': '目标大小' },
    }) as HTMLInputElement;
    const unitBytes = entry.unit === 'KB' ? 1024 : 1024 * 1024;
    const shown = entry.targetBytes / unitBytes;
    sizeInput.value = Number.isInteger(shown) ? String(shown) : shown.toFixed(2);
    sizeInput.disabled = entry.lossless || entry.mode === 'quality';
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
    unitSelect.disabled = entry.lossless || entry.mode === 'quality';
    quick.append(
      field({
        label: '目标大小',
        control: el('div', { class: 'enc-card__size-row' }, sizeInput, unitSelect),
        hint: entry.mode === 'quality' ? '仅大小优先模式使用' : undefined,
      }),
    );

    // 模式
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
    quick.append(field({ label: '模式', control: mode.node }));
    card.append(quick);
  } else {
    card.append(
      el('p', {
        class: 'enc-card__hint',
        text: '表外编码器（无推荐参数）：用下面的高级参数行自行配置，命令行预览可自查。',
      }),
    );
  }

  // ---------- 高级参数行（默认展开） ----------
  const toggleAdvanced = el(
    'button',
    { class: 'btn btn--quiet btn--sm enc-card__region-btn', attrs: { type: 'button', 'aria-expanded': 'true' } },
    icon('chevronDown', 'icon enc-card__chevron'),
    el('span', { text: '' }),
  );
  const summaryText = toggleAdvanced.querySelector('span')!;
  const rowsBox = el('div', { class: 'enc-card__rows' });

  const knownList = knownParamsOf(catalog, entry);
  const usedFlags = new Set(entry.rows.map((row) => row.flag.trim()));
  const available = knownList.filter((known) => !usedFlags.has(known.flag));

  const knownSelect = el('select', {
    class: 'select enc-card__known',
    attrs: { 'aria-label': '推荐参数' },
  }) as HTMLSelectElement;
  for (const known of available) {
    knownSelect.append(
      el('option', {
        text: `${known.name}（${known.flag}）`,
        attrs: { value: known.flag, title: known.note },
      }),
    );
  }
  const addKnown = button({
    label: '添加推荐参数',
    variant: 'secondary',
    size: 'sm',
    disabled: available.length === 0,
    onClick: () => {
      const known = available.find((item) => item.flag === knownSelect.value);
      if (!known) return;
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
  const addRow = el(
    'div',
    { class: 'enc-card__add-row' },
    available.length > 0 ? knownSelect : el('span', { class: 'enc-card__hint', text: '推荐参数已全部添加' }),
    addKnown,
    addCustom,
  );

  const syncSummary = (): void => {
    const active = entry.rows.filter((row) => row.enabled).length;
    summaryText.textContent = `高级参数行（${active} 项生效 / 共 ${entry.rows.length} 行）`;
  };
  syncSummary();

  const advancedBody = el(
    'div',
    { class: 'enc-card__region-body' },
    addRow,
    rowsBox,
  );
  toggleAdvanced.addEventListener('click', () => {
    const open = advancedBody.hidden;
    advancedBody.hidden = !open;
    advancedDetails.dataset.open = String(open);
    toggleAdvanced.setAttribute('aria-expanded', String(open));
    toggleAdvanced.querySelector('.icon')?.classList.toggle('is-flipped', !open);
  });
  const advancedDetails = el(
    'div',
    { class: 'enc-card__advanced', dataset: { advRegion: 'advanced', open: 'true' } },
    toggleAdvanced,
    advancedBody,
  );

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

  entry.rows.forEach((row, rowIndex) => {
    const rowEl = el('div', { class: 'enc-row' });
    // 命令框：命中推荐目录的行走只读下拉（选项来自目录），自定义行走自由文本
    const known = knownList.find((item) => item.flag === row.flag.trim());
    if (known) {
      const pick = el('select', {
        class: 'select enc-row__flag',
        attrs: { 'aria-label': '推荐参数', title: known.note },
        on: {
          change: () => {
            const next = knownList.find((item) => item.flag === pick.value);
            if (!next) return;
            entry.rows[rowIndex] = rowFromKnown(next);
            callbacks.onChange();
          },
        },
      }) as HTMLSelectElement;
      for (const item of knownList) {
        pick.append(el('option', { text: `${item.name}（${item.flag}）`, attrs: { value: item.flag } }));
      }
      pick.value = row.flag.trim();
      rowEl.append(pick);
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
      rowEl.append(flagInput);
    }
    rowEl.append(
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
    rowsBox.append(rowEl);
  });

  card.append(advancedDetails, previewDetails);
  liveCallbacks.push(() => {
    refreshPreview();
    syncSummary();
  });
  refreshPreview();
  return card;
}
