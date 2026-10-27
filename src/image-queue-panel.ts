// 图片条目列表面板（票 #77 / T3）：图片跑分组的「高级创建」入口从旧向导换成条目队列。
//
// 交互骨架（父规格 #74「交互与编排」）：
// - 顶部「添加图片」多选后**直接入列，不弹任何窗**；
// - 中部每行 = 中间截断文件名 + 状态徽章 + 删除按钮（同一路径重复添加给「重复图片」提示）；
// - 底部「跑分」跑全量（本票阶段；增量在 T5），跑完**面板不关闭**、列表原地刷新；
// - 删除条目前弹应用内模态卡片二次确认（点名轮名与结果条数、写明磁盘产物不删），
//   有轮则连带删轮。
//
// 两条数据边界：
// 1. **只改会话态**：条目队列活在 src/image-queue.ts 的模块级 Map 里（T2 交付），本面板
//    只读它、经 T2 的纯函数改它；只有点「跑分」才经 deps 真正写工作区。关掉面板没跑过 =
//    工作区零变更。
// 2. **惰性建轮**：条目第一次真正产出产物时才建评测轮（`planQueueRun` 的 createsRound），
//    仅添加图片不建轮；本次新建的轮若一条产物都没产出就回滚删掉，工作区不留空轮。
//
// 本文件分工：文件上半是**编排决策的纯函数**（node 环境可测，见 image-queue-panel.test.ts），
// 下半是 DOM 渲染与转发（node 环境只能做机制守卫，仓库约定不引 jsdom）。
// 四态判定、脏原因、轮命名、结果回写全部复用 src/image-queue.ts，本模块不另造判定。

import { askFileConflict, ConflictSession } from './conflict';
import {
  addImagePaths,
  applyRunResults,
  attachRound,
  badgeText,
  duplicateEntryIds,
  entryFailures,
  imageIdentityFrom,
  imageQueueFor,
  judgeEntries,
  paramFingerprint,
  probeFromCache,
  removeImageEntry,
  type EncoderCard,
  type EncoderRunOutcome,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageIdentityReading,
} from './image-queue';
import type { AdvancedProductDto } from './advanced-ui';
import { fileName, truncateFileName } from './util';

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

/** 一轮跑分后的逐行结果（面板据此把「编码成功但跑分失败」折成失败，见 mergeScoreFailures）。 */
export interface ScoredCandidate {
  path: string;
  error: string | null;
}

/** 删除确认需要知道的评测轮信息（宿主从工作区读，面板不自己持有工作区）。 */
export interface ImageQueueRoundInfo {
  name: string;
  candidateCount: number;
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
  /** 清空某轮跑分图行（全量重跑前清旧行；原图与轮保留，磁盘产物文件不删）。 */
  clearCandidates(groupId: string, roundId: string): Promise<void>;
  /** 删除评测轮（删条目时连带删除）。 */
  deleteRound(groupId: string, roundId: string): Promise<void>;
  /** 整轮跑分（复用主界面入口）；返回逐行结果供失败判定。 */
  scoreRound(groupId: string, roundId: string): Promise<ScoredCandidate[]>;
  /** 跑分期间与主界面一致地置灰（主界面的 scoring 忙标志由宿主维护）。 */
  withBusy<T>(task: () => Promise<T>): Promise<T>;
  /** 主界面忙标志（忙时面板不再发起新的跑分）。 */
  isBusy(): boolean;
  /** 当前工作区里某轮的名字与结果条数；轮已不在工作区时返回 null。 */
  describeRound(groupId: string, roundId: string): ImageQueueRoundInfo | null;
  /** 新建了评测轮之后刷新主界面（轮次栏与标签页）。 */
  rerender(): void;
  setStatus(text: string, isError?: boolean, title?: string): void;
}

// ---------- 编排决策（纯函数，node 环境可测） ----------

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

/** 一次面板跑分里一张条目的计划：要跑哪些卡、要不要先建轮。 */
export interface EntryRunPlan {
  entry: ImageEntry;
  /** 惰性建轮：该条目还没有轮（第一次真正产出产物时要建）。 */
  createsRound: boolean;
  /** 本次要编码的编码器卡（T3 全量：条目里的全部卡）。 */
  cards: EncoderCard[];
}

/**
 * 算本次跑分要处理的条目（T3 = 跑全量）。
 *
 * 与 T2 的 planScore 的区别：**不看脏标记**——本票阶段点「跑分」就是整批重跑，
 * 增量跳过与「只跑改过的」都留给 T5（票面「跑分暂全量」）。这里只做两件事：
 * 过滤掉没有编码器卡的条目（没东西可编码），标出哪些条目要先建轮。
 */
