// 逐图编辑弹窗（票 #78 / T4）：点图片条目列表的一行，打开「左图右参」的编辑窗口。
//
// 设计边界（父规格 #74「交互与编排」）：
// 1. **即时生效**：弹窗里没有「确认 / 套用」这一步——所有修改直接落在会话态对象
//    （ImageEntry 及其 encoders）上，关闭弹窗改动仍在；只有点面板的「跑分」才写工作区。
// 2. **卡片不重写**：右栏全部编码器卡走 src/encoder-card.ts 的 renderEncoderCard，
//    本模块只提供容器、整卡重建出口与折叠区回写（必须按 entryId × data-adv-region
//    双键，见 src/advanced-ui.ts 的既有实现）。
// 3. **换图编排是纯逻辑**：先清该条目评测轮里已有的跑分行（后端只摘行、不删磁盘
//    文件），再换原图路径；任何一步失败都不留下「新图 + 旧结果」的骗人组合。
//
// 本文件上半是 node 可测的纯函数，下半是 DOM 渲染与转发（仓库约定不引 jsdom，
// DOM 侧只做机制守卫）。

import {
  closeEncoderMenus,
  renderEncoderCard,
  type EncoderCardCatalog,
} from './encoder-card';
import { newEntry, type AdvancedEntry, type ImageSpec } from './advanced';
import {
  badgeText,
  DEFAULT_IMAGE_ENCODER_ID,
  judgeImageEntry,
  replaceImagePath,
  type ImageEntry,
  type ImageIdentityProbe,
  type ImageVerdict,
  type RoundSummary,
} from './image-queue';
import { copyText, fileName, truncateFileName } from './util';

// ---------- 纯逻辑：头部 / 换图计划 / 卡片增删 ----------

/** 弹窗头部与左栏共用的展示数据（文件名 + 当前状态的单一来源）。 */
export interface EditorHeader {
  /** 窗口标题：「编辑图片：<中间截断的文件名>」。 */
  title: string;
  /** 左栏文件名（中间截断，完整路径由调用方放 title）。 */
  fileName: string;
  /** 状态徽章文案（取 T2 的 badgeText，含「将重跑」原因括注）。 */
  status: string;
  /** 状态徽章 class（四态各一色）。 */
  statusClass: string;
}

/** 由条目与判定结论生成弹窗的头部展示数据。 */
export function editorHeader(entry: ImageEntry, verdict: ImageVerdict): EditorHeader {
  const name = truncateFileName(fileName(entry.path));
  return {
    title: `编辑图片：${name}`,
    fileName: name,
    status: badgeText(verdict.state, verdict.reasons),
    statusClass: `queue-badge queue-badge-${verdict.state}`,
  };
}

/** 换图编排的一步（顺序即执行顺序，纯数据便于断言）。 */
export type ReplaceImageStep =
  | { kind: 'clear-candidates'; roundId: string }
  | { kind: 'replace-path'; path: string };

/** 换图计划：要给用户看的口径 + 要执行的步骤序列。 */
export interface ReplaceImagePlan {
  fromPath: string;
  toPath: string;
  /** 要清跑分行的评测轮 id；null = 没有轮或轮已不在工作区，不清行。 */
  roundId: string | null;
  /** 执行步骤：先清行（有轮时），再换路径。 */
  steps: ReplaceImageStep[];
  /** 状态栏/按钮提示文案（写明配置保留与磁盘文件保留）。 */
  message: string;
}

/**
 * 算换图计划。
 *
 * 为什么要先清行：换图后旧产物对应的是**上一张原图**，留在结果表里就是「旧图产物
 * vs 新原图」的骗人对比。清行只摘评测记录，磁盘文件不动（后端 round_clear_candidates
 * 的语义），所以这里不需要也不应该删除任何文件。
 *
 * **选回同一路径也走正常换图**（这里曾经是「相同就不做更改」的 no-op，是个坑）：
 * 文档与 README 都说「用外部工具原地覆写同名同大小的文件只有修改时间能抓到，所以换
 * 图请用界面的『更换图片』」——同一路径恰恰是这条自救路径唯一能用的形态，no-op 会把它
 * 彻底堵死。显式换图一律置 replaced，旧结果整体作废、下次跑分重新生成。
 *
 * 轮已不在工作区（用户在主界面删过）时不拿旧 id 去清：那会得到一个「找不到评测轮」
 * 的错误，而条目其实已经只活在会话里。
 */
