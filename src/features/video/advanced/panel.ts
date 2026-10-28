// 视频高级创建面板：选原视频与编码器 → 逐项配参数 → 命令行预览 → 校验 → 建轮。
//
// 入口：检视器「高级」分区的按钮经命令 advanced-video-create 打开本面板。
// 行为与旧实现（main 分支 src/advanced-ui.ts 的 kind:'video' 分支）一致：
// - 编码器来自 advanced_video_catalog（四条静态映射 + ffmpeg -encoders 枚举）；
// - 每张卡由 ui/encoder-card.ts 的 renderEncoderCard 渲染（视频目录传 imageSpecs: []）；
// - 确认前汇总校验参数与 advanced_encoder_status 的编码器可用性，坏参数不建轮；
// - 确认后新建评测轮并**自动激活**，配置摘要与每项命令行写进 round.note；
// - 本版本不做视频自动编码，文案如实说明可复制命令行自行编码后用「添加跑分视频」导入。
//
// 会话态按组 id 存在 catalog.ts 的模块 Map：关面板不丢已填配置，重启归零；创建
// 成功后丢弃。面板关闭/重开、切标签都不影响已填内容。

import { nextRoundName, pickFile } from '../../../core/actions';
import { ipc } from '../../../core/ipc';
import { getState, isBusy, setStatus, setWorkspace } from '../../../core/store';
import { copyText, errorText, fileName } from '../../../core/util';
import { DROP_EXTENSIONS } from '../../../shell/file-drop';
import { requestRender } from '../../../shell/controller';
import { el } from '../../../ui/dom';
import { button } from '../../../ui/primitives';
import { openModal } from '../../../ui/overlay';
import { renderEncoderCard, type EncoderCardCatalog } from '../../../ui/encoder-card';
import { toast } from '../../../ui/toast';
import {
  FALLBACK_VIDEO_SPEC,
  addEntry,
  dropSession,
  entryLabel,
  moveEntry,
  removeEntry,
  sessionFor,
  videoSpec,
  type AdvancedVideoCatalog,
} from './catalog';
import { availabilityErrors, validateEntry } from './command';
import { buildVideoNote } from './note';
import { videoIpc } from '../video-ipc';

/** 同一时刻只允许一个高级创建面板（重复触发命令不叠加浮层）。 */
let openGroupId: string | null = null;

/** 视频文件对话框白名单（与拖放/选片同一口径）。 */
const VIDEO_FILTER = {
  name: '视频（MP4 / MKV / WebM 等）',
  extensions: [...DROP_EXTENSIONS.video],
};

/**
 * 打开视频高级创建面板。groupId / roundId 为当前激活的视频组与轮：本轮已选原视频
 * 时预填进会话（命令行预览用），之后可在面板里重选。
 */