export function planQueueRun(entries: ImageEntry[]): EntryRunPlan[] {
  return entries
    .filter((entry) => entry.encoders.length > 0)
    .map((entry) => ({
      entry,
      createsRound: entry.roundId === null,
      cards: entry.encoders,
    }));
}

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
export function planDelete(entry: ImageEntry, round: ImageQueueRoundInfo | null): DeletePlan {
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

/** 「跑分」按钮文案：T3 跑全量，直接显示条目张数（T5 换成待跑张数）。 */
export function scoreButtonLabel(entryCount: number): string {
  return entryCount === 0 ? '跑分' : `跑分（${entryCount} 张）`;
}

/**
 * 把「编码成功但跑分失败」的卡折成失败结果。
 *
 * 为什么需要它：编码成功只说明产物写出来了，跑分（解码 + 指标计算）仍可能失败，
 * 失败原因由核心库写进产物行的 error 字段。T2 的 applyRunResults 只在成功时写快照，
 * 所以这里必须把这类行降级成失败——否则一张解不开的图会被记成「已跑分」。
 * 产物行没出现（例如没进轮）时保持原结论，交给快照比对兜底。
 */
export function mergeScoreFailures(
  outcomes: EncoderRunOutcome[],
  scored: readonly ScoredCandidate[],
): EncoderRunOutcome[] {
  const failureByPath = new Map<string, string>();
  for (const row of scored) {
    if (row.error !== null && row.error !== undefined) failureByPath.set(row.path, row.error);
  }
  if (failureByPath.size === 0) return outcomes;
  return outcomes.map((outcome) => {
    if (outcome.kind !== 'success') return outcome;
    const reason = failureByPath.get(outcome.artifactPath);
    return reason === undefined
      ? outcome
      : { kind: 'failure', cardId: outcome.cardId, reason };
  });
}

// ---------- 面板 DOM ----------

/** 标识缓存（模块级：标识是文件元数据，跨面板开关与跑分组共用一份，读新即可）。 */
const identityCache = new Map<string, ImageIdentityReading>();

/** 模态卡片：确认返回 true，× / 点遮罩 / Esc 三路关闭返回 false（范式照抄 main.ts 的 openStatusCard）。 */
interface ConfirmCardOptions {
  title: string;
  message: string;
}

function confirmCard(options: ConfirmCardOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    const panel = document.createElement('div');
    panel.className = 'status-card queue-confirm-card';
    const head = document.createElement('div');
    head.className = 'status-card-head';
    const heading = document.createElement('h2');
    heading.textContent = options.title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'settings-mini-btn';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    head.append(heading, closeBtn);

    const body = document.createElement('pre');
    body.className = 'status-card-body';
    body.textContent = options.message;

    const actions = document.createElement('div');
    actions.className = 'status-card-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'settings-mini-btn';
    cancelBtn.textContent = '取消';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'settings-primary-btn';
    confirmBtn.textContent = '删除';
    actions.append(cancelBtn, confirmBtn);

    let settled = false;
    /** 收口：先摘 keydown 监听再移除遮罩（三路关闭共用，防监听泄漏）。 */
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(false);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    closeBtn.addEventListener('click', () => finish(false));
    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));

    panel.append(head, body, actions);
    overlay.append(panel);
    document.body.append(overlay);
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
    '点「跑分」才开始生成产物并写工作区——没跑过的图不会留下空轮，关掉面板等于工作区零变更。';
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
  scoreBtn.title = '对列表里每一张图生成产物并跑分（本版本每次跑全量）';
  actions.append(scoreBtn);
  panel.append(actions);

  /** 按钮与标题随会话态同步（不重建 DOM，避免清掉焦点）。 */
  const syncChrome = (): void => {
    const count = session.entries.length;
    title.textContent = `图片条目（${count} 张）`;
    addBtn.disabled = running || deps.isBusy();
    // 跑分按钮文字按会话态走：空列表只写「跑分」，有条目带张数；跑分中换进度文案
    scoreBtn.textContent = running ? '跑分中…' : scoreButtonLabel(count);
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
      del.addEventListener('click', () => void deleteEntry(entry));
      cells.push(del);

      row.append(...cells);
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
   * 跑一张条目：惰性建轮 → 设原图 → 逐卡编码 → 纳入产物 → 跑该轮。
   *
   * 回滚口径：本次新建的轮在**一条产物都没产出**时删掉（工作区不留空轮）；一旦
   * 产物进了轮就保留轮（已有真实内容，留着比删掉干净）。
   */
  const runEntry = async (plan: EntryRunPlan, probe: ImageIdentityProbe): Promise<void> => {
    const { entry, cards } = plan;
    const identity = probe(entry.path);
    // 计划时指纹：参数若在跑分中途被改（T5 起可改），快照写回的是当时真正用的指纹
    const fingerprints = new Map(cards.map((card) => [card.id, paramFingerprint(card)]));
    const outcomes: EncoderRunOutcome[] = [];
    const products: AdvancedProductDto[] = [];
    let roundId = entry.roundId;
    let added = false;
    let createdNow = false;
    try {
      if (roundId === null) {
        const created = await deps.createRound(groupId, entry.path);
        roundId = created.roundId;
        attachRound(entry, roundId);
        createdNow = true;
      }
      await deps.setReference(groupId, roundId, entry.path);
      // 一批评测产物共用一个冲突决策会话（T30「应用到本次全部冲突」的边界）
      const conflicts = new ConflictSession((name) => askFileConflict(name));
      for (const card of cards) {
        deps.setStatus(`正在生成「${fileName(entry.path)}」的 ${card.encoderId} 产物…`);
        try {
          const product = await deps.encode(groupId, roundId, entry.path, card, conflicts);
          products.push(product);
          // 成功结果先记下（快照写回要带计划时指纹）；跑分若失败，mergeScoreFailures 再降级
          outcomes.push({
            kind: 'success',
            cardId: card.id,
            artifactPath: product.path,
            fingerprint: fingerprints.get(card.id) ?? paramFingerprint(card),
          });
        } catch (err) {
          outcomes.push({ kind: 'failure', cardId: card.id, reason: String(err) });
        }
      }
      if (products.length === 0) {
        // 一条产物都没产出：本次新建的轮没有意义，回滚掉（不能留下空轮）
        if (createdNow) {
          await deps.deleteRound(groupId, roundId);
          entry.roundId = null;
          roundId = null;
        }
        applyRunResults(entry, outcomes, identity);
        const reasons = outcomes
          .map((outcome) => (outcome.kind === 'failure' ? outcome.reason : ''))
          .filter((reason) => reason !== '');
        deps.setStatus(
          `「${fileName(entry.path)}」全部生成失败：${reasons.join('；')}`,
          true,
        );
        return;
      }
      await deps.addCandidates(
        groupId,
        roundId,
        products.map((product) => product.path),
        products.map((product) => product.encodingParams),
      );
      added = true;
      const scored = await deps.scoreRound(groupId, roundId);
      applyRunResults(entry, mergeScoreFailures(outcomes, scored), identity);
      const failed = entryFailures(entry);
      if (failed.length > 0) {
        deps.setStatus(
          `「${fileName(entry.path)}」跑分完成，${failed.length} 条失败：` +
            failed.map((failure) => `${failure.encoderId}：${failure.reason}`).join('；'),
          true,
        );
      }
    } catch (err) {
      // 建轮/设原图/纳入产物失败：产物还没进轮就把新建的轮回滚掉，避免残留空轮
      if (createdNow && !added && roundId !== null) {
        try {
          await deps.deleteRound(groupId, roundId);
          entry.roundId = null;
        } catch (rollbackErr) {
          console.warn('回滚空评测轮失败（工作区可能留下一个空轮）:', rollbackErr);
        }
      }
      if (outcomes.length > 0) applyRunResults(entry, outcomes, identity);
      deps.setStatus(`「${fileName(entry.path)}」跑分出错：${String(err)}`, true);
    }
  };

  /** 点「跑分」：本版本跑全量（每个条目各自一轮），面板不关闭、列表原地刷新。 */
  const runScoring = async (): Promise<void> => {
    if (running || deps.isBusy()) return;
    const plans = planQueueRun(session.entries);
    if (plans.length === 0) {
      deps.setStatus('还没有可跑分的图片：先添加图片（新条目自带一条 JPEG 有损配置）', true);
      return;
    }
    running = true;
    renderList();
    deps.rerender();
    try {
      await deps.withBusy(async () => {
        // 跑分前把标识读新：快照里记的必须是这次真正用的原图标识
        await refreshIdentities();
        const probe = probeFromCache(identityCache);
        for (const [index, plan] of plans.entries()) {
          deps.setStatus(
            `正在跑分 第 ${index + 1}/${plans.length} 张（${fileName(plan.entry.path)}）…`,
          );
          await runEntry(plan, probe);
          renderList();
        }
      });
      const ok = plans.filter((plan) => entryFailures(plan.entry).length === 0).length;
      deps.setStatus(`跑分完成：${plans.length} 张图片已更新（${ok} 张全部成功）`);
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