export function planReplaceImage(
  entry: ImageEntry,
  newPath: string,
  round: RoundSummary | null,
): ReplaceImagePlan {
  const from = fileName(entry.path);
  const to = fileName(newPath);
  const samePath = newPath === entry.path;
  const roundId = entry.roundId !== null && round !== null ? entry.roundId : null;
  const steps: ReplaceImageStep[] = [];
  if (roundId !== null) steps.push({ kind: 'clear-candidates', roundId });
  steps.push({ kind: 'replace-path', path: newPath });
  const clearText =
    round !== null && round.candidateCount > 0
      ? `评测轮『${round.name}』里这张图的 ${round.candidateCount} 条跑分结果已清掉，下次跑分重新生成；`
      : `评测轮『${round?.name ?? ''}』里这张图还没有跑分结果；`;
  // 同一路径的文案说「重新读取」而不是「换成同一张」——后者读起来像没做事
  const lead = samePath ? `已按同一路径重新读取「${to}」：` : `已把「${from}」换成「${to}」：`;
  const message =
    roundId !== null && round !== null
      ? `${lead}编码器配置保留；${clearText}磁盘上的产物文件保留。`
      : `${lead}编码器配置保留；` +
        `这条还没有评测轮，工作区未改动；磁盘上的产物文件保留。`;
  return { fromPath: entry.path, toPath: newPath, roundId, steps, message };
}

/** 换图执行时需要的宿主能力（纯逻辑层不碰 IPC / 文件系统）。 */
export interface ReplaceImageDeps {
  /** 清掉某轮已有的跑分行（只作用于评测记录，不删磁盘文件）。 */
  clearCandidates(roundId: string): Promise<void>;
  /** 读一次新原图的标识并写入判定缓存（换图后状态判定要用新文件的大小/修改时间）。 */
  refreshIdentity(path: string): Promise<void>;
}

/**
 * 按计划执行换图。
 *
 * 失败即中止：清行失败时**不换路径**——否则会留下「新原图 + 旧跑分行」的骗人组合，
 * 比操作失败更糟。换路径用 T2 的 replaceImagePath（清快照、清失败记录、置 replaced），
 * 所以换完立刻判「将重跑（图片换了）」。
 *
 * 换完必须重读原图标识：判定拿新文件的路径/大小/修改时间去比快照，旧缓存会让
 * 「图片换了」的原因显示成旧的（虽然 replaced 已保证 stale，但口径要一致）。
 */
export async function runReplaceImage(
  plan: ReplaceImagePlan,
  entry: ImageEntry,
  deps: ReplaceImageDeps,
): Promise<void> {
  for (const step of plan.steps) {
    if (step.kind === 'clear-candidates') {
      await deps.clearCandidates(step.roundId);
      continue;
    }
    replaceImagePath(entry, step.path);
  }
  if (plan.steps.length > 0) await deps.refreshIdentity(entry.path);
}

/**
 * 往条目里加一条默认编码器卡。
 *
 * 默认格式优先 JPEG（与「新条目自带一条 JPEG 有损配置」的口径一致，添加完就能跑）；
 * 目录里没有 JPEG 时退回第一条规格——总比「加不出卡」好。目录为空返回 null。
 */
export function addEncoderCard(entry: ImageEntry, imageSpecs: ImageSpec[]): AdvancedEntry | null {
  const spec = imageSpecs.find((item) => item.id === DEFAULT_IMAGE_ENCODER_ID) ?? imageSpecs[0];
  if (!spec) return null;
  const card = newEntry('image', spec.id, spec);
  entry.encoders.push(card);
  return card;
}