export function openAdvancedVideoPanel(groupId: string, roundId: string): void {
  if (openGroupId !== null) return;
  const group = getState().workspace?.groups.find((item) => item.id === groupId);
  if (!group || group.kind !== 'video') return;
  openGroupId = groupId;

  const session = sessionFor(groupId);
  // 预填原视频：本轮已选原视频时直接沿用（只在会话还没有值时填，关面板重开不覆盖）
  if (session.referencePath === null) {
    const round = group.rounds.find((item) => item.id === roundId);
    session.referencePath = round?.videoReferencePath ?? null;
  }

  let disposed = false;
  let catalog: AdvancedVideoCatalog | null = null;
  let catalogError: string | null = null;
  /** 已创建的轮（建轮成功但写备注/激活失败时复用，避免重复建轮留下空轮）。 */
  let created: { groupId: string; roundId: string } | null = null;
  let creating = false;

  /** 传给共享卡片的目录：图片规格表按「视频组不用」传空数组。 */
  const cardCatalog = (): EncoderCardCatalog => ({
    kind: 'video',
    imageSpecs: [],
    videoCatalog: catalog
      ? { specs: catalog.specs, encoderNames: catalog.encoderNames }
      : null,
  });

  // ---------- 静态骨架 ----------
  const body = el('div', { class: 'adv-video' });
  const hint = el('p', {
    class: 'adv-video__hint',
    text:
      '选择原视频与视频编码器，逐项配置参数并预览命令行。确认后新建评测轮并自动激活，' +
      '本轮的配置摘要与每项命令行写进轮备注。本版本不做视频自动编码；可复制命令行自行' +
      '编码后用「添加跑分视频」导入。',
  });
  const status = el('p', { class: 'adv-video__status', text: '正在读取编码器目录…' });
  const refRow = el('div', { class: 'adv-video__ref' });
  const entriesBox = el('div', { class: 'adv-video__entries' });

  const errorBox = el('div', { class: 'adv-video__error' });
  const errorTextNode = el('p', { class: 'adv-video__error-text' });
  const retryButton = button({
    label: '重试',
    size: 'sm',
    variant: 'secondary',
    onClick: () => void runCreate(),
  });
  errorBox.append(errorTextNode, retryButton);
  errorBox.hidden = true;

  body.append(hint, status, refRow, entriesBox, errorBox);

  const addButton = button({
    label: '＋ 添加编码器',
    variant: 'secondary',
    size: 'sm',
    title: '把一个编码器加入本次高级创建（同一编码器可添加多次，各自参数独立）',
    onClick: () => addEncoderEntry(),
  });
  const createButton = button({
    label: '创建评测轮',
    variant: 'primary',
    title: '校验参数与编码器可用性后，新建并激活一轮评测，把配置写进轮备注',
    onClick: () => void runCreate(),
  });
  const createLabel = createButton.querySelector('.btn__label');
  const actions = el(
    'div',
    { class: 'adv-video__actions' },
    el('span', { class: 'adv-video__spacer' }),
    addButton,
    createButton,
  );

  // ---------- 报错与动作可用性 ----------
  const clearError = (): void => {
    errorBox.hidden = true;
    errorTextNode.textContent = '';
    errorTextNode.title = '';
    retryButton.hidden = true;
  };

  const showError = (message: string, withRetry: boolean): void => {
    errorTextNode.textContent = message;
    errorTextNode.title = message;
    retryButton.hidden = !withRetry;
    errorBox.hidden = false;
  };

  const setActionsBusy = (busy: boolean): void => {
    addButton.disabled = busy;
    createButton.disabled = busy || isBusy();
    createButton.title = isBusy()
      ? '有任务正在运行，完成后再创建评测轮'
      : '校验参数与编码器可用性后，新建并激活一轮评测，把配置写进轮备注';
    if (createLabel) createLabel.textContent = busy ? '创建中…' : '创建评测轮';
  };
  setActionsBusy(false);

  // ---------- 原视频（命令行预览的输入） ----------
  const chooseReference = async (): Promise<void> => {
    if (isBusy()) return;
    const path = await pickFile({ title: '选择高级创建用的原视频', filters: [VIDEO_FILTER] });
    if (!path || disposed) return;
    session.referencePath = path;
    renderReference();
    renderEntries();
  };

  const renderReference = (): void => {
    const path = session.referencePath;
    refRow.replaceChildren(
      el('span', { class: 'adv-video__ref-label', text: '原视频' }),
      el('span', {
        class: 'adv-video__ref-value',
        text: path ? fileName(path) : '未选择（命令行预览用占位）',
        title: path ?? '未选择原视频：命令行预览里用 <原图> 占位',
      }),
      button({
        label: path ? '重选原视频' : '选择原视频',
        variant: 'secondary',
        size: 'sm',
        icon: 'folder',
        disabled: isBusy(),
        title: '选择命令行预览用的原视频（不会改动当前评测轮）',
        onClick: () => void chooseReference(),
      }),
    );
  };

  // ---------- 条目渲染（整卡重建出口，卡片本身由 encoder-card 共享渲染） ----------
  /** 编码器可执行文件不可用的条目（建轮前置校验）：entryId → 错误文本，卡片红标。 */
  const unavailableEntries = new Map<string, string>();

  const renderEntries = (): void => {
    if (disposed) return;
    // 高级参数 / 命令行预览都是可折叠区（分别是 div 与 details），整卡重建会被
    // 打回默认态。开合状态按条目 id（而非序号）键控：删除非末位条目时其余条目
    // 序号前移，按序回写会错配。两类折叠区按 data-adv-region 区分。
    const prevOpen = new Map<string, Map<string, boolean>>();
    for (const card of entriesBox.querySelectorAll<HTMLElement>('.enc-card')) {
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
      prevOpen.set(id, openByRegion);
    }

    entriesBox.replaceChildren();
    if (session.entries.length === 0) {
      entriesBox.append(
        el('p', {
          class: 'adv-video__empty',
          text: '还没有编码器条目，点下方「＋ 添加编码器」开始配置。',
        }),
      );
      return;
    }

    const catalogNow = cardCatalog();
    session.entries.forEach((entry, index) => {
      const card = renderEncoderCard(
        entry,
        index,
        catalogNow,
        {
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
          onCopy: (text) => copyText(text, () => toast('已复制命令行', 'ok')),
        },
        {
          referencePath: session.referencePath,
          unavailableError: unavailableEntries.get(entry.id) ?? null,
        },
      );
      entriesBox.append(card);
    });

    // 回写折叠态：新加条目查不到，保持卡片默认（高级参数展开、命令行预览收起）
    for (const card of entriesBox.querySelectorAll<HTMLElement>('.enc-card')) {
      const openByRegion = prevOpen.get(card.dataset.entryId ?? '');
      if (!openByRegion) continue;
      for (const region of card.querySelectorAll<HTMLElement>('[data-adv-region]')) {
        const open = openByRegion.get(region.dataset.advRegion ?? '');
        if (open === undefined) continue;
        if (region instanceof HTMLDetailsElement) {
          region.open = open;
        } else {
          region.dataset.open = String(open);
          const regionBody = region.querySelector<HTMLElement>('.enc-card__region-body');
          if (regionBody) regionBody.hidden = !open;
          const toggle = region.querySelector<HTMLButtonElement>('.enc-card__region-btn');
          toggle?.setAttribute('aria-expanded', String(open));
          toggle?.querySelector('.enc-card__chevron')?.classList.toggle('is-flipped', !open);
        }
      }
    }
  };

  const addEncoderEntry = (): void => {
    const first = catalog?.specs[0];
    if (first) addEntry(session, first.ffmpegName, first);
    else addEntry(session, 'libx264', FALLBACK_VIDEO_SPEC);
    renderEntries();
  };

  // ---------- 校验与建轮 ----------
  const validateAll = (): string[] => {
    const errors: string[] = [];
    if (session.entries.length === 0) {
      errors.push('请至少添加一个编码器条目');
    }
    session.entries.forEach((entry, index) => {
      const spec = videoSpec(catalog, entry.encoderId);
      for (const message of validateEntry(spec, entry)) {
        errors.push(
          `第 ${index + 1} 项（${entryLabel(catalog, entry.encoderId)}）：${message}`,
        );
      }
    });
    return errors;
  };

  async function createRoundFor(id: string): Promise<{ groupId: string; roundId: string }> {
    const current = getState().workspace?.groups.find((item) => item.id === id);
    if (!current) throw new Error('跑分组不存在或已被关闭');
    const before = new Set(current.rounds.map((round) => round.id));
    const name = nextRoundName(current);
    const workspace = await ipc.roundCreate(id, name);
    setWorkspace(workspace);
    const updated = workspace.groups.find((item) => item.id === id);
    const round = updated?.rounds.find((item) => !before.has(item.id));
    if (!round) throw new Error('无法定位新建的评测轮');
    return { groupId: id, roundId: round.id };
  }

  const runCreate = async (): Promise<void> => {
    if (creating || disposed) return;
    if (isBusy()) {
      showError('有任务正在运行，完成后再创建评测轮', false);
      return;
    }
    const errors = validateAll();
    if (errors.length > 0) {
      showError(errors.join('；'), false);
      return;
    }
    clearError();
    creating = true;
    setActionsBusy(true);
    try {
      // 建轮前批量校验编码器可执行文件（视频条目统一依赖 ffmpeg；unavailable 拦下，
      // ffmpeg 的 unconfigured 放行——它的就位方式是设置页「应用内下载」）。
      const statuses = await videoIpc.advancedEncoderStatus(['ffmpeg']);
      const available = availabilityErrors(session.entries, () => 'ffmpeg', statuses);
      if (available.size > 0) {
        unavailableEntries.clear();
        const summaries: string[] = [];
        session.entries.forEach((entry, index) => {
          const message = available.get(entry.id);
          if (message === undefined) return;
          unavailableEntries.set(entry.id, message);
          summaries.push(
            `第 ${index + 1} 项（${entryLabel(catalog, entry.encoderId)}）：${message}`,
          );
        });
        renderEntries();
        showError(summaries.join('；'), false);
        return;
      }
      unavailableEntries.clear();

      // 顺序：建轮 → 写备注 → 激活。备注在激活前写入，新轮一挂上检视器就能看到；
      // 若中途失败，created 已记下，重试不会重复建轮。
      if (!created) created = await createRoundFor(groupId);
      const note = buildVideoNote(catalog, session);
      const withNote = await ipc.roundSetNote(created.groupId, created.roundId, note);
      setWorkspace(withNote);
      const activated = await ipc.roundActivate(created.groupId, created.roundId);
      setWorkspace(activated);

      const total = session.entries.length;
      dropSession(groupId);
      setStatus(
        `评测轮已创建（共 ${total} 项配置）。本版本不做视频自动编码；` +
          '可复制命令行自行编码后用「添加跑分视频」导入。',
      );
      toast(`评测轮已创建（共 ${total} 项配置）`, 'ok');
      modal.close();
    } catch (err) {
      showError(`创建失败：${errorText(err)}`, true);
    } finally {
      creating = false;
      if (!disposed) setActionsBusy(false);
    }
  };

  // ---------- 目录拉取（视频规格 + ffmpeg 枚举） ----------
  const ensureDefaultEntry = (): void => {
    if (session.entries.length > 0) return;
    const first = catalog?.specs[0];
    if (first) addEntry(session, first.ffmpegName, first);
    else addEntry(session, 'libx264', FALLBACK_VIDEO_SPEC);
    renderEntries();
  };

  // ---------- 挂载 ----------
  const modal = openModal({
    title: '高级创建（视频）',
    body,
    footer: actions,
    width: 760,
    onClose: () => {
      disposed = true;
      openGroupId = null;
      // 面板里的配置改动只落在会话态；关面板后让检视器刷新一次「已有 N 条配置」。
      requestRender();
    },
  });

  renderReference();
  renderEntries();

  void (async () => {
    try {
      catalog = await videoIpc.advancedVideoCatalog();
      if (disposed) return;
      status.textContent = catalog.ffmpegAvailable
        ? `ffmpeg 就绪：${catalog.ffmpegPath ?? '已定位'}`
        : `ffmpeg 不可用（${catalog.ffmpegError ?? '未知原因'}）。可在设置页配置路径；编码器仍可选择并预览。`;
      status.classList.toggle('is-warn', !catalog.ffmpegAvailable);
    } catch (err) {
      if (disposed) return;
      catalogError = errorText(err);
      status.textContent =
        `编码器目录加载失败：${catalogError}。仍可用表外编码器（无推荐参数）配置；` +
        '关闭面板重开可重试。';
      status.classList.add('is-warn');
    }
    if (disposed) return;
    if (session.entries.length === 0) ensureDefaultEntry();
    else renderEntries();
  })();
}
