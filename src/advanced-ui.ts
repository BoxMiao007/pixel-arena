// 高级创建面板（T29-3）：「新建评测轮 → 高级」打开的覆盖层面板，决策 D19/D20：
// - 高级创建 = 多编码器条目（同一编码器可多次）+ 每条目独立快速参数（质量滑块 /
//   目标大小 / 无损开关按能力禁用）+ 高级参数折叠栏（参数行增删排序，
//   支持布尔开关/下拉/数值/自由文本）+ 每条目命令行预览（可复制）；
// - 会话态（src/advanced.ts 的 sessionFor，D19）：配置不持久化，重启归零；产物与
//   encodingParams 由创建流程经 round_add_candidates 随评测轮持久化；
// - 视频跑分组同样可开高级创建（D20）：编码器按格式拆四条静态规格 + ffmpeg
//   -encoders 动态枚举（表外可选、无推荐值）；T29-3 只做选择/参数/预览与建轮，
//   视频自动编码链路属第二版视频一站式（Out of Scope）；
// - 校验（票面验收 5）：必填缺失 / 范围 / 同标志冲突在建轮前汇总报出，坏参数
//   不联网不建轮。
//
// 票 #75：单张编码器卡的 DOM（卡头 / 快速参数两列网格 / 高级参数行子区 / 默认
// 收起的命令行预览）抽到 src/encoder-card.ts 共享渲染；本文件只保留「面板级」
// 的东西——原图选择、卡片列表容器与整卡重建出口、校验与创建流程。这样图片侧
// 编辑弹窗（后续票）可以直接复用同一张卡，不会出现两份并行演进的卡片实现。
//
// 视觉复用设置面板的 overlay/panel 样式（settings-*），本模块只补高级特有布局。

import { invoke } from '@tauri-apps/api/core';
import { ConflictSession, type ConflictAnswer } from './conflict';
import { copyText } from './util';
import {
  closeEncoderMenus,
  encoderLabel,
  imageSpecOf,
  renderEncoderCard,
  specOf,
  videoSpecOf,
  type EncoderCardCatalog,
} from './encoder-card';
import {
  addEntry,
  availabilityErrors,
  buildEntryArgsLenient,
  moveEntry,
  previewVideoCommand,
  removeEntry,
  sessionFor,
  validateEntry,
  dropSession,
  type AdvancedEntry,
  type AdvancedVideoCatalog,
  type ImageSpec,
  type ToolStatusLite,
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

  // 推荐行下拉的共享收起出口（票 #51）：同一时间至多一个展开（与顶栏菜单同约定）。
  // 本监听挂在 document 上，任何未被拦下的点击（面板内除 toggle 外一律、面板外）
  // 都会收起下拉——含点质量滑杆/值控件这类面板内操作，属标准下拉行为；面板关闭时
  // 摘掉监听。toggle 自身 stopPropagation，展开那一下不会被本监听立刻收掉。
  const closeKnownMenus = (): void => closeEncoderMenus(entriesBox);
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

  // 共享渲染的编码器目录（传给每张卡，卡片不自己拉目录）
  const catalog: EncoderCardCatalog = { kind, imageSpecs, videoCatalog };

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
        // 原图变化会改命令行预览里的输入路径：整卡重建即可（成本低、无输入焦点）
        renderEntries();
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

  /** 条目对应的工具键（可用性校验用）：图片 = 编码器键（cjpeg 等）；视频统一 ffmpeg。
   * 表外条目（找不到规格映射）返回 null，跳过可执行文件校验。 */
  const toolKeyOf = (entry: AdvancedEntry): string | null => {
    if (kind === 'image') {
      return imageSpecOf(catalog, entry)?.toolKey ?? null;
    }
    return 'ffmpeg';
  };
  const entryLabel = (entry: AdvancedEntry): string => encoderLabel(catalog, entry);

  // 编码器可执行文件不可用的条目（AC5）：entryId → 错误文本，条目卡片红标展示，
  // 点「创建」重新校验通过后清空
  const unavailableEntries = new Map<string, string>();

  const copyLine = (text: string): void => {
    // 票 #58：复制出口提取为 util.copyText 共享（状态栏错误卡片同用）
    copyText(text, () => deps.setStatus('已复制命令行'));
  };

  // ---------- 条目渲染（整卡重建出口，卡片本身由 encoder-card 共享渲染） ----------
  const renderEntries = (): void => {
    // 票 #50：「高级参数」折叠栏是无状态 <details>，整卡重建会把它打回默认展开。
    // 加参数行、行增删排序、条目增删、模式切换都汇到这一个重建出口，机制在此收口
    // 即可。code-review 修复（#50）：开合状态按条目 id 键控而非按序对应——删除非
    // 末位条目时其余条目序号前移，按序回写会把开合错配给相邻条目（如删掉展开的
    // 条目1，原本展开的条目2 落到收起位）；entry.id 会话内唯一且不复用（newEntryId
    // 递增），按 id 对应才谈得上「折叠区保持原状」。手动开合走原生行为不经重建，
    // 不受影响。票 #75 起命令行预览也是一个默认收起的 <details>，同一套读-回写
    // 机制按 data-adv-region 区分，两类折叠态都跨重建保留。
    const prevOpen = new Map<string, Map<string, boolean>>();
    for (const card of entriesBox.querySelectorAll<HTMLElement>('.adv-entry')) {
      const id: string | undefined = card.dataset.entryId;
      if (id === undefined) continue;
      const openByRegion = new Map<string, boolean>();
      for (const details of card.querySelectorAll<HTMLDetailsElement>('details[data-adv-region]')) {
        openByRegion.set(details.dataset.advRegion ?? '', details.open);
      }
      prevOpen.set(id, openByRegion);
    }
    entriesBox.replaceChildren();
    if (session.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint';
      empty.textContent = '还没有编码器条目，点下方「＋ 添加编码器」开始配置。';
      entriesBox.append(empty);
      return;
    }
    session.entries.forEach((entry, index) => {
      entriesBox.append(
        renderEncoderCard(entry, index, catalog, {
          onChange: () => renderEntries(),
          onMove: (delta) => {
            moveEntry(session, index, delta);
            renderEntries();
          },
          onRemove: () => {
            removeEntry(session, index);
            renderEntries();
          },
          onReset: () => renderEntries(),
          onCopy: copyLine,
        }, {
          referencePath: session.referencePath,
          unavailableError: unavailableEntries.get(entry.id) ?? null,
          menuRoot: entriesBox,
        }),
      );
    });
    // 回写：重建后按卡片 dataset 里的条目 id 查回折叠态；新加条目查不到，保持默认
    // （高级参数子区展开、命令行预览收起）
    for (const card of entriesBox.querySelectorAll<HTMLElement>('.adv-entry')) {
      const openByRegion = prevOpen.get(card.dataset.entryId ?? '');
      if (!openByRegion) continue;
      for (const details of card.querySelectorAll<HTMLDetailsElement>('details[data-adv-region]')) {
        const open = openByRegion.get(details.dataset.advRegion ?? '');
        if (open !== undefined) details.open = open;
      }
    }
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
      for (const message of validateEntry(specOf(catalog, entry), entry)) {
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
      const spec = videoSpecOf(catalog, entry);
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