/** 卡片排序：把第 index 张卡上移/下移一位（越界不动）。 */
export function moveCard(entry: ImageEntry, index: number, delta: -1 | 1): void {
  const target = index + delta;
  if (index < 0 || index >= entry.encoders.length) return;
  if (target < 0 || target >= entry.encoders.length) return;
  const [card] = entry.encoders.splice(index, 1);
  entry.encoders.splice(target, 0, card);
}

// ---------- 纯逻辑：折叠区开合按 entryId × 区域双键回写 ----------

/**
 * 收集现有卡片里每个折叠区的开合状态：entryId → (data-adv-region → open)。
 *
 * 一张卡里有两个 <details>（高级参数默认展开 / 命令行预览默认收起），只按 entryId
 * 存一个布尔值会把两类折叠区互相覆盖（展开预览后加一行参数，预览就被打回收起）。
 */
export function collectOpenRegions(root: ParentNode): Map<string, Map<string, boolean>> {
  const prevOpen = new Map<string, Map<string, boolean>>();
  for (const card of root.querySelectorAll<HTMLElement>('.adv-entry')) {
    const id = card.dataset.entryId;
    if (id === undefined) continue;
    const openByRegion = new Map<string, boolean>();
    for (const details of card.querySelectorAll<HTMLDetailsElement>('details[data-adv-region]')) {
      openByRegion.set(details.dataset.advRegion ?? '', details.open);
    }
    prevOpen.set(id, openByRegion);
  }
  return prevOpen;
}

/** 重建后按 entryId × 区域回写开合；查不到的新卡保持默认（不误写相邻条目）。 */
export function restoreOpenRegions(
  root: ParentNode,
  prevOpen: Map<string, Map<string, boolean>>,
): void {
  for (const card of root.querySelectorAll<HTMLElement>('.adv-entry')) {
    const openByRegion = prevOpen.get(card.dataset.entryId ?? '');
    if (!openByRegion) continue;
    for (const details of card.querySelectorAll<HTMLDetailsElement>('details[data-adv-region]')) {
      const open = openByRegion.get(details.dataset.advRegion ?? '');
      if (open !== undefined) details.open = open;
    }
  }
}

// ---------- DOM：弹窗 ----------

/** 弹窗对宿主（列表面板）的依赖（不直接 import invoke / 文件对话框）。 */
export interface ImageEntryEditorDeps {
  /** 拉图片编码器目录（advanced_image_catalog 的 ImageSpec[]）。 */
  loadImageCatalog(): Promise<ImageSpec[]>;
  /** 系统文件对话框选一个图片（取消返回 null）。 */
  pickImage(): Promise<string | null>;
  /** 清掉某条目对应评测轮里的跑分行（round_clear_candidates）。 */
  clearCandidates(groupId: string, roundId: string): Promise<void>;
  /** 读某轮的名字与结果条数；轮已不在工作区返回 null。 */
  describeRound(roundId: string): RoundSummary | null;
  /** 读一次原图标识并写入判定缓存（换图后调用）。 */
  refreshIdentity(path: string): Promise<void>;
  /** 判定用的同步探针（列表与弹窗共用同一份标识缓存）。 */
  identityProbe(): ImageIdentityProbe;
  /** 弹窗内修改后同步列表（徽章/按钮计数立即更新）。 */
  onChanged(): void;
  setStatus(text: string, isError?: boolean): void;
}

/**
 * 打开逐图编辑弹窗（覆盖层挂 body，关闭即销毁；改动留在会话态）。
 *
 * 返回的 Promise 在弹窗关闭时 resolve——列表面板据此恢复「同一时间只有一个编辑窗」。
 */
