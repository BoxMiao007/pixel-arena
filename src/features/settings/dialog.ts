// 设置对话框：居中弹出，左侧分区导航，底部「全部恢复默认」。
//
// 与旧面板的区别都在这几行结构里：
// - 不再是一条长滚动页：导航切分区，内容区自己滚，保存按钮不再是「一次冒险」；
// - 改动逐字段即时保存（分区各自调 ctx.save），底部只留一行「已保存 / 保存失败」；
// - 焦点捕获、Esc、焦点还原由 ui/overlay 的 openModal 负责，这里不重复实现；
// - 工具状态与下载任务在对话框之外（../download 是模块级任务），关掉对话框不打断下载。

import { defaultSettings } from '../../core/settings';
import { saveSettings } from '../../core/settings-save';
import { getState, setStatus, subscribe } from '../../core/store';
import { el } from '../../ui/dom';
import { confirm, openModal } from '../../ui/overlay';
import { button } from '../../ui/primitives';
import { toast } from '../../ui/toast';
import type { SectionModule, SettingsCtx } from './context';
import { attemptSave } from './fields';
import { DEFAULT_SECTION, SETTINGS_SECTIONS, defaultsImpact, type SectionId } from './model';
import { createAboutSection } from './sections/about';
import { createAppearanceSection } from './sections/appearance';
import { createEncodersSection } from './sections/encoders';
import { createFfmpegSection } from './sections/ffmpeg';
import { createRecordingSection } from './sections/recording';
import { createScoringSection } from './sections/scoring';
import { createToolsWatcher } from './tools';

/** 当前打开的设置对话框（单实例：命令与顶栏按钮可能同时触发）。 */
let active: { close: () => void } | null = null;

/** 打开设置对话框；已打开时忽略（焦点已经在对话框里）。 */
export function openSettings(): void {
  if (active) return;
  const boot = getState().settings;
  if (!boot) {
    setStatus('设置尚未加载完成，请稍后再试', { isError: true });
    return;
  }

  const tools = createToolsWatcher();

  const saveState = el('span', {
    class: 'settings__save-state',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const announce = (text: string, isError = false): void => {
    saveState.textContent = text;
    saveState.classList.toggle('is-error', isError);
  };

  const ctx: SettingsCtx = {
    settings: () => getState().settings ?? boot,
    /** 逐字段保存：结果在底部状态行回显，具体原因由各字段就地显示。 */
    save: async (patch) => {
      const error = await attemptSave(patch);
      announce(error === null ? '已保存' : '保存失败', error !== null);
      return error;
    },
    announce: (text) => announce(text),
    tools,
  };

  const sections = new Map<SectionId, SectionModule>([
    ['appearance', createAppearanceSection(ctx)],
    ['recording', createRecordingSection(ctx)],
    ['scoring', createScoringSection(ctx)],
    ['ffmpeg', createFfmpegSection(ctx)],
    ['encoders', createEncodersSection(ctx)],
    ['about', createAboutSection(ctx)],
  ]);

  // ---- 分区容器与导航 ----
  const panelScroll = el('div', { class: 'settings__panel' });
  const panels = new Map<SectionId, HTMLElement>();
  const navButtons = new Map<SectionId, HTMLButtonElement>();

  let current: SectionId | null = null;
  const show = (id: SectionId): void => {
    if (current === id) return;
    for (const [key, panel] of panels) panel.hidden = key !== id;
    for (const [key, buttonNode] of navButtons) {
      if (key === id) buttonNode.setAttribute('aria-current', 'page');
      else buttonNode.removeAttribute('aria-current');
    }
    current = id;
    panelScroll.scrollTop = 0;
    sections.get(id)?.activate?.();
  };

  const nav = el('nav', { class: 'settings__nav', attrs: { 'aria-label': '设置分区' } });
  for (const meta of SETTINGS_SECTIONS) {
    const section = sections.get(meta.id);
    if (!section) continue;
    const panel = el('div', { class: 'settings__pane', dataset: { pane: meta.id } }, section.node);
    panel.hidden = true;
    panels.set(meta.id, panel);
    panelScroll.append(panel);

    const navBtn = el('button', {
      class: 'settings__nav-item',
      text: meta.label,
      attrs: { type: 'button' },
      on: { click: () => show(meta.id) },
    });
    navButtons.set(meta.id, navBtn);
    nav.append(navBtn);
  }

  const root = el(
    'div',
    { class: 'settings' },
    nav,
    el('main', { class: 'settings__main' }, panelScroll),
  );

  // ---- 底部：保存态 + 恢复默认 ----
  const restoreBtn = button({
    label: '全部恢复默认',
    icon: 'refresh',
    size: 'sm',
    variant: 'quiet',
    title: '清空外部路径并恢复默认外观与跑分设置',
    onClick: () => void restoreDefaults(),
  });
  const footer = el('div', { class: 'settings__footer' }, saveState, restoreBtn);

  async function restoreDefaults(): Promise<void> {
    const settings = getState().settings;
    if (!settings) return;
    const accepted = await confirm({
      title: '恢复默认设置？',
      message: defaultsImpact(settings),
      confirmLabel: '恢复默认',
      danger: true,
    });
    if (!accepted) return;
    // 整份保存：重置的语义就是「全部字段一起回到默认」
    const saved = await saveSettings(defaultSettings());
    if (saved === null) {
      announce('恢复默认失败', true);
      return;
    }
    announce('已恢复默认设置');
    toast('已恢复默认设置', 'ok');
    tools.refresh();
  }

  // ---- 设置变化时同步各分区控件（不重建 DOM，也不打断正在编辑的输入） ----
  const unsubscribeStore = subscribe((state) => {
    if (!state.settings) return;
    for (const section of sections.values()) section.sync(state.settings);
  });

  let closed = false;
  function cleanup(): void {
    if (closed) return;
    closed = true;
    unsubscribeStore();
    for (const section of sections.values()) section.destroy?.();
    tools.destroy();
    active = null;
  }

  const modal = openModal({
    title: '设置',
    body: root,
    footer,
    // 只认右上角 X：点遮罩或按 Esc 都不关，避免误触把设置关掉。
    closeOnBackdrop: false,
    closeOnEscape: false,
    // 宽度交给浮层变量，样式表再用 min(720px, 100%) 收敛，窄窗不顶满。
    // 720px = 128px 导航 + 约 592px 内容；内容再窄（如 520）「关于」的库清单三列
    // 会把 BSD-3-Clause 折成两行，编码器行的路径输入框也只剩 ~250px。
    width: 720,
    onClose: cleanup,
  });
  active = {
    close: () => {
      void modal.close();
    },
  };

  // 首屏：先按当前设置对齐全部控件，再切到默认分区，最后发起一次工具探测
  for (const section of sections.values()) section.sync(ctx.settings());
  show(DEFAULT_SECTION);
  tools.refresh();
}
