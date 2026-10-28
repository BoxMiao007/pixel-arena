// 逐图参数编辑区（就地编辑版）：候选分区里展开的一块，或队列模态的第 2 步。
//
// 与旧整屏弹窗的差别：只提供「内容视图」（renderEntryEditor 返回节点），由调用方决定
// 放在检视器分区里还是模态步骤里——同一份实现，两处不漂移。
//
// 即时生效：没有「确定 / 应用」，所有修改直接落在会话态的 ImageEntry 上；只有回队列
// 点「跑分」才写工作区。卡片本身走 src/ui/encoder-card（与视频域共享一份）。

import { el } from '../../../ui/dom';
import { badge, button } from '../../../ui/primitives';
import { copyText } from '../../../core/util';

/** 徽章悬浮提示里的多行分隔（不用字面转义，避免模板里被误读）。 */
const SEP = String.fromCharCode(10);
import { renderEncoderCard, type EncoderCardCatalog } from '../../../ui/encoder-card';
import type { ImageSpec } from '../logic/advanced';
import { judgeImageEntry, type ImageEntry, type ImageEntryState } from '../logic/entries';
import { entryFailures } from '../logic/entries';
import type { ImageEntryEditorDeps } from '../logic/runtime';
import {
  addEncoderCard,
  editorHeader,
  moveCard,
  planReplaceImage,
  runReplaceImage,
} from '../logic/editor-plan';

/** 四态 → 徽标语义色。 */
const BADGE_KIND: Record<ImageEntryState, 'neutral' | 'ok' | 'info' | 'danger'> = {
  unscored: 'neutral',
  scored: 'ok',
  stale: 'info',
  failed: 'danger',
};

export interface EntryEditorView {
  node: HTMLElement;
  /** 外部状态变化（如徽章判定）后重画；不重建正在编辑的输入框以外的东西。 */
  refresh(): void;
  /** 当前内容的唯一键（宿主用 paint 保护输入焦点）。 */
  key(): string;
}

/** 目录只拉一次（模块级缓存；失败不缓存，允许重试）。 */
let catalogPromise: Promise<ImageSpec[]> | null = null;

function loadCatalog(deps: ImageEntryEditorDeps): Promise<ImageSpec[]> {
  if (!catalogPromise) {
    catalogPromise = deps.loadImageCatalog().catch((err: unknown) => {
      catalogPromise = null;
      throw err;
    });
  }
  return catalogPromise;
}

/** 折叠区开合：entryId → (region → open)。两类折叠区（参数行 / 命令行预览）互不干扰。 */
function collectOpenRegions(root: ParentNode): Map<string, Map<string, boolean>> {
  const previous = new Map<string, Map<string, boolean>>();
  for (const card of root.querySelectorAll<HTMLElement>('.enc-card')) {
    const id = card.dataset.entryId;
    if (id === undefined) continue;
    const openByRegion = new Map<string, boolean>();
    for (const region of card.querySelectorAll<HTMLElement>('[data-adv-region]')) {
      if (region instanceof HTMLDetailsElement) {
        openByRegion.set(region.dataset.advRegion ?? '', region.open);
      } else {
        openByRegion.set(region.dataset.advRegion ?? '', region.dataset.open !== 'false');
      }
    }
    previous.set(id, openByRegion);
  }
  return previous;
}

function restoreOpenRegions(root: ParentNode, previous: Map<string, Map<string, boolean>>): void {
  for (const card of root.querySelectorAll<HTMLElement>('.enc-card')) {
    const openByRegion = previous.get(card.dataset.entryId ?? '');
    if (!openByRegion) continue;
    for (const region of card.querySelectorAll<HTMLElement>('[data-adv-region]')) {
      const open = openByRegion.get(region.dataset.advRegion ?? '');
      if (open === undefined) continue;
      if (region instanceof HTMLDetailsElement) {
        region.open = open;
      } else {
        region.dataset.open = String(open);
        const body = region.querySelector<HTMLElement>('.enc-card__region-body');
        if (body) body.hidden = !open;
      }
    }
  }
}

/**
 * 渲染一个条目的编辑视图。
 *
 * groupId 只用于换图时清行（后端命令要组 id）；其余全部经 deps 注入。
 */