export async function openImageEntryEditor(
  groupId: string,
  entry: ImageEntry,
  deps: ImageEntryEditorDeps,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay queue-editor-overlay';
    const panel = document.createElement('div');
    panel.className = 'settings-panel queue-editor-panel';
    overlay.append(panel);

    let closed = false;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    // 推荐参数下拉的收起范围限定在右栏：不扫整个 document（否则会与其它弹层互相收掉）
    const onDocClick = (): void => closeEncoderMenus(cardsBox);
    const close = (): void => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      overlay.remove();
      resolve();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // ---------- 头部：文件名 + 当前状态 ----------
    const head = document.createElement('div');
    head.className = 'settings-head';
    const title = document.createElement('h2');
    const headRight = document.createElement('div');
    headRight.className = 'queue-editor-head-right';
    const headBadge = document.createElement('span');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭编辑窗口（改动已即时生效，关掉也保留）';
    closeBtn.addEventListener('click', close);
    headRight.append(headBadge, closeBtn);
    head.append(title, headRight);

    // ---------- 两栏：左图 / 右参 ----------
    const body = document.createElement('div');
    body.className = 'queue-editor-body';

    const side = document.createElement('section');
    side.className = 'queue-editor-side';
    const sideTitle = document.createElement('h3');
    sideTitle.textContent = '图片';
    const sideName = document.createElement('p');
    sideName.className = 'queue-editor-file';
    const sideBadge = document.createElement('span');
    const pathEl = document.createElement('p');
    pathEl.className = 'queue-editor-path';
    const sideActions = document.createElement('div');
    sideActions.className = 'queue-editor-side-actions';
    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'settings-mini-btn queue-editor-replace';
    replaceBtn.textContent = '更换图片';
    replaceBtn.title = '用新文件替换这张原图：编码器配置保留，旧跑分结果清掉（磁盘产物文件不删）';
    const sideHint = document.createElement('p');
    sideHint.className = 'settings-hint queue-editor-side-hint';
    sideHint.textContent =
      '更换图片会保留这一条的全部编码器配置与参数，只把原图换掉；' +
      '旧跑分记录会从评测轮里清掉，磁盘上的产物文件保留。' +
      '用外部工具原地覆写过原图时，再选同一个文件也会强制重跑（旧结果作废）。';
    sideActions.append(replaceBtn);
    side.append(sideTitle, sideName, sideBadge, pathEl, sideActions, sideHint);

    const main = document.createElement('section');
    main.className = 'queue-editor-main';
    const mainHead = document.createElement('div');
    mainHead.className = 'queue-editor-main-head';
    const mainTitle = document.createElement('h3');
    mainTitle.textContent = '编码器配置';
    const addBtn = document.createElement('button');
    addBtn.className = 'settings-mini-btn';
    addBtn.textContent = '＋ 添加编码器';
    addBtn.title = '给这张图再加一条编码器配置（同一编码器可以重复添加，各自参数独立）';
    mainHead.append(mainTitle, addBtn);
    const cardsBox = document.createElement('div');
    cardsBox.className = 'adv-entries queue-editor-cards';
    main.append(mainHead, cardsBox);
    body.append(side, main);
    panel.append(head, body);

    // ---------- 状态同步（头部 + 左栏徽章同一来源） ----------
    const verdict = (): ImageVerdict => judgeImageEntry(entry, deps.identityProbe());
    const syncStatus = (): void => {
      const header = editorHeader(entry, verdict());
      title.textContent = header.title;
      headBadge.textContent = header.status;
      headBadge.className = header.statusClass;
      sideName.textContent = header.fileName;
      sideName.title = entry.path;
      sideBadge.textContent = header.status;
      sideBadge.className = header.statusClass;
      pathEl.textContent = entry.path;
      pathEl.title = entry.path;
    };
    const notifyChanged = (): void => {
      syncStatus();
      deps.onChanged();
    };

    // ---------- 右栏：共享编码器卡（整卡重建出口） ----------
    const imageSpecs: ImageSpec[] = [];
    const catalog: EncoderCardCatalog = { kind: 'image', imageSpecs, videoCatalog: null };
    let loading = true;

    const copyLine = (text: string): void => {
      copyText(text, () => deps.setStatus('已复制命令行'));
    };

    const renderCards = (): void => {
      const prevOpen = collectOpenRegions(cardsBox);
      cardsBox.replaceChildren();
      if (loading) {
        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.textContent = '正在读取编码器目录…';
        cardsBox.append(hint);
        return;
      }
      if (imageSpecs.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.textContent = '编码器目录为空：请到设置页检查编码器配置后重开本窗口。';
        cardsBox.append(hint);
        return;
      }
      entry.encoders.forEach((card, index) => {
        cardsBox.append(
          renderEncoderCard(card, index, catalog, {
            onChange: () => {
              renderCards();
              notifyChanged();
            },
            onMove: (delta) => {
              moveCard(entry, index, delta);
              renderCards();
              notifyChanged();
            },
            onRemove: () => {
              entry.encoders.splice(index, 1);
              renderCards();
              notifyChanged();
            },
            onReset: () => {
              renderCards();
              notifyChanged();
            },
            onCopy: copyLine,
          }, {
            referencePath: entry.path,
            menuRoot: cardsBox,
          }),
        );
      });
      restoreOpenRegions(cardsBox, prevOpen);
    };

    addBtn.addEventListener('click', () => {
      const card = addEncoderCard(entry, imageSpecs);
      if (!card) return;
      renderCards();
      notifyChanged();
    });

    // 质量滑杆这类「输入中即时改值」的控件不走卡片的 onChange（避免重建丢焦点），
    // 这里用冒泡监听把徽章与列表刷新补上——即时生效没有第二个触发点。
    const onLiveEdit = (): void => {
      syncStatus();
      deps.onChanged();
    };
    cardsBox.addEventListener('input', onLiveEdit);
    cardsBox.addEventListener('change', onLiveEdit);

    // ---------- 更换图片（清旧跑分行 → 换原图 → 读新标识） ----------
    let replacing = false;
    replaceBtn.addEventListener('click', () => {
      void (async () => {
        if (replacing) return;
        replacing = true;
        replaceBtn.disabled = true;
        try {
          let picked: string | null;
          try {
            picked = await deps.pickImage();
          } catch (err) {
            deps.setStatus(`选择图片失败：${String(err)}`, true);
            return;
          }
          if (!picked || closed) return; // 用户取消
          const info = entry.roundId === null ? null : deps.describeRound(entry.roundId);
          const plan = planReplaceImage(entry, picked, info);
          try {
            await runReplaceImage(plan, entry, {
              clearCandidates: (roundId) => deps.clearCandidates(groupId, roundId),
              refreshIdentity: (path) => deps.refreshIdentity(path),
            });
          } catch (err) {
            deps.setStatus(`更换图片失败：${String(err)}（旧图片与跑分结果未改动）`, true);
            return;
          }
          if (closed) return;
          renderCards(); // 命令行预览的输入路径随原图变化
          notifyChanged();
          deps.setStatus(plan.message);
        } finally {
          replacing = false;
          replaceBtn.disabled = false;
        }
      })();
    });

    document.body.append(overlay);
    // 挂载后才挂全局监听（onDocClick 引用右栏容器；此时容器已建好，避免 TDZ）
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    syncStatus();
    renderCards();

    // 目录异步拉取：失败只影响参数区（换图仍可用），不关闭弹窗
    void (async () => {
      try {
        const specs = await deps.loadImageCatalog();
        if (closed) return;
        imageSpecs.push(...specs);
        loading = false;
        addBtn.disabled = specs.length === 0;
        renderCards();
        syncStatus();
      } catch (err) {
        if (closed) return;
        loading = false;
        cardsBox.replaceChildren();
        const error = document.createElement('p');
        error.className = 'settings-error';
        error.textContent = `编码器目录加载失败：${String(err)}。可关闭窗口重试。`;
        cardsBox.append(error);
        deps.setStatus(`编码器目录加载失败：${String(err)}`, true);
      }
    })();
  });
}
