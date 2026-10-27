// 图片条目列表面板（票 #77 / T3，票 #79 / T5 起为增量跑分）：
// 图片跑分组的「高级创建」入口从旧向导换成条目队列。
//
// 交互骨架（父规格 #74「交互与编排」）：
// - 顶部「添加图片」多选后**直接入列，不弹任何窗**；
// - 中部每行 = 中间截断文件名 + 状态徽章 + 删除按钮（同一路径重复添加给「重复图片」提示）；
// - 底部「跑分 / 重跑」只跑计划内的编码器条目（T5）：已跑分且无变更的图整张跳过、
//   沿用上一轮产物与指标；无待跑条目时只弹提示卡片、零编码零跑分调用；
// - 跑完弹应用内汇总卡片（本次跑分 N 张，跳过 M 张 + 逐张跳过原因），**面板不关闭**；
// - 删除条目前弹应用内模态卡片二次确认（点名轮名与结果条数、写明磁盘产物不删），
//   有轮则连带删轮。
//
// 三条数据边界：
// 1. **只改会话态**：条目队列活在 src/image-queue.ts 的模块级 Map 里（T2 交付），本面板
//    只读它、经 T2 的纯函数改它；只有点「跑分」才经 deps 真正写工作区。关掉面板没跑过 =
//    工作区零变更。
// 2. **惰性建轮**：条目第一次真正产出产物时才建评测轮（编排层只在 entry.roundId === null
//    时调 createRound），仅添加图片不建轮；本次新建的轮若一条产物都没产出就回滚删掉。
// 3. **增量判定单一来源**：跑哪些卡、跳过哪些图全走 T2 的 planScore；本面板不另造脏判定。
//
// 本文件分工：上半是面板对宿主/后端的薄契约与标识回包适配（node 可测），下半是 DOM 渲染
// 与转发（仓库约定不引 jsdom，DOM 侧只做机制守卫）。跑分编排决策与执行在
// src/image-queue-run.ts（纯逻辑 + 注入执行器，node 环境真跑）。

import { askFileConflict, type ConflictSession } from './conflict';
import {
  addImagePaths,
  badgeText,
  duplicateEntryIds,
  entryFailures,
  imageIdentityFrom,
  imageQueueFor,
  judgeEntries,
  planScore,
  probeFromCache,
  removeImageEntry,
  type EncoderCard,
  type ImageEntry,
  type ImageIdentityReading,
  type RoundSummary,
} from './image-queue';
import {
  nothingToRunNotice,
  runScorePlan,
  scoreButtonLabel,
  summaryLines,
  type QueueRunExecutor,
  type ScoredCandidate,
} from './image-queue-run';
import type { ImageSpec } from './advanced';
import type { AdvancedProductDto } from './advanced-ui';
import { openImageEntryEditor } from './image-entry-editor';
import { fileName, truncateFileName } from './util';
import { openModalCard } from './modal-card';

export type { ScoredCandidate } from './image-queue-run';

// ---------- 与后端的薄契约 ----------

/**
 * image_identities IPC 回包的一行（camelCase，与 src-tauri 的 ImageIdentityDto 一一对应）：
 * 读不到文件时 sizeBytes / modifiedMs 为 null、error 给出中文原因，前端据此走
 * 「读取失败 → 保守判已变更」的既有分支（T2 的 ImageIdentityReading）。
 */
export interface ImageIdentityDto {
  path: string;
  sizeBytes: number | null;
  modifiedMs: number | null;
  error: string | null;
}

/**
 * 面板对宿主（main.ts）的依赖：文件对话框、原图标识读取、工作区写入与主界面刷新。
 * 面板自己不 import invoke——IPC 全部经这里注入，与 advanced-ui.ts 的 deps 同一路数。
 */
