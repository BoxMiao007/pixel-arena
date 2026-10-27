// 高级创建面板（T29-3）：视频跑分组的「新建评测轮 → 高级创建」覆盖层面板。
//
// 票 T6 / 父规格 #74：图片的高级创建已改为条目列表面板（src/image-queue-panel.ts）
// ＋逐图编辑弹窗（src/image-entry-editor.ts），图片侧只应剩一套界面。因此本模块
// 收缩为**视频专用**：图片分支（原图选择、图片编码器目录、产物生成与入轮跑分）
// 整块删除，图片组在分派处直接走列表面板、进不到这里；万一被误调，
// openAdvancedPanel 开头的防御性断言会立即抛错（不留「两套界面都能配图片参数」）。
//
// 视频侧保持原样（决策 D19/D20）：编码器按格式拆四条静态规格 + ffmpeg -encoders
// 动态枚举（表外可选、无推荐值）；会话态（src/advanced.ts 的 sessionFor）按跑分组
// 存内存，重启归零；只做选择/参数/命令行预览与建轮——本版本不做视频自动编码，
// 确认后新建评测轮并把配置摘要与命令行写进轮备注，产物可复制命令行自行编码后用
// 「添加跑分视频」导入（视频自动编码链路属第二版视频一站式，Out of Scope）。
//
// 校验（票面验收 5）：必填缺失 / 范围 / 同标志冲突在建轮前汇总报出，坏参数不建轮。
// 参数合并、冲突校验、命令行预览、可用性校验的纯逻辑在 src/advanced.ts；单张卡的
// DOM 在 src/encoder-card.ts（与图片编辑弹窗共用同一张卡，避免两份并行演进）。
//
// 视觉复用设置面板的 overlay/panel 样式（settings-*），本模块只补高级特有布局。

import { invoke } from '@tauri-apps/api/core';
import { copyText } from './util';
import {
  closeEncoderMenus,
  encoderLabel,
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
  type ToolStatusLite,
} from './advanced';

/** 后端 advanced_encode 回传（camelCase，与核心库 AdvancedProduct 一致）。
 * 视频面板不再调用编码；这两个类型保留给图片条目队列（src/image-queue-panel.ts）
 * 的编码接线复用，避免同一份后端契约在仓库里出现第二份定义。 */
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

/** 面板对宿主（main.ts）的依赖：视频高级创建的全部接线点。
 * kind 收紧成字面量 'video'——图片组在编译期就递不进来，运行期另有断言兜底。 */
export interface AdvancedDeps {
  kind: 'video';
  /** 打开面板时的预填原视频：当前评测轮已选原视频时直接沿用（命令行预览用）。 */
  initialReference(): string | null;
  /** 跑分忙标志（忙时按钮置灰的语义与主界面一致）。 */
  isBusy(): boolean;
  setStatus(text: string, isError?: boolean, title?: string): void;
  /** 新建并激活一轮评测（返回组 id 与新轮 id；命名沿用「评测轮 N」）。 */
  createRound(): Promise<{ groupId: string; roundId: string }>;
  /** 轮级备注（视频高级创建确认后把配置摘要与命令行写进新轮，随轮持久化）。 */
  setRoundNote(groupId: string, roundId: string, note: string): Promise<void>;
  /** 创建完成后的整页重渲染（新轮出现在评测轮栏）。 */
  rerender(): void;
}

/**
 * 打开高级创建面板（覆盖层挂 body，关闭即销毁；配置留在会话态）。
 * groupId = 当前跑分组 id（会话态按组键控）。本面板只服务视频跑分组。
 */
export async function openAdvancedPanel(groupId: string, deps: AdvancedDeps): Promise<void> {
  // 防御性断言（票 T6）：旧面板已收缩为视频专用。TS 的类型收窄只在编译期生效，
  // 这里运行期再挡一道——图片组必须走条目列表面板，不能从这里半条路进旧界面。
  if (String(deps.kind) !== 'video') {
    throw new Error('高级创建面板仅供视频跑分组使用：图片组请走条目列表面板（高级创建）');
  }

  const session = sessionFor(groupId, 'video');
  // 预填原视频：当前评测轮已选原视频时直接沿用（命令行预览的输入路径）
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
  title.textContent = '高级新建评测轮（视频）';
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
    '选择视频编码器（按格式拆分 + ffmpeg 实际枚举）并配置参数、预览命令行。本版本只做' +
    '创建流程与能力定义：确认后新建评测轮并把配置与命令行写进轮备注，视频自动编码链路' +
    '将在后续版本提供；产物可复制命令行自行编码后用「添加跑分视频」导入。';
  panel.append(hint);

  // ---------- 目录拉取（视频规格 + ffmpeg 枚举） ----------
  let videoCatalog: AdvancedVideoCatalog | null = null;
  let catalogError: string | null = null;

  const ffmpegStatus = document.createElement('p');
  ffmpegStatus.className = 'settings-hint adv-ffmpeg-status';

  try {
    videoCatalog = await invoke<AdvancedVideoCatalog>('advanced_video_catalog');
    ffmpegStatus.textContent = videoCatalog.ffmpegAvailable
      ? `ffmpeg 就绪：${videoCatalog.ffmpegPath}`
      : `ffmpeg 不可用（${videoCatalog.ffmpegError ?? '未知原因'}）。可在设置页配置路径；编码器仍可选择并预览。`;
    panel.append(ffmpegStatus);
  } catch (err) {
    catalogError = String(err);
  }

  // 共享渲染的编码器目录（传给每张卡，卡片不自己拉目录）。图片规格表按「视频组不用」
  // 传空数组：卡片实现保持通用，本面板只喂视频目录。
  const catalog: EncoderCardCatalog = { kind: 'video', imageSpecs: [], videoCatalog };

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
  createBtn.textContent = '创建评测轮';
  const addFirstBtn = document.createElement('button');
  addFirstBtn.className = 'settings-mini-btn';
  addFirstBtn.textContent = '＋ 添加编码器';
  addFirstBtn.title = '把一个编码器加入本次高级创建（同一编码器可添加多次）';
  actions.append(addFirstBtn, createBtn);
  panel.append(actions);

  /** 条目对应的工具键（可用性校验用）：视频统一 ffmpeg。表外编码器（找不到规格
   * 映射）没有独立可执行文件，但 ffmpeg 仍是它真正的依赖，所以一律返回 'ffmpeg'。 */
  const toolKeyOf = (_entry: AdvancedEntry): string | null => 'ffmpeg';
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
    if (videoCatalog) {
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

  /** 已创建的轮（建轮成功但写备注失败时复用，避免重复建轮留下空轮）。 */
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
        }
        const total = session.entries.length;
        // 配置落地（本版本不自动编码）：编码器 + 参数摘要 + 命令行写进轮备注
        await deps.setRoundNote(created.groupId, created.roundId, buildVideoNote());
        dropSession(groupId);
        close();
        deps.setStatus(
          `评测轮已创建（共 ${total} 项配置）。视频自动编码链路将在后续版本提供；` +
            '产物可复制命令行自行编码后用「添加跑分视频」导入。',
        );
        deps.rerender();
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
