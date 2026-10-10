// 高级创建面板（T29-3）：「新建评测轮 → 高级」打开的覆盖层面板，决策 D19/D20：
// - 高级创建 = 多编码器条目（同一编码器可多次）+ 每条目独立快速参数（质量滑块 /
//   目标大小 / 无损开关按能力禁用）+ 默认折叠的「高级参数」折叠栏（参数行增删排序，
//   支持布尔开关/下拉/数值/自由文本）+ 每条目命令行预览（可复制）；
// - 会话态（src/advanced.ts 的 sessionFor，D19）：配置不持久化，重启归零；产物与
//   encodingParams 由创建流程经 round_add_candidates 随评测轮持久化；
// - 视频跑分组同样可开高级创建（D20）：编码器按格式拆四条静态规格 + ffmpeg
//   -encoders 动态枚举（表外可选、无推荐值）；T29-3 只做选择/参数/预览与建轮，
//   视频自动编码链路属第二版视频一站式（Out of Scope）；
// - 校验（票面验收 5）：必填缺失 / 范围 / 同标志冲突在建轮前汇总报出，坏参数
//   不联网不建轮。
//
// 视觉复用设置面板的 overlay/panel 样式（settings-*），本模块只补高级特有布局。

import { invoke } from '@tauri-apps/api/core';
import { ConflictSession, type ConflictAnswer } from './conflict';
import { infoIconSvg } from './settings-ui';
import {
  addEntry,
  availabilityErrors,
  buildEntryArgsLenient,
  moveEntry,
  previewImageCommand,
  previewVideoCommand,
  removeEntry,
  sessionFor,
  validateEntry,
  dropSession,
  type AdvancedEntry,
  type AdvancedParamRow,
  type AdvancedVideoCatalog,
  type ImageSpec,
  type KnownParam,
  type QuickSpec,
  type ToolStatusLite,
  type VideoSpec,
} from './advanced';

/** 后端 advanced_encode 回传（camelCase，与核心库 AdvancedProduct 一致）。 */
export interface AdvancedProductDto {
  path: string;
  encodingParams: string;
  commandLine: string;
  note: string | null;
}

/** advanced_encode 回包（T30 冲突询问协议，tag=kind）：done = 产物已生成；
 * conflict = 「询问」策略下目标名与已有文件冲突、尚未写入任何文件。 */
export type AdvancedEncodeOutcome =
  | { kind: 'done'; product: AdvancedProductDto }
  | { kind: 'conflict'; proposedName: string };

/** 面板对宿主（main.ts）的依赖：文件选择与既有评测轮操作的全部接线点。 */
export interface AdvancedDeps {
  kind: 'image' | 'video';
  /** 弹文件对话框选原图（图片高级创建）；取消返回 null。 */
  pickReference(): Promise<string | null>;
  /** 打开面板时的预填原图：当前评测轮已选原图时直接沿用（可重选覆盖）。 */
  initialReference(): string | null;
  /** 跑分忙标志（忙时按钮置灰的语义与主界面一致）。 */
  isBusy(): boolean;
  setStatus(text: string, isError?: boolean, title?: string): void;
  /** 新建并激活一轮评测（返回组 id 与新轮 id；命名沿用「评测轮 N」）。 */
  createRound(): Promise<{ groupId: string; roundId: string }>;
  setReference(groupId: string, roundId: string, path: string): Promise<void>;
  /** 单个编码任务（advanced_encode；编码器解析/参数合并/命名都在核心库）。
   * conflicts = 本批次的冲突决策会话（T30）：回包为 conflict 时经它取决定，
   * 「覆盖」带 conflictDecision 重调，「跳过」抛错进失败清单。 */
  encode(
    groupId: string,
    roundId: string,
    referencePath: string,
    entry: AdvancedEntry,
    conflicts: ConflictSession,
  ): Promise<AdvancedProductDto>;
  /** 产物带 encodingParams 纳入本轮（产物与参数随轮持久化，D19）。 */
  addCandidates(groupId: string, roundId: string, paths: string[], params: string[]): Promise<void>;
  /** 大小优先不可达标注（与一站式同机制，随轮持久化）。 */
  setNote(groupId: string, roundId: string, path: string, note: string): Promise<void>;
  /** 轮级备注（视频高级创建确认后把配置摘要与命令行写进新轮，随轮持久化）。 */
  setRoundNote(groupId: string, roundId: string, note: string): Promise<void>;
  /** 复用主界面的整轮跑分循环。 */
  scoreRound(): Promise<void>;
  /** T30：产物名冲突询问弹窗（设置策略为「询问」时被调；返回覆盖/跳过决定）。 */
  askConflict(fileName: string): Promise<ConflictAnswer>;
  /** 创建完成后的整页重渲染（新轮出现在评测轮栏）。 */
  rerender(): void;
}