export interface ImageQueueDeps {
  /** 系统多选对话框选图片；取消返回空数组。 */
  pickImages(): Promise<string[]>;
  /** 异步批量读原图标识（IPC image_identities；读不到的行带 error）。 */
  probeIdentities(paths: string[]): Promise<ImageIdentityDto[]>;
  /** 惰性建轮 + 激活：宿主按「现有轮数 + 1」与图片文件名生成轮名（roundName）。 */
  createRound(groupId: string, sourcePath: string): Promise<{ groupId: string; roundId: string }>;
  setReference(groupId: string, roundId: string, path: string): Promise<void>;
  /** 单个编码任务（advanced_encode；参数合并 / 冲突协议与高级创建面板同一实现）。 */
  encode(
    groupId: string,
    roundId: string,
    referencePath: string,
    card: EncoderCard,
    conflicts: ConflictSession,
  ): Promise<AdvancedProductDto>;
  /** 产物带 encodingParams 纳入本轮。 */
  addCandidates(groupId: string, roundId: string, paths: string[], params: string[]): Promise<void>;
  /** 清空某轮跑分图行（换图前清旧行；原图与轮保留，磁盘产物文件不删）。 */
  clearCandidates(groupId: string, roundId: string): Promise<void>;
  /** 删除评测轮（删条目时连带删除）。 */
  deleteRound(groupId: string, roundId: string): Promise<void>;
  /**
   * 只跑指定路径的跑分图（T5 增量：paths = 本次新增产物），返回逐行结果供失败判定。
   * 未列入的跑分图行由后端保持逐 bit 不变。
   */
  scoreRound(groupId: string, roundId: string, paths: string[]): Promise<ScoredCandidate[]>;
  /** 跑分期间与主界面一致地置灰（主界面的 scoring 忙标志由宿主维护）。 */
  withBusy<T>(task: () => Promise<T>): Promise<T>;
  /** 主界面忙标志（忙时面板不再发起新的跑分）。 */
  isBusy(): boolean;
  /** 当前工作区里某轮的名字与结果条数；轮已不在工作区时返回 null。 */
  describeRound(groupId: string, roundId: string): RoundSummary | null;
  /** 逐图编辑弹窗（T4）：拉图片编码器目录（advanced_image_catalog）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  /** 逐图编辑弹窗（T4）：系统单选对话框选一张新图片（换图）；取消返回 null。 */
  pickReplacementImage(): Promise<string | null>;
  /** 新建了评测轮之后刷新主界面（轮次栏与标签页）。 */
  rerender(): void;
  setStatus(text: string, isError?: boolean, title?: string): void;
}

// ---------- 标识回包适配（纯函数，node 环境可测） ----------

/**
 * 把 image_identities 的回包折成 T2 的「标识读取」缓存（喂 probeFromCache）。
 *
 * 有 error 的行原样透传后端原因；没有 error 的行走 imageIdentityFrom 的口径校验
 * （字段缺失或不是有限数一律算读取失败 → 判定保守重跑，绝不误跳过）。
 */
export function identityReadingsOf(dtos: ImageIdentityDto[]): Map<string, ImageIdentityReading> {
  const readings = new Map<string, ImageIdentityReading>();
  for (const dto of dtos) {
    if (dto.error !== null && dto.error !== undefined) {
      readings.set(dto.path, { kind: 'failed', path: dto.path, reason: dto.error });
      continue;
    }
    readings.set(
      dto.path,
      imageIdentityFrom(dto.path, {
        sizeBytes: dto.sizeBytes ?? undefined,
        modifiedMs: dto.modifiedMs ?? undefined,
      }),
    );
  }
  return readings;
}

// ---------- 删条目的计划（纯函数） ----------

/** 删条目的计划：要不要连带删轮 + 二次确认文案。 */
export interface DeletePlan {
  entryId: string;
  /** 条目文件名（确认文案与状态栏用）。 */
  fileName: string;
  /** 要连带删除的评测轮 id；null = 不动工作区（从没建过轮，或轮已不在工作区）。 */
  roundId: string | null;
  /** 应用内模态卡片的正文（点名轮名与结果条数，写明磁盘产物不删）。 */
  message: string;
}

/**
 * 算删一个条目的计划。
 *
 * 轮信息由宿主从工作区读（`deps.describeRound`）：roundId 指向的轮若已经不在工作区
 * （用户在主界面删过），就不拿旧 id 去删——否则会得到一个「找不到评测轮」的错误，
 * 而条目其实已经只存在于会话里了。
 */
