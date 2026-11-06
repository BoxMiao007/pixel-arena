// 参数变体编辑区（就地展开版）：跑分图列表里展开的一块，或「从原图新建编码」弹窗的主体。
//
// 与旧整屏弹窗的差别：只提供「内容视图」（renderEntryEditor 返回节点），由调用方决定
// 放在检视器分区里还是模态里——同一份实现，两处不漂移。
//
// 即时生效：没有「确定 / 应用」，所有修改直接落在会话态的 ImageEntry 上；只有点
// 「生成并跑分」才写工作区。卡片本身走 src/ui/encoder-card（与视频域共享一份）。
//
// 变体不再自带原图（永远编码本轮原图），所以这里没有「更换图片」：换原图是轮级动作，
// 由来源分区负责；头部只如实显示本变体基于哪张原图。

import { el } from '../../../ui/dom';
import { badge, button } from '../../../ui/primitives';
import { copyText } from '../../../core/util';

/** 徽章悬浮提示里的多行分隔（不用字面转义，避免模板里被误读）。 */
const SEP = String.fromCharCode(10);
import { renderEncoderCard, type EncoderCardCatalog } from '../../../ui/encoder-card';
import type { ImageSpec } from '../logic/advanced';
import { judgeImageEntry, type ImageEntry, type ImageEntryState } from '../logic/entries';
import { entryFailures } from '../logic/entries';
import { failureBadge } from './failure';
import type { ImageEntryEditorDeps } from '../logic/runtime';
import {
  addEncoderCard,
  editorHeader,
  moveCard,
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
    // 整卡折叠也走同一份状态表（region 名固定为 'card'）
    openByRegion.set('card', card.dataset.open !== 'false');
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

/** 渲染一个参数变体的编辑视图（纯 DOM，不碰 IPC；依赖全部经 deps 注入）。 */
export function renderEntryEditor(entry: ImageEntry, deps: ImageEntryEditorDeps): EntryEditorView {
  const specs: ImageSpec[] = [];
  let loading = true;
  let loadError: string | null = null;

  const catalog: EncoderCardCatalog = { kind: 'image', imageSpecs: specs, videoCatalog: null };

  const nameEl = el('span', { class: 'enc-editor__name' });
  const referenceEl = el('span', { class: 'enc-editor__reference' });
  const badgeSlot = el('span', { class: 'enc-editor__badge' });
  const head = el(
    'div',
    { class: 'enc-editor__head' },
    el('div', { class: 'enc-editor__title' }, nameEl, badgeSlot),
    referenceEl,
  );

  const cardsBox = el('div', { class: 'enc-editor__cards' });
  /** 刚添加的卡片索引：重建后默认展开它，其余保持原样。 */
  let freshCardIndex: number | null = null;
  const hintBox = el('p', { class: 'enc-editor__hint' });
  const node = el('div', { class: 'enc-editor' }, head, hintBox, cardsBox);

  /** 头部：变体摘要 + 基于哪张原图 + 四态徽章（判定与列表同一份来源）。 */
  const syncHead = (): void => {
    const verdict = judgeImageEntry(entry, deps.identityProbe());
    const header = editorHeader(entry, verdict);
    nameEl.textContent = header.fileName;
    referenceEl.textContent = `本轮原图：${header.referenceName}`;
    referenceEl.title = entry.path;
    const failures = entryFailures(entry);
    // 有失败时徽标本身是入口：不展开编辑区也能点开看原因（与列表里的失败徽标同一张卡片）。
    // 没失败就走原来的死徽标，避免给出一个点开什么都没有的假入口。
    const badgeEl =
      failures.length > 0
        ? failureBadge(
            entry,
            header.status,
            BADGE_KIND[verdict.state],
            failures.map((failure) => `${failure.encoderId}：${failure.reason}`).join(SEP),
          )
        : badge(header.status, BADGE_KIND[verdict.state]);
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
            ? `编码器目录加载失败：${loadError}。可重开这个变体重试。`
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
          {
            referencePath: entry.path,
            // 首条默认展开，其余默认收起；刚点「添加编码器」加出来的那条保持展开
            open: previous.get(card.id)?.get('card') ?? (index === 0 || index === freshCardIndex),
          },
        ),
      );
    });
    restoreOpenRegions(cardsBox, previous);
    freshCardIndex = null;
    cardsBox.append(
      el(
        'div',
        { class: 'enc-editor__actions' },
        button({
          label: '＋ 添加编码器',
          variant: 'secondary',
          size: 'sm',
          title: '给这个变体再加一条编码器配置（同一编码器可以重复添加，各自参数独立）',
          onClick: () => {
            if (!addEncoderCard(entry, specs)) return;
            freshCardIndex = entry.encoders.length - 1;
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

  // 连续输入（质量滑杆 / 文本）不重建卡片，只同步徽章；提交（change）时才通知宿主，
  // 让列表里的变体摘要与计数跟着变——否则改完参数回到列表还显示旧摘要（q75 → q40）。
  cardsBox.addEventListener('input', () => syncHead());
  cardsBox.addEventListener('change', () => {
    syncHead();
    deps.onChanged();
  });

  /** 外部状态变化（徽章判定 / 列表刷新）后同步头部；结构变化由卡片回调重建。 */
  const refresh = (): void => syncHead();

  // 目录异步拉取：失败只影响参数区
  void loadCatalog(deps)
    .then((loaded) => {
      specs.push(...loaded);
      loading = false;
      hintBox.textContent =
        loaded.length === 0 ? '' : '改动即时生效；点「开始跑分」才会写工作区。';
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