export function renderEntryEditor(
  groupId: string,
  entry: ImageEntry,
  deps: ImageEntryEditorDeps,
): EntryEditorView {
  const specs: ImageSpec[] = [];
  let loading = true;
  let loadError: string | null = null;

  const catalog: EncoderCardCatalog = { kind: 'image', imageSpecs: specs, videoCatalog: null };

  const nameEl = el('span', { class: 'enc-editor__name' });
  const badgeSlot = el('span', { class: 'enc-editor__badge' });
  const replaceBtn = button({
    label: '更换图片',
    variant: 'secondary',
    size: 'sm',
    title: '用新文件替换这张原图：编码器配置保留，旧跑分记录清掉（磁盘产物文件不删）',
    onClick: () => void replaceImage(),
  });
  const head = el(
    'div',
    { class: 'enc-editor__head' },
    el('div', { class: 'enc-editor__title' }, nameEl, badgeSlot),
    replaceBtn,
  );

  const cardsBox = el('div', { class: 'enc-editor__cards' });
  const hintBox = el('p', { class: 'enc-editor__hint' });
  const node = el('div', { class: 'enc-editor' }, head, hintBox, cardsBox);

  /** 头部：文件名 + 四态徽章（判定与列表同一份来源）。 */
  const syncHead = (): void => {
    const verdict = judgeImageEntry(entry, deps.identityProbe());
    const header = editorHeader(entry, verdict);
    nameEl.textContent = header.fileName;
    nameEl.title = entry.path;
    const failures = entryFailures(entry);
    const badgeEl = badge(
      header.status,
      BADGE_KIND[verdict.state],
      failures.length > 0
        ? failures.map((failure) => `${failure.encoderId}：${failure.reason}`).join(SEP)
        : undefined,
    );
    badgeEl.classList.add('enc-badge');
    badgeSlot.replaceChildren(badgeEl);
  };

  /** 卡片列表：整卡重建（结构性改动后的唯一出口），折叠区按双键回写。 */
  const renderCards = (): void => {
    const previous = collectOpenRegions(cardsBox);
    cardsBox.replaceChildren();
    if (loading) {
      cardsBox.append(el('p', { class: 'enc-editor__hint', text: '正在读取编码器目录…' }));
      return;
    }
    if (specs.length === 0) {
      cardsBox.append(
        el('p', {
          class: 'enc-editor__error',
          text: loadError
            ? `编码器目录加载失败：${loadError}。可重开这个条目重试。`
            : '编码器目录为空：到设置页检查编码器配置后重试。',
        }),
      );
      return;
    }
    entry.encoders.forEach((card, index) => {
      cardsBox.append(
        renderEncoderCard(
          card,
          index,
          catalog,
          {
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
            onCopy: (text) => copyText(text, () => deps.setStatus('已复制命令行')),
          },
          { referencePath: entry.path },
        ),
      );
    });
    restoreOpenRegions(cardsBox, previous);
    cardsBox.append(
      el(
        'div',
        { class: 'enc-editor__actions' },
        button({
          label: '＋ 添加编码器',
          variant: 'secondary',
          size: 'sm',
          title: '给这张图再加一条编码器配置（同一编码器可以重复添加，各自参数独立）',
          onClick: () => {
            if (!addEncoderCard(entry, specs)) return;
            renderCards();
            notifyChanged();
          },
        }),
      ),
    );
  };

  const notifyChanged = (): void => {
    syncHead();
    deps.onChanged();
  };

  // 连续输入（质量滑杆 / 文本）不重建卡片，只同步徽章与列表
  cardsBox.addEventListener('input', () => syncHead());
  cardsBox.addEventListener('change', () => syncHead());

  let replacing = false;
  async function replaceImage(): Promise<void> {
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
      if (!picked) return;
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
      renderCards(); // 命令行预览的输入路径随原图变化
      notifyChanged();
      deps.setStatus(plan.message);
    } finally {
      replacing = false;
      replaceBtn.disabled = false;
    }
  }

  /** 外部状态变化（徽章判定 / 列表刷新）后同步头部；结构变化由卡片回调重建。 */
  const refresh = (): void => syncHead();

  // 目录异步拉取：失败只影响参数区（换图仍可用）
  void loadCatalog(deps)
    .then((loaded) => {
      specs.push(...loaded);
      loading = false;
      hintBox.textContent =
        loaded.length === 0 ? '' : '改动即时生效；点队列里的「跑分」才会写工作区。';
    })
    .catch((err: unknown) => {
      loading = false;
      loadError = String(err);
      deps.setStatus(`编码器目录加载失败：${String(err)}`, true);
    })
    .finally(() => {
      renderCards();
      syncHead();
    });

  syncHead();
  renderCards();

  return {
    node,
    refresh,
    key: () => `entry:${entry.id}:${entry.encoders.length}:${entry.path}`,
  };
}