export function planDelete(entry: ImageEntry, round: RoundSummary | null): DeletePlan {
  const name = fileName(entry.path);
  const roundId = entry.roundId !== null && round !== null ? entry.roundId : null;
  const message =
    roundId !== null && round !== null
      ? `确定删除图片条目「${name}」吗？\n\n` +
        `评测轮『${round.name}』与它的 ${round.candidateCount} 条跑分结果将一并删除；` +
        `磁盘上的产物文件不会被删除（删除只作用于评测记录，不会删除磁盘文件）。`
      : `确定删除图片条目「${name}」吗？\n\n` +
        `这个条目没有对应的评测轮（从未跑分，或轮已被删除），删除不会改动工作区；` +
        `磁盘上的产物文件不会被删除（删除只作用于会话记录，不会删除磁盘文件）。`;
  return { entryId: entry.id, fileName: name, roundId, message };
}

// ---------- 面板 DOM ----------

/** 标识缓存（模块级：标识是文件元数据，跨面板开关与跑分组共用一份，读新即可）。 */
const identityCache = new Map<string, ImageIdentityReading>();

/**
 * 删除确认卡片：返回 true = 用户点了「删除」，false = × / 点遮罩 / Esc / 「取消」。
 * 脚手架（遮罩 / 标题 / × / 正文 <pre> / 底部按钮 / 三路关闭 + 监听清理）走共享实现
 * src/modal-card.ts，与 main.ts 的状态全文卡片同一份。
 */
interface ConfirmCardOptions {
  title: string;
  message: string;
}

function confirmCard(options: ConfirmCardOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // 只有点「删除」才置 true；其余关闭路径（含 × / 遮罩 / Esc）保持 false
    let confirmed = false;
    openModalCard({
      title: options.title,
      lines: [options.message],
      cardClassName: 'queue-confirm-card',
      actions: [
        {
          label: '取消',
          onClick: () => {
            confirmed = false;
          },
        },
        {
          label: '删除',
          className: 'settings-primary-btn',
          onClick: () => {
            confirmed = true;
          },
        },
      ],
      // 卡片关闭（三路之一）之后再交答案：按钮回调一定先于关闭执行
      onClose: () => resolve(confirmed),
    });
  });
}

/** 提示 / 汇总卡片选项。 */
export interface QueueNoticeOptions {
  /** 卡片标题（如「无需重跑」「跑分汇总」）。 */
  title: string;
}

/**
 * 应用内提示 / 汇总卡片（票 #79）：结构走共享实现 src/modal-card.ts
 * （`settings-overlay` 遮罩 + `.status-card` + × / 点遮罩 / Esc 三路关闭，
 * 关闭时先摘 document 上的 keydown 监听再移除遮罩）。
 *
 * 汇总卡片正文 = 本次跑分 N 张，跳过 M 张 + 逐张跳过原因；无待跑提示 = 提示文案
 * （可能带逐张点名）+ 跳过原因行。
 */
export function showQueueNotice(lines: string[], options: QueueNoticeOptions): void {
  openModalCard({
    title: options.title,
    lines,
    cardClassName: 'queue-notice-card',
    actions: [{ label: '知道了', className: 'settings-primary-btn' }],
  });
}

/**
 * 打开图片条目列表面板（覆盖层挂 body，关闭即销毁；条目队列留在会话态）。
 *
 * groupId = 当前跑分组 id（会话态按组键控）；deps 提供文件对话框、标识读取与全部
 * 工作区写入。面板本体不关闭地跑完一轮并把状态原地刷新（票面验收）。
 */