/**
 * 打开高级创建面板（覆盖层挂 body，关闭即销毁；配置留在会话态）。
 * groupId = 当前跑分组 id（会话态按组键控）；kind 来自跑分组类型。
 */
export async function openAdvancedPanel(groupId: string, deps: AdvancedDeps): Promise<void> {
  const kind = deps.kind;
  const session = sessionFor(groupId, kind);
  // 预填原图：当前评测轮已选原图时直接沿用（面板内可重选覆盖）
  if (!session.referencePath) {
    session.referencePath = deps.initialReference();
  }

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay adv-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel adv-panel';
  overlay.append(panel);

  // 推荐行下拉的共享收起出口（票 #51）：同一时间至多一个展开（与顶栏菜单同约定），
  // 点面板外任何地方统一收起；面板关闭时摘掉 document 监听。toggle 自身
  // stopPropagation，展开那一下不会被本监听立刻收掉。
  const closeKnownMenus = (): void => {
    for (const menu of entriesBox.querySelectorAll<HTMLElement>('.adv-known-menu')) {
      menu.hidden = true;
    }
  };
  const onDocClick = (): void => closeKnownMenus();
  document.addEventListener('click', onDocClick);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('click', onDocClick);
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // ---------- 头部与说明 ----------
  const head = document.createElement('div');
  head.className = 'settings-head';
  const title = document.createElement('h2');
  title.textContent = kind === 'image' ? '高级新建评测轮（图片）' : '高级新建评测轮（视频）';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭高级创建（配置保留到下次打开）';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);
  panel.append(head);

  const hint = document.createElement('p');
  hint.className = 'settings-hint';
  hint.textContent =
    kind === 'image'
      ? '为每个编码器单独配置参数，一次生成全部产物并入同一轮跑分；产物写到原图旁的' +
        '「Pixel Arena」文件夹，编码参数随评测轮保存。高级创建的配置只在本次运行内保留。'
      : '选择视频编码器（按格式拆分 + ffmpeg 实际枚举）并配置参数、预览命令行。本版本只做' +
        '创建流程与能力定义：确认后新建评测轮并把配置与命令行写进轮备注，视频自动编码链路' +
        '将在后续版本提供；产物可复制命令行自行编码后用「添加跑分视频」导入。';
  panel.append(hint);

  // ---------- 目录拉取（图片规格 / 视频规格 + ffmpeg 枚举） ----------
  let videoCatalog: AdvancedVideoCatalog | null = null;
  let imageSpecs: ImageSpec[] = [];
  let catalogError: string | null = null;

  const ffmpegStatus = document.createElement('p');
  ffmpegStatus.className = 'settings-hint adv-ffmpeg-status';

  try {
    if (kind === 'image') {
      imageSpecs = await invoke<ImageSpec[]>('advanced_image_catalog');
    } else {
      videoCatalog = await invoke<AdvancedVideoCatalog>('advanced_video_catalog');
      ffmpegStatus.textContent = videoCatalog.ffmpegAvailable
        ? `ffmpeg 就绪：${videoCatalog.ffmpegPath}`
        : `ffmpeg 不可用（${videoCatalog.ffmpegError ?? '未知原因'}）。可在设置页配置路径；编码器仍可选择并预览。`;
      panel.append(ffmpegStatus);
    }
  } catch (err) {
    catalogError = String(err);
  }

  // ---------- 图片：原图选择 ----------
  if (kind === 'image') {
    const referenceLine = document.createElement('div');
    referenceLine.className = 'settings-row adv-reference';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'settings-mini-btn';
    const refName = document.createElement('span');
    refName.className = 'adv-reference-name';
    const syncRef = (): void => {
      refName.textContent = session.referencePath ?? '尚未选择原图（产物从它生成，必选）';
      refName.title = session.referencePath ?? '';
      pickBtn.textContent = session.referencePath ? '重选原图' : '选择原图';
    };
    pickBtn.addEventListener('click', () => {
      void (async () => {
        const picked = await deps.pickReference();
        if (!picked) return;
        session.referencePath = picked;
        syncRef();
      })();
    });
    referenceLine.append(pickBtn, refName);
    syncRef();
    panel.append(referenceLine);
  }

  // ---------- 编码器条目区 / 报错 / 动作 ----------
  const entriesBox = document.createElement('div');
  entriesBox.className = 'adv-entries';
  panel.append(entriesBox);

  const errorLine = document.createElement('p');
  errorLine.className = 'settings-error adv-error';
  if (catalogError) {
    errorLine.textContent = `编码器目录加载失败: ${catalogError}。可关闭面板重试；视频侧仍可用表外方式配置。`;
  }
  panel.append(errorLine);

  const actions = document.createElement('div');
  actions.className = 'settings-actions adv-actions';
  const createBtn = document.createElement('button');
  createBtn.className = 'settings-primary-btn';
  createBtn.textContent = kind === 'image' ? '创建并生成' : '创建评测轮';
  const addFirstBtn = document.createElement('button');
  addFirstBtn.className = 'settings-mini-btn';
  addFirstBtn.textContent = '＋ 添加编码器';
  addFirstBtn.title = '把一个编码器加入本次高级创建（同一编码器可添加多次）';
  actions.append(addFirstBtn, createBtn);
  panel.append(actions);

  /** 当前条目的规格：图片按 id 查；视频按 ffmpeg 名查（表外返回 null）。 */
  const specOf = (entry: AdvancedEntry): QuickSpec | null => {
    if (kind === 'image') {
      return imageSpecs.find((s) => s.id === entry.encoderId) ?? null;
    }
    return videoCatalog?.specs.find((s) => s.ffmpegName === entry.encoderId) ?? null;
  };
  const imageSpecOf = (entry: AdvancedEntry): ImageSpec | null =>
    kind === 'image' ? imageSpecs.find((s) => s.id === entry.encoderId) ?? null : null;
  const videoSpecOf = (entry: AdvancedEntry): VideoSpec | null =>
    kind === 'video' ? videoCatalog?.specs.find((s) => s.ffmpegName === entry.encoderId) ?? null : null;
  const knownParamsOf = (entry: AdvancedEntry): KnownParam[] => {
    if (kind === 'image') {
      return imageSpecOf(entry)?.knownParams ?? [];
    }
    return videoSpecOf(entry)?.knownParams ?? [];
  };
  const entryLabel = (entry: AdvancedEntry): string => {
    const spec = specOf(entry);
    return spec ? spec.displayName : entry.encoderId;
  };
  /** 条目对应的工具键（可用性校验用）：图片 = 编码器键（cjpeg 等）；视频统一 ffmpeg。
   * 表外条目（找不到规格映射）返回 null，跳过可执行文件校验。 */
  const toolKeyOf = (entry: AdvancedEntry): string | null => {
    if (kind === 'image') {
      return imageSpecOf(entry)?.toolKey ?? null;
    }
    return 'ffmpeg';
  };

  // 编码器可执行文件不可用的条目（AC5）：entryId → 错误文本，条目卡片红标展示，
  // 点「创建」重新校验通过后清空
  const unavailableEntries = new Map<string, string>();

  // ---------- 预览与复制 ----------
  const refreshPreview = (entry: AdvancedEntry, cmdEl: HTMLElement): void => {
    const spec = specOf(entry);
    const line =
      kind === 'image'
        ? previewImageCommand(spec as ImageSpec, entry, session.referencePath)
        : previewVideoCommand(videoSpecOf(entry), entry, session.referencePath);
    cmdEl.textContent = line;
    cmdEl.title =
      kind === 'image' && entry.mode === 'size' && !entry.lossless
        ? '大小优先模式：实际质量点由目标大小搜索确定，此预览按当前滑杆值估算'
        : '复制后可直接粘贴到 shell 执行（输入为原图路径，产物写在原图旁的 Pixel Arena 文件夹）';
  };

  const copyLine = (text: string): void => {
    const done = (): void => deps.setStatus('已复制命令行');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  };

  // ---------- 参数行控件（布尔开关 / 下拉 / 数值 / 自由文本，票面验收 3） ----------
  // 票 #51：值控件一律不设原生 title——说明统一走行内 ⓘ 气泡，避免气泡与
  // 系统 tooltip 双弹。
  const buildValueWidget = (row: AdvancedParamRow, onChange: () => void): HTMLElement => {
    if (row.kind === 'bool') {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = row.enabled;
      check.addEventListener('change', () => {
        row.enabled = check.checked;
        onChange();
      });
      return check;
    }
    if (row.kind === 'choice') {
      const select = document.createElement('select');
      select.className = 'adv-param-value';
      for (const option of row.options) {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        select.append(opt);
      }
      select.value = row.value;
      select.addEventListener('change', () => {
        row.value = select.value;
        onChange();
      });
      return select;
    }
    const input = document.createElement('input');
    input.type = row.kind === 'number' ? 'number' : 'text';
    input.className = 'adv-param-value';
    input.value = row.value;
    input.addEventListener(row.kind === 'number' ? 'change' : 'input', () => {
      row.value = input.value;
      onChange();
    });
    return input;
  };

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

  // ---------- 推荐行：自制下拉命令框 + ⓘ 气泡（票 #51） ----------
  /** #45 气泡机制的挂载点：wrap 挂设置页同款 .settings-status-info 类（其
   * :hover/:focus-within 展开规则在样式表里全局生效），图标用 settings-ui 导出的
   * infoIconSvg，气泡用 .settings-bubble——观感与设置页一致。ⓘ 与可点击控件是
   * 兄弟节点，悬浮 ⓘ 不会触发选中。 */
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
    return info;
  };

  /** 推荐行的自制下拉命令框（原生 select 放不进选项内图标）：收起态 = 按钮显示
   * 所选「参数名（标志）」+ ⓘ；展开 = 弹出列表，每项 = 命令文字 + 末尾 ⓘ（悬浮
   * 出该选项参数说明），点击项选中 = 整行替换为 rowFromKnown 结果（参数名/标志/
   * 说明/值类型/默认值整体更新，值控件随 kind 重建、值重置默认）。已被其他行占用
   * 的参数在选项中禁用（本行自身除外）。 */
  const buildKnownDropdown = (
    entry: AdvancedEntry,
    rowIndex: number,
    row: AdvancedParamRow,
    known: KnownParam,
  ): HTMLElement => {
    const knownList = knownParamsOf(entry);
    const usedFlags = new Set(
      entry.rows.filter((_, i) => i !== rowIndex).map((r) => r.flag.trim()),
    );
    const wrap = document.createElement('span');
    wrap.className = 'adv-known';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'adv-known-toggle';
    toggle.textContent = `${known.name}（${known.flag}）`;
    // 目录为空时行不会命中推荐（防御性禁用，正常到不了这里）
    toggle.disabled = knownList.length === 0;
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
        renderEntries();
      });
      option.append(optionBtn, buildInfoBubble(item.note));
      menu.append(option);
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation(); // 别让 document 的「点外部收起」把展开那一下立刻关掉
      const wasOpen = !menu.hidden;
      closeKnownMenus();
      menu.hidden = wasOpen;
    });
    wrap.append(toggle, buildInfoBubble(row.note), menu);
    return wrap;
  };

  // ---------- 条目渲染 ----------
  const renderEntries = (): void => {
    // 票 #50：「高级参数」折叠栏是无状态 <details>，整卡重建会把它打回默认闭合。
    // 重建前按序抄下各条目折叠区的开合，重建后按序回写——加参数行、行增删排序、
    // 条目增删、模式切换都汇到这一个重建出口，机制在此收口即可；条目数变化时按
    // 序号对应（错位无害）。手动开合走原生行为不经重建，不受影响。
    const prevOpen = Array.from(
      entriesBox.querySelectorAll<HTMLDetailsElement>('details.adv-advanced'),
      (d) => d.open,
    );
    entriesBox.replaceChildren();
    if (session.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint';
      empty.textContent = '还没有编码器条目，点下方「＋ 添加编码器」开始配置。';
      entriesBox.append(empty);
      return;
    }
    session.entries.forEach((entry, index) => {
      entriesBox.append(renderEntry(entry, index));
    });
    // 回写：重建后重查折叠区按序恢复；条目删多时 rebuilt 越界直接跳过
    const rebuilt = entriesBox.querySelectorAll<HTMLDetailsElement>('details.adv-advanced');
    prevOpen.forEach((open, i) => {
      const details = rebuilt[i];
      if (details) details.open = open;
    });
  };

  const renderEntry = (entry: AdvancedEntry, index: number): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'adv-entry';
    const spec = specOf(entry);
    const imageSpec = imageSpecOf(entry);

    // 行内容变化时只刷新预览与折叠栏计数，不重建（保输入焦点）
    const liveCallbacks: (() => void)[] = [];
    const onChangeLive = (): void => {
      for (const fn of liveCallbacks) fn();
    };

    // -- 头行：编码器选择 + 排序/删除 --
    const headRow = document.createElement('div');
    headRow.className = 'adv-entry-head';
    const label = document.createElement('span');
    label.className = 'adv-entry-label';
    label.textContent = `第 ${index + 1} 项`;
    const select = document.createElement('select');
    select.className = 'adv-encoder-select';
    select.title = '选择编码器（同一编码器可多次添加，各自参数独立）';
    if (kind === 'image') {
      for (const s of imageSpecs) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.displayName;
        select.append(opt);
      }
    } else if (videoCatalog) {
      const inTable = document.createElement('optgroup');
      inTable.label = '按格式（有推荐参数）';
      for (const s of videoCatalog.specs) {
        const opt = document.createElement('option');
        opt.value = s.ffmpegName;
        opt.textContent = s.displayName;
        inTable.append(opt);
      }
      select.append(inTable);
      const tableNames = new Set(videoCatalog.specs.map((s) => s.ffmpegName));
      const extras = videoCatalog.encoderNames.filter((name) => !tableNames.has(name));
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
      const nextSpec = specOf(entry);
      // 换编码器后质量按新规格夹回范围；无损能力变化由重建后的控件反映
      if (nextSpec) {
        entry.quality = Math.min(Math.max(entry.quality, nextSpec.qualityMin), nextSpec.qualityMax);
      }
      renderEntries();
    });
    const upBtn = document.createElement('button');
    upBtn.className = 'settings-mini-btn';
    upBtn.textContent = '↑';
    upBtn.title = '上移（排序影响创建顺序）';
    upBtn.addEventListener('click', () => {
      moveEntry(session, index, -1);
      renderEntries();
    });
    const downBtn = document.createElement('button');
    downBtn.className = 'settings-mini-btn';
    downBtn.textContent = '↓';
    downBtn.title = '下移';
    downBtn.addEventListener('click', () => {
      moveEntry(session, index, 1);
      renderEntries();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'settings-mini-btn';
    delBtn.textContent = '×';
    delBtn.title = '删除该编码器条目';
    delBtn.addEventListener('click', () => {
      removeEntry(session, index);
      renderEntries();
    });
    headRow.append(label, select, upBtn, downBtn, delBtn);
    card.append(headRow);

    // 编码器可执行文件不可用的红标（AC5）：点「创建」时批量检测，报错指向设置页
    const unavailable = unavailableEntries.get(entry.id);
    if (unavailable) {
      const errEl = document.createElement('p');
      errEl.className = 'settings-error adv-entry-error';
      errEl.textContent = unavailable;
      card.append(errEl);
    }

    // 命令行预览 + 复制（快速参数行的输入事件会即时刷新它）
    const previewRow = document.createElement('div');
    previewRow.className = 'adv-preview-row';
    const cmdEl = document.createElement('code');
    cmdEl.className = 'adv-cmd';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'settings-mini-btn';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制这条命令行（可直接粘贴到 shell 执行）';
    copyBtn.addEventListener('click', () => copyLine(cmdEl.textContent ?? ''));
    previewRow.append(cmdEl, copyBtn);

    liveCallbacks.push(() => {
      refreshPreview(entry, cmdEl);
      syncSummary();
    });

    // -- 快速参数行（表外视频编码器没有规格，不渲染） --
    if (spec) {
      const quickRow = document.createElement('div');
      quickRow.className = 'adv-quick-row';

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
        renderEntries();
      });
      losslessWrap.append(losslessCheck, document.createTextNode('无损'));
      quickRow.append(losslessWrap);

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
      quickRow.append(qualityWrap);

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
        renderEntries();
      });
      sizeWrap.append(document.createTextNode('目标大小'), sizeInput, unitSelect);
      quickRow.append(sizeWrap);

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
            renderEntries();
          }
        });
        modeWrap.append(btn);
      }
      quickRow.append(modeWrap);
      card.append(quickRow);
    } else {
      const offTable = document.createElement('p');
      offTable.className = 'settings-hint';
      offTable.textContent =
        '表外编码器（枚举可得但无推荐参数）：请用下方高级参数行自行配置，命令行预览自查。';
      card.append(offTable);
    }

    // -- 高级参数折叠栏（默认折叠，票面验收 3） --
    const details = document.createElement('details');
    details.className = 'adv-advanced';
    const summary = document.createElement('summary');
    const syncSummary = (): void => {
      const active = entry.rows.filter((row) => row.enabled).length;
      summary.textContent = `高级参数（${active} 项生效 / 共 ${entry.rows.length} 行）`;
    };
    syncSummary();
    details.append(summary);

    const rowsBox = document.createElement('div');
    rowsBox.className = 'adv-rows';
    entry.rows.forEach((row, rowIndex) => {
      // 票 #51：按「标志是否命中当前条目编码器的推荐目录」二分——命中走推荐行
      //（命令只能从目录里选，参数名随选择带出），未命中走自定义行（命令自由
      // 填写，参数名从标志派生）。
      const known = knownParamsOf(entry).find((k) => k.flag === row.flag.trim());
      const rowEl = document.createElement('div');
      rowEl.className = known
        ? 'adv-param-row adv-param-row-known'
        : 'adv-param-row adv-param-row-custom';

      // -- 命令框：推荐行 = 自制下拉命令框；自定义行 = 自由文本 --
      if (known) {
        rowEl.append(buildKnownDropdown(entry, rowIndex, row, known));
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

      const valueWidget = buildValueWidget(row, onChangeLive);

      const rowUp = document.createElement('button');
      rowUp.className = 'settings-mini-btn';
      rowUp.textContent = '↑';
      rowUp.title = '上移该参数行';
      rowUp.addEventListener('click', () => {
        if (rowIndex <= 0) return;
        const [moved] = entry.rows.splice(rowIndex, 1);
        entry.rows.splice(rowIndex - 1, 0, moved);
        renderEntries();
      });
      const rowDown = document.createElement('button');
      rowDown.className = 'settings-mini-btn';
      rowDown.textContent = '↓';
      rowDown.title = '下移该参数行';
      rowDown.addEventListener('click', () => {
        if (rowIndex >= entry.rows.length - 1) return;
        const [moved] = entry.rows.splice(rowIndex, 1);
        entry.rows.splice(rowIndex + 1, 0, moved);
        renderEntries();
      });
      const rowDel = document.createElement('button');
      rowDel.className = 'settings-mini-btn';
      rowDel.textContent = '×';
      rowDel.title = '删除该参数行';
      rowDel.addEventListener('click', () => {
        entry.rows.splice(rowIndex, 1);
        renderEntries();
      });

      rowEl.append(valueWidget, rowUp, rowDown, rowDel);
      rowsBox.append(rowEl);
    });
    details.append(rowsBox);

    // 添加参数行：编码器推荐参数（下拉）+ 自定义（布尔/数值/下拉能力来自推荐项）
    const addRow = document.createElement('div');
    addRow.className = 'adv-add-row';
    const knownList = knownParamsOf(entry);
    const usedFlags = new Set(entry.rows.map((row) => row.flag.trim()));
    const available = knownList.filter((known) => !usedFlags.has(known.flag));
    const knownSelect = document.createElement('select');
    knownSelect.className = 'adv-known-select';
    // 票 #51：旧提示「悬浮参数行可见」随行内说明输入框退场而过时，改为中性指引
    knownSelect.title = '从该编码器的推荐目录中选择要添加的参数';
    for (const known of available) {
      const opt = document.createElement('option');
      opt.value = known.flag;
      opt.textContent = `${known.name}（${known.flag}）`;
      knownSelect.append(opt);
    }
    knownSelect.disabled = available.length === 0;
    const addKnownBtn = document.createElement('button');
    addKnownBtn.className = 'settings-mini-btn';
    addKnownBtn.textContent = '添加推荐参数';
    addKnownBtn.disabled = available.length === 0;
    addKnownBtn.addEventListener('click', () => {
      const known = knownList.find((k) => k.flag === knownSelect.value);
      if (!known) return;
      entry.rows.push(rowFromKnown(known));
      renderEntries();
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
      renderEntries();
    });
    addRow.append(knownSelect, addKnownBtn, addCustomBtn);
    details.append(addRow);
    card.append(details);

    card.append(previewRow);
    refreshPreview(entry, cmdEl);
    return card;
  };

  // ---------- 添加条目（同一编码器可多次） ----------
  const addEncoderEntry = (): void => {
    if (kind === 'image') {
      const first = imageSpecs[0];
      if (!first) return;
      addEntry(session, first.id, first);
    } else if (videoCatalog) {
      const first = videoCatalog.specs[0];
      if (!first) return;
      addEntry(session, first.ffmpegName, first);
    } else {
      // 目录拉取失败：退而求其次加一条表外条目（只支持参数行）
      addEntry(session, 'libx264', {
        displayName: 'libx264',
        baseArgs: [],
        losslessSupported: false,
        losslessNote: '编码器目录不可用',
        losslessArgs: [],
        qualityFlag: '-crf',
        qualityMin: 0,
        qualityMax: 51,
      });
    }
    renderEntries();
  };
  addFirstBtn.addEventListener('click', addEncoderEntry);

  // ---------- 校验与创建（票面验收 5：汇总报错，坏参数不建轮） ----------
  const validateAll = (): string[] => {
    const errors: string[] = [];
    if (kind === 'image' && !session.referencePath) {
      errors.push('请先选择原图（产物从它生成）');
    }
    if (session.entries.length === 0) {
      errors.push('请至少添加一个编码器条目');
    }
    session.entries.forEach((entry, index) => {
      for (const message of validateEntry(specOf(entry), entry)) {
        errors.push(`第 ${index + 1} 项（${entryLabel(entry)}）：${message}`);
      }
    });
    return errors;
  };

  /** 视频高级创建的轮备注（配置落地，随轮持久化不白丢）：编码器 + 参数摘要 +
   * 命令行。参数摘要用宽松合并（与预览同口径，参数行没填完也不打断创建，
   * 错误已被 validateAll 前置拦下）。 */
  const buildVideoNote = (): string => {
    const lines: string[] = [
      '高级创建配置（视频自动编码链路将在后续版本提供；可复制命令行自行编码后用「添加跑分视频」导入）：',
    ];
    session.entries.forEach((entry, index) => {
      const spec = videoSpecOf(entry);
      const args = buildEntryArgsLenient(spec, entry);
      lines.push(`${index + 1}. ${entryLabel(entry)}：${args.length > 0 ? args.join(' ') : '（无参数）'}`);
      lines.push(`   命令行：${previewVideoCommand(spec, entry, session.referencePath)}`);
    });
    return lines.join('\n');
  };

  /** 已创建的轮（全部失败重试时复用，避免重复建轮）。 */
  let created: { groupId: string; roundId: string } | null = null;

  createBtn.addEventListener('click', () => {
    void (async () => {
      if (deps.isBusy()) return;
      const errors = validateAll();
      if (errors.length > 0) {
        errorLine.textContent = errors.join('；');
        errorLine.title = errors.join('\n');
        return;
      }
      errorLine.textContent = '';
      createBtn.disabled = true;
      addFirstBtn.disabled = true;
      try {
        // AC5：建轮前批量校验条目编码器的可执行文件是否可用（含设置页外部路径
        // 覆盖）。unavailable / unconfigured = 明确报错（条目红标 + 汇总提示去
        // 设置页，T32 起内置缺失不再自动下载）；ffmpeg 的 unconfigured 放行
        //（就位方式是设置页「应用内下载」，跑分时报错另有指引）。
        const keys = [
          ...new Set(session.entries.map(toolKeyOf).filter((key): key is string => key !== null)),
        ];
        let statuses: ToolStatusLite[];
        try {
          statuses = await invoke<ToolStatusLite[]>('advanced_encoder_status', { keys });
        } catch (err) {
          errorLine.textContent = `编码器可用性检测失败: ${String(err)}`;
          errorLine.title = errorLine.textContent;
          createBtn.disabled = false;
          addFirstBtn.disabled = false;
          return;
        }
        unavailableEntries.clear();
        const avail = availabilityErrors(session.entries, toolKeyOf, statuses);
        if (avail.size > 0) {
          const summaries: string[] = [];
          session.entries.forEach((entry, index) => {
            const message = avail.get(entry.id);
            if (message === undefined) return;
            unavailableEntries.set(entry.id, message);
            summaries.push(`第 ${index + 1} 项（${entryLabel(entry)}）：${message}`);
          });
          renderEntries();
          errorLine.textContent = summaries.join('；');
          errorLine.title = summaries.join('\n');
          createBtn.disabled = false;
          addFirstBtn.disabled = false;
          return;
        }
        if (!created) {
          created = await deps.createRound();
          if (kind === 'image') {
            await deps.setReference(created.groupId, created.roundId, session.referencePath!);
          }
        }
        const failures: string[] = [];
        const products: AdvancedProductDto[] = [];
        const total = session.entries.length;
        // T30：一次批量创建一个冲突决策会话——「应用到本次全部冲突」只作用于本批
        const conflicts = new ConflictSession((fileName) => deps.askConflict(fileName));
        for (const [index, entry] of session.entries.entries()) {
          deps.setStatus(`正在生成 第 ${index + 1}/${total} 项（${entryLabel(entry)}）…`);
          try {
            products.push(
              await deps.encode(
                created.groupId,
                created.roundId,
                session.referencePath ?? '',
                entry,
                conflicts,
              ),
            );
          } catch (err) {
            failures.push(`${entryLabel(entry)}: ${String(err)}`);
          }
        }
        if (products.length > 0) {
          await deps.addCandidates(
            created.groupId,
            created.roundId,
            products.map((p) => p.path),
            products.map((p) => p.encodingParams),
          );
          for (const product of products) {
            if (product.note) {
              await deps.setNote(created.groupId, created.roundId, product.path, product.note);
            }
          }
        }
        if (kind === 'video') {
          // 配置落地（本版本不自动编码）：编码器 + 参数摘要 + 命令行写进轮备注
          await deps.setRoundNote(created.groupId, created.roundId, buildVideoNote());
          dropSession(groupId);
          close();
          deps.setStatus(
            `评测轮已创建（共 ${total} 项配置）。视频自动编码链路将在后续版本提供；` +
              '产物可复制命令行自行编码后用「添加跑分视频」导入。',
          );
          deps.rerender();
          return;
        }
        if (products.length === 0) {
          // 全部失败：轮与原图已就位，保留面板让用户改参数后重试（复用已建的轮）
          errorLine.textContent = `全部生成失败（评测轮已创建，可修改后重试）：${failures.join('；')}`;
          errorLine.title = errorLine.textContent;
          createBtn.disabled = false;
          addFirstBtn.disabled = false;
          return;
        }
        const generated = products.length;
        dropSession(groupId);
        close();
        deps.setStatus(`已生成 ${generated}/${total} 项产物，开始跑分…`);
        deps.rerender();
        await deps.scoreRound();
        if (failures.length > 0) {
          deps.setStatus(`跑分完成；生成失败的项：${failures.join('；')}`, true);
        }
      } catch (err) {
        errorLine.textContent = `创建失败: ${String(err)}`;
        errorLine.title = String(err);
        createBtn.disabled = false;
        addFirstBtn.disabled = false;
      }
    })();
  });

  document.body.append(overlay);
  renderEntries();
  // 会话里一条条目都没有时，自动铺一条默认编码器，减少一次点击
  if (session.entries.length === 0) {
    addEncoderEntry();
  }
}

/** 隐藏文本域复制兜底（clipboard API 不可用时）。 */
function fallbackCopy(text: string, done: () => void): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    done();
  } finally {
    textarea.remove();
  }
}