export function openImageQueuePanel(groupId: string, deps: ImageQueueDeps): void {
  const session = imageQueueFor(groupId);
  /** 面板自己的跑分进行中标志（按钮置灰；宿主的 scoring 忙标志由 withBusy 维护）。 */
  let running = false;
  /** 同一时间只开一个逐图编辑弹窗（弹窗关闭时 resolve，列表原地刷新）。 */
  let editorOpen = false;

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay queue-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel queue-panel';
  overlay.append(panel);
  const close = (): void => {
    overlay.remove();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // ---------- 头部 ----------
  const head = document.createElement('div');
  head.className = 'settings-head';
  const title = document.createElement('h2');
  title.textContent = '图片条目';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭面板（跑分前的改动只在本次运行内保留，不会写工作区）';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);
  panel.append(head);

  const hint = document.createElement('p');
  hint.className = 'settings-hint';
  hint.textContent =
    '添加图片即入列、不弹窗；每行是「一张原图 + 一套编码器配置」，对应一个评测轮。' +
    '点「跑分 / 重跑」只跑改过的：已跑分且无变更的图会跳过并沿用上一轮结果——' +
    '没跑过的图不会留下空轮，关掉面板等于工作区零变更。';
  panel.append(hint);

  // ---------- 顶部：添加图片 ----------
  const actionsTop = document.createElement('div');
  actionsTop.className = 'settings-actions queue-actions-top';
  const addBtn = document.createElement('button');
  addBtn.className = 'settings-primary-btn';
  addBtn.textContent = '＋ 添加图片';
  addBtn.title = '多选图片直接加入列表（不弹编辑窗；同一张图可以添加多次）';
  const addHint = document.createElement('span');
  addHint.className = 'muted queue-add-hint';
  addHint.textContent = '新加入的条目自带一条 JPEG 有损配置，添加完可直接跑分';
  actionsTop.append(addBtn, addHint);
  panel.append(actionsTop);

  // ---------- 中部：条目列表 ----------
  const listBox = document.createElement('div');
  listBox.className = 'queue-list';
  panel.append(listBox);

  // ---------- 底部：跑分 ----------
  const actions = document.createElement('div');
  actions.className = 'settings-actions queue-actions';
  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'settings-primary-btn queue-score-btn';
  scoreBtn.title = '只跑改过的编码器条目：已跑分且无变更的图跳过并沿用上一轮结果';
  actions.append(scoreBtn);
  panel.append(actions);

  /** 当前计划（按钮待跑张数与列表徽章同一判定口径）。 */
  const currentPlan = () => planScore(session.entries, probeFromCache(identityCache));

  /** 按钮与标题随会话态同步（不重建 DOM，避免清掉焦点）。 */
  const syncChrome = (): void => {
    const count = session.entries.length;
    title.textContent = `图片条目（${count} 张）`;
    addBtn.disabled = running || deps.isBusy();
    // 跑分按钮文字 = 本次待跑张数（plan.runImageCount）；编辑弹窗里的改动经
    // onChanged → renderList → 这里即时重算（票面：改参数后待跑数量同步变化）
    scoreBtn.textContent = running ? '跑分中…' : scoreButtonLabel(currentPlan(), session.entries);
    // 注意：计划为空时按钮仍可点——点开只弹「无需重跑」提示卡片（票面验收）
    scoreBtn.disabled = running || deps.isBusy() || count === 0;
  };

  /** 读一次全部条目的原图标识（新增/跑分前都读新；失败只警告，不影响判定保守重跑）。 */
  const refreshIdentities = async (): Promise<void> => {
    const paths = [...new Set(session.entries.map((entry) => entry.path))];
    if (paths.length === 0) return;
    try {
      const dtos = await deps.probeIdentities(paths);
      for (const [path, reading] of identityReadingsOf(dtos)) identityCache.set(path, reading);
    } catch (err) {
      // 读不到标识不是致命错误：probeFromCache 缺项一律按读取失败处理（保守重跑）
      console.warn('读取原图信息失败（判定将按已变更保守处理）:', err);
    }
  };

  /** 只读一张图的标识并写入缓存（换图后用：判定要按新文件的大小/修改时间算）。 */
  const refreshOneIdentity = async (path: string): Promise<void> => {
    try {
      const dtos = await deps.probeIdentities([path]);
      for (const [readPath, reading] of identityReadingsOf(dtos)) identityCache.set(readPath, reading);
    } catch (err) {
      console.warn('读取新原图信息失败（判定将按已变更保守处理）:', err);
    }
  };

  /**
   * 点列表某行 → 打开该条目的编辑弹窗（T4）。不是选中态：弹窗里有独立的图片区与
   * 参数区，关闭后回列表、列表状态同步刷新（弹窗内的改动全程直接落在会话态）。
   */
  const openEditor = (entry: ImageEntry): void => {
    if (editorOpen || running || deps.isBusy()) return;
    editorOpen = true;
    // 弹窗关闭回调里重算列表与跑分按钮（票面：编辑后待跑数量同步变化）
    void openImageEntryEditor(groupId, entry, {
      loadImageCatalog: () => deps.loadImageCatalog(),
      pickImage: () => deps.pickReplacementImage(),
      clearCandidates: (groupIdOfCall, roundId) => deps.clearCandidates(groupIdOfCall, roundId),
      describeRound: (roundId) => deps.describeRound(groupId, roundId),
      refreshIdentity: (path) => refreshOneIdentity(path),
      identityProbe: () => probeFromCache(identityCache),
      onChanged: () => renderList(),
      setStatus: deps.setStatus,
    }).finally(() => {
      editorOpen = false;
      renderList();
    }).catch((err: unknown) => {
      // 弹窗自身的异常不该把整个面板带崩（会话态与列表保持原样，可重开）
      deps.setStatus(`打开编辑窗口失败：${String(err)}`, true);
    });
  };

  /** 渲染整张列表（跑完原地刷新也走这里，面板不关闭）。 */
  const renderList = (): void => {
    listBox.replaceChildren();
    const entries = session.entries;
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint queue-empty';
      empty.textContent = '还没有图片。点上方「＋ 添加图片」多选加入，添加后即可直接跑分。';
      listBox.append(empty);
      syncChrome();
      return;
    }
    const duplicates = duplicateEntryIds(entries);
    const verdicts = judgeEntries(entries, probeFromCache(identityCache));
    entries.forEach((entry, index) => {
      const verdict = verdicts[index];
      const row = document.createElement('div');
      row.className = 'queue-row';
      row.dataset.imageId = entry.id;

      const name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = truncateFileName(fileName(entry.path));
      name.title = entry.path;

      const badge = document.createElement('span');
      badge.className = `queue-badge queue-badge-${verdict.state}`;
      badge.textContent = badgeText(verdict.state, verdict.reasons);
      const failures = entryFailures(entry);
      if (failures.length > 0) {
        badge.title = failures
          .map((failure) => `${failure.encoderId}：${failure.reason}`)
          .join('\n');
      }

      const cells: HTMLElement[] = [name, badge];
      if (duplicates.has(entry.id)) {
        const dup = document.createElement('span');
        dup.className = 'queue-badge queue-badge-dup';
        dup.textContent = '重复图片';
        dup.title = '同一路径在列表里出现了多次（允许：可以用来对比两套不同的参数）';
        cells.push(dup);
      }

      const del = document.createElement('button');
      del.className = 'queue-delete';
      del.textContent = '×';
      del.title = '删除这个图片条目（有评测轮时连带删除）';
      del.disabled = running || deps.isBusy();
      // 点 × 是删除，不该顺手把编辑弹窗一起打开（行点击的默认动作）
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        void deleteEntry(entry);
      });
      cells.push(del);

      row.append(...cells);
      // 点行 = 打开这一条的编辑弹窗（不是选中态）；跑分中/忙时点不开
      row.title = '点开编辑这张图的参数与图片';
      row.addEventListener('click', () => openEditor(entry));
      listBox.append(row);
    });
    syncChrome();
  };

  /** 添加图片：多选后直接入列，全程不弹任何窗（票面验收）。 */
  const addImages = async (): Promise<void> => {
    if (running || deps.isBusy()) return;
    let paths: string[];
    try {
      paths = await deps.pickImages();
    } catch (err) {
      deps.setStatus(`选择图片失败：${String(err)}`, true);
      return;
    }
    if (paths.length === 0) return; // 用户取消
    addImagePaths(session, paths);
    await refreshIdentities();
    renderList();
    deps.setStatus(`已加入 ${paths.length} 张图片（尚未跑分，工作区未改动）`);
  };
  addBtn.addEventListener('click', () => void addImages());

  /**
   * 把面板依赖包成编排层的执行器：查轮存活 / 惰性建轮 / 设原图 / 单卡编码 / 纳产物 /
   * 子集跑分。
   * 所有 IPC 细节留在这里，src/image-queue-run.ts 只负责顺序与失败兜底（node 可测）。
   */
  const buildExecutor = (): QueueRunExecutor => ({
    // 跑分前确认条目记着的轮还在工作区（被主界面删掉时编排层丢弃 id、惰性重建轮）
    describeRound: (_entry, roundId) => deps.describeRound(groupId, roundId),
    createRound: async (entry) => {
      const created = await deps.createRound(groupId, entry.path);
      return created.roundId;
    },
    setReference: (entry, roundId) => deps.setReference(groupId, roundId, entry.path),
    encode: (entry, roundId, planned, conflicts) => {
      deps.setStatus(`正在生成「${fileName(entry.path)}」的 ${planned.encoder.encoderId} 产物…`);
      return deps.encode(groupId, roundId, entry.path, planned.encoder, conflicts);
    },
    addCandidates: (_entry, roundId, products) =>
      deps.addCandidates(
        groupId,
        roundId,
        products.map((product) => product.path),
        products.map((product) => product.encodingParams),
      ),
    scoreCandidates: (_entry, roundId, paths) => deps.scoreRound(groupId, roundId, [...paths]),
    deleteRound: (_entry, roundId) => deps.deleteRound(groupId, roundId),
  });

  /**
   * 点「跑分 / 重跑」：按 planScore 只跑计划内的编码器条目。
   *
   * 无待跑条目时只弹提示卡片、不执行任何编码或跑分调用（runScorePlan 在计划为空时
   * 不会碰执行器的任何方法）；有待跑时逐图执行、每张跑完原地刷新列表，最后弹汇总
   * 卡片。面板全程不关闭。
   */
  const runScoring = async (): Promise<void> => {
    if (running || deps.isBusy()) return;
    if (session.entries.length === 0) {
      deps.setStatus('还没有可跑分的图片：先添加图片（新条目自带一条 JPEG 有损配置）', true);
      return;
    }
    running = true;
    renderList();
    deps.rerender();
    try {
      // 跑分前把标识读新：计划与快照比对必须基于当前文件大小/修改时间
      await refreshIdentities();
      const probe = probeFromCache(identityCache);
      const report = await deps.withBusy(() =>
        runScorePlan(session.entries, probe, buildExecutor(), {
          onImageStart: ({ path, index, total }) => {
            deps.setStatus(`正在跑分 第 ${index + 1}/${total} 张（${fileName(path)}）…`);
          },
          onImageDone: () => renderList(),
          askConflict: (name) => askFileConflict(name),
        }),
      );
      if (!report.ran) {
        // 无待跑：只弹提示卡片，runScorePlan 未执行任何编码/跑分调用。
        // 原因按 skippedImages 分流——「没有编码器配置」不等于「已跑分且无变更」。
        const notice = nothingToRunNotice(report.plan);
        deps.setStatus(notice.lines.join('；'));
        showQueueNotice(notice.lines, { title: notice.title });
        return;
      }
      const failedCount = report.images.reduce((sum, image) => sum + image.failures.length, 0);
      const systemErrors = report.images.filter((image) => image.error !== null).length;
      if (failedCount === 0 && systemErrors === 0) {
        deps.setStatus(`跑分完成：${report.plan.runImageCount} 张图片已更新`);
      } else {
        deps.setStatus(
          `跑分完成：${report.plan.runImageCount} 张图片已更新；${failedCount} 条失败` +
            (systemErrors > 0 ? `，${systemErrors} 张图出错` : '') +
            '（详情见列表徽章）',
          true,
        );
      }
      // 汇总卡片：本次跑分 N 张，跳过 M 张 + 逐张跳过原因
      showQueueNotice(summaryLines(report.plan), { title: '跑分汇总' });
    } catch (err) {
      deps.setStatus(`跑分失败：${String(err)}`, true);
    } finally {
      running = false;
      renderList();
      deps.rerender();
    }
  };
  scoreBtn.addEventListener('click', () => void runScoring());

  /** 点某行 ×：先弹应用内模态卡片二次确认，确认后移除条目（有轮则连带删轮）。 */
  const deleteEntry = async (entry: ImageEntry): Promise<void> => {
    if (running || deps.isBusy()) return;
    const info = entry.roundId === null ? null : deps.describeRound(groupId, entry.roundId);
    const plan = planDelete(entry, info);
    const confirmed = await confirmCard({ title: '删除图片条目', message: plan.message });
    if (!confirmed) return;
    if (plan.roundId !== null) {
      try {
        await deps.deleteRound(groupId, plan.roundId);
      } catch (err) {
        deps.setStatus(`删除评测轮失败：${String(err)}（条目未删除）`, true);
        return;
      }
    }
    removeImageEntry(session, plan.entryId);
    renderList();
    deps.rerender();
    deps.setStatus(`已删除「${plan.fileName}」；磁盘上的产物文件保留`);
  };

  document.body.append(overlay);
  renderList();
  // 首次挂载就把标识读回来：四态徽章的口径与跑分判定同源（缓存缺失会保守判「图片换了」）
  void refreshIdentities().then(() => renderList());
}
