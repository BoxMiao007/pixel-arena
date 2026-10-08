// 设置面板（T23 设置中心，T29-2 扩展为集中管理页）：标题栏「设置」按钮打开的
// 覆盖层面板。决策 D15–D18（notes/T29-encoder-config.md）：
// - 扩展现有 overlay，非路由；新增 FFmpeg 区 / 编码器来源状态区 / 文件选择器 /
//   下载按钮 / 保存重置 / 关于区块；
// - 一键保存全部：所有改动先进草稿，点「保存」整体提交（后端归一 + 校验失败
//   整体回滚并显示中文原因；内存设置只在校验成功后替换，运行中任务不受影响）；
// - 重置 = 恢复默认值（清空外部路径、恢复默认并发/主题/目录）；
// - 「关于」固定在底部：项目信息 + 引用的库版本清单（版本读后端锁定清单，
//   库名 https 链接渲染为超链接，每项带开源协议文本）。
// 状态（内置/外部/未配置/不可用 + 探测版本）来自 settings_tool_status IPC，
// 打开面板与每次保存成功后刷新——设置改完即重查，改动对后续评测轮立即生效。

import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { applyTheme } from './theme';
import {
  defaultSettings,
  isSafeLibraryUrl,
  releasePageHref,
  sourceLabel,
  ENCODER_FIELDS,
  type AboutData,
  type ConflictPolicyPref,
  type EncoderOverrides,
  type ScoreConcurrencyPref,
  type SettingsData,
  type ThemePref,
  type ToolStatus,
} from './settings';

/** 设置面板对外依赖（main.ts 提供）：保存与改后的重渲染。 */
export interface SettingsUiHost {
  /** 整体保存；返回后端归一后的最新设置。失败 reject（中文错误）。 */
  save(next: SettingsData): Promise<SettingsData>;
  /** 保存成功后的界面刷新（主题变化需要重渲染画布）。 */
  onApplied(): void;
  /** 面板关闭后的回调（T29-4：主界面据其重查 FFmpeg 检测、刷新警告条）。 */
  onClosed?(): void;
}

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

/** 跑分并发度四档（T24）：标签按「一半逻辑核」的语义写，默认 1/2。 */
const SCORE_CONCURRENCY_OPTIONS: { value: ScoreConcurrencyPref; label: string }[] = [
  { value: 'quarter', label: '1/4 核心' },
  { value: 'half', label: '1/2 核心' },
  { value: 'threequarters', label: '3/4 核心' },
  { value: 'full', label: '全部核心' },
];

/** 文件名冲突策略两档（T30）：默认自动追加（现状行为），可选写入前弹窗询问。 */
const CONFLICT_POLICY_OPTIONS: { value: ConflictPolicyPref; label: string }[] = [
  { value: 'auto', label: '自动追加序号' },
  { value: 'ask', label: '询问（写入前弹窗）' },
];

/** 外链统一设置（发布页图标按钮、关于页仓库链接与库链接共用）：target="_blank"
 * 是 opener 插件拦截的前提——点击经插件转系统浏览器，不会在应用窗口内导航；
 * rel="noopener noreferrer" 兜底防 opener 泄露。 */
function setExternalTarget(link: HTMLAnchorElement): void {
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
}

/** 草稿深拷贝（嵌套的 encoderOverrides 一并复制，避免控件改到已保存设置）。 */
function cloneSettings(value: SettingsData): SettingsData {
  return {
    ...value,
    encoderOverrides: { ...value.encoderOverrides },
  };
}

/** 打开设置面板（每次从当前设置构建，关闭即销毁）。 */
export function openSettingsPanel(saved: SettingsData, host: SettingsUiHost): void {
  let draft = cloneSettings(saved);
  const statuses = new Map<string, ToolStatus>();

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  overlay.append(panel);

  const errorLine = document.createElement('p');
  errorLine.className = 'settings-error';

  // 关闭即销毁；T29-4：关闭后通知宿主（主界面重查 FFmpeg、刷新警告条）
  const close = (): void => {
    overlay.remove();
    host.onClosed?.();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // 回滚/重置时把全部控件值从草稿重刷（每个控件注册一个同步函数）
  const syncFns: (() => void)[] = [];
  const syncInputs = (): void => {
    for (const fn of syncFns) fn();
  };

  // 状态行渲染：徽标（来源 + 探测版本）+ 提示小字。statusLoadError 置位时
  // 各行显示「检测失败」（IPC 异常不阻塞设置编辑，重开面板或保存成功后重试）。
  // info（#45，编码器行专用）：有完整说明时行内只留版本号，说明进悬停气泡；
  // 无说明（如内置正常态）或异常/加载中时图标整隐。FFmpeg 行不传则维持行内全文。
  // ⓘ 图标收进徽标内部（#45 反馈）：徽标文案经 textContent 重写会连带清掉图标，
  // 统一走 setBadge 重写后补回；wrap 现在包裹徽标，隐藏只能按图标/气泡各自控制。
  let statusLoadError: string | null = null;
  const renderStatus = (
    status: ToolStatus | undefined,
    badge: HTMLElement,
    hint: HTMLElement,
    info?: { wrap: HTMLElement; bubble: HTMLElement; icon: HTMLElement },
  ): void => {
    const setBadge = (label: string, cls: string): void => {
      badge.textContent = label;
      badge.className = cls;
      if (info) badge.append(info.icon);
    };
    const setInfoVisible = (visible: boolean): void => {
      if (!info) return;
      info.icon.style.display = visible ? '' : 'none';
      // 气泡常态由 CSS :hover/:focus-within 接管；置 none 是为了无说明时
      // 连悬停也不弹（内联样式优先级高于 CSS 规则）
      info.bubble.style.display = visible ? '' : 'none';
    };
    if (statusLoadError) {
      setBadge('检测失败', 'settings-badge settings-badge-unavailable');
      hint.textContent = statusLoadError;
      setInfoVisible(false);
      return;
    }
    if (!status) {
      setBadge('检测中…', 'settings-badge');
      hint.textContent = '';
      setInfoVisible(false);
      return;
    }
    setBadge(sourceLabel(status.source), `settings-badge settings-badge-${status.source}`);
    const version = status.detectedVersion ?? status.builtinVersion;
    if (info && status.hint) {
      hint.textContent = version ?? '';
      info.bubble.textContent = status.hint;
      setInfoVisible(true);
    } else {
      hint.textContent = [version, status.hint].filter(Boolean).join(' · ');
      setInfoVisible(false);
    }
  };

  // 工具状态与设置保存联动：打开面板与每次保存成功后重查（改动立即生效）
  const statusRenderers: (() => void)[] = [];
  const refreshStatuses = async (): Promise<void> => {
    try {
      const list = await invoke<ToolStatus[]>('settings_tool_status');
      const next = new Map<string, ToolStatus>();
      for (const status of list) next.set(status.key, status);
      statuses.clear();
      for (const [key, status] of next) statuses.set(key, status);
      statusLoadError = null;
    } catch (err) {
      statusLoadError = String(err);
    }
    for (const fn of statusRenderers) fn();
  };

  // 一键保存全部（D16）：成功 → 同步已保存设置并刷新状态；失败 → 显示原因并整体回滚
  const commitAll = async (): Promise<void> => {
    try {
      const next = await host.save(cloneSettings(draft));
      Object.assign(saved, next);
      draft = cloneSettings(saved);
      errorLine.textContent = '';
      applyTheme(saved.theme); // 与已保存设置对齐（重置回滚时恢复原主题）
      host.onApplied();
      syncInputs();
      await refreshStatuses();
    } catch (err) {
      errorLine.textContent = String(err);
      draft = cloneSettings(saved);
      applyTheme(saved.theme);
      syncInputs();
    }
  };

  // ---------- 头部 ----------
  const head = document.createElement('div');
  head.className = 'settings-head';
  const title = document.createElement('h2');
  title.textContent = '设置';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-close';
  closeBtn.textContent = '×';
  closeBtn.title = '关闭设置';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);
  panel.append(head);

  // ---------- 常规 ----------
  const general = document.createElement('section');
  general.className = 'settings-section';
  const generalTitle = document.createElement('h3');
  generalTitle.textContent = '常规';
  general.append(generalTitle);

  // 记录状态开关（滑动开关外观见 style.css settings-switch，状态语义仍是原生 checkbox）
  const recordCheck = document.createElement('input');
  recordCheck.type = 'checkbox';
  recordCheck.className = 'settings-switch';
  const recordWrap = document.createElement('label');
  recordWrap.className = 'settings-check';
  const recordText = document.createElement('span');
  recordText.textContent = '记住上次状态（启动时恢复标签页、窗口大小与最近目录）';
  recordCheck.addEventListener('change', () => {
    draft.recordState = recordCheck.checked;
  });
  recordWrap.append(recordCheck, recordText);
  general.append(recordWrap);
  syncFns.push(() => {
    recordCheck.checked = draft.recordState;
  });

  // 界面主题（改动即时预览，落盘随「保存」）
  const themeLabel = document.createElement('span');
  themeLabel.className = 'settings-label';
  themeLabel.textContent = '界面主题';
  const themeSelect = document.createElement('select');
  for (const option of THEME_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    themeSelect.append(opt);
  }
  themeSelect.addEventListener('change', () => {
    draft.theme = themeSelect.value as ThemePref;
    applyTheme(draft.theme); // 所见即所得；保存失败回滚时恢复原主题
  });
  const themeRow = document.createElement('div');
  themeRow.className = 'settings-row';
  themeRow.append(themeLabel, themeSelect);
  general.append(themeRow);
  syncFns.push(() => {
    themeSelect.value = draft.theme;
  });

  // 跑分并发度（T24）：生效于图片与视频跑分（视频即同时打开的 ffmpeg 进程数）
  const concurrencyLabel = document.createElement('span');
  concurrencyLabel.className = 'settings-label';
  concurrencyLabel.textContent = '跑分并发度';
  const concurrencySelect = document.createElement('select');
  for (const option of SCORE_CONCURRENCY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    concurrencySelect.append(opt);
  }
  concurrencySelect.addEventListener('change', () => {
    draft.scoreConcurrency = concurrencySelect.value as ScoreConcurrencyPref;
  });
  const concurrencyRow = document.createElement('div');
  concurrencyRow.className = 'settings-row';
  concurrencyRow.append(concurrencyLabel, concurrencySelect);
  general.append(concurrencyRow);
  syncFns.push(() => {
    concurrencySelect.value = draft.scoreConcurrency;
  });

  // 产物文件名冲突策略（T30）：auto = 现状行为不变，ask = 写入前弹窗拍板
  const conflictLabel = document.createElement('span');
  conflictLabel.className = 'settings-label';
  conflictLabel.textContent = '文件名冲突';
  const conflictSelect = document.createElement('select');
  for (const option of CONFLICT_POLICY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    conflictSelect.append(opt);
  }
  conflictSelect.title =
    '跑分产物与已有文件同名时的处理：自动在文件名后追加 _1/_2；或写入前弹窗询问，由你拍板覆盖还是跳过。';
  conflictSelect.addEventListener('change', () => {
    draft.conflictPolicy = conflictSelect.value as ConflictPolicyPref;
  });
  const conflictRow = document.createElement('div');
  conflictRow.className = 'settings-row';
  conflictRow.append(conflictLabel, conflictSelect);
  general.append(conflictRow);
  syncFns.push(() => {
    conflictSelect.value = draft.conflictPolicy;
  });

  // 默认导出目录
  const exportLabel = document.createElement('span');
  exportLabel.className = 'settings-label';
  exportLabel.textContent = '默认导出目录';
  const exportInput = document.createElement('input');
  exportInput.type = 'text';
  exportInput.className = 'settings-path';
  exportInput.placeholder = '未设置（使用系统默认位置）';
  exportInput.addEventListener('change', () => {
    draft.defaultExportDir = exportInput.value.trim() || null;
  });
  const browseBtn = document.createElement('button');
  browseBtn.className = 'settings-mini-btn';
  browseBtn.textContent = '浏览…';
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const selected = await open({ title: '选择默认导出目录', directory: true });
      if (typeof selected !== 'string') return;
      exportInput.value = selected;
      exportInput.title = selected;
      draft.defaultExportDir = selected;
    })();
  });
  const clearExportBtn = document.createElement('button');
  clearExportBtn.className = 'settings-mini-btn';
  clearExportBtn.textContent = '清空';
  clearExportBtn.addEventListener('click', () => {
    exportInput.value = '';
    exportInput.title = '';
    draft.defaultExportDir = null;
  });
  const exportRow = document.createElement('div');
  exportRow.className = 'settings-row';
  exportRow.append(exportLabel, exportInput, browseBtn, clearExportBtn);
  general.append(exportRow);
  syncFns.push(() => {
    exportInput.value = draft.defaultExportDir ?? '';
    exportInput.title = draft.defaultExportDir ?? '';
  });
  panel.append(general);

  // ---------- FFmpeg（T29-2，决策 D1/D4） ----------
  const ffmpegSection = document.createElement('section');
  ffmpegSection.className = 'settings-section';
  const ffmpegTitle = document.createElement('h3');
  ffmpegTitle.textContent = 'FFmpeg（视频跑分）';
  const ffmpegHint = document.createElement('p');
  ffmpegHint.className = 'settings-hint';
  ffmpegHint.textContent =
    '视频跑分依赖含 libvmaf 的 ffmpeg，应用不自动下载。留空使用内置版本（需先在下方「应用内下载」安装）；' +
    '也可手动指定本机已有的可执行文件（保存时校验存在、可执行且版本可读）。';
  ffmpegSection.append(ffmpegTitle, ffmpegHint);

  const ffmpegStatusLine = document.createElement('div');
  ffmpegStatusLine.className = 'settings-status';
  const ffmpegBadge = document.createElement('span');
  ffmpegBadge.className = 'settings-badge';
  const ffmpegStatusHint = document.createElement('span');
  ffmpegStatusHint.className = 'settings-status-hint';
  ffmpegStatusLine.append(ffmpegBadge, ffmpegStatusHint);
  ffmpegSection.append(ffmpegStatusLine);
  statusRenderers.push(() => {
    renderStatus(statuses.get('ffmpeg'), ffmpegBadge, ffmpegStatusHint);
  });

  const ffmpegLabel = document.createElement('span');
  ffmpegLabel.className = 'settings-label';
  ffmpegLabel.textContent = 'FFmpeg 路径';
  const ffmpegInput = document.createElement('input');
  ffmpegInput.type = 'text';
  ffmpegInput.className = 'settings-path';
  ffmpegInput.placeholder = '内置（应用内下载）';
  ffmpegInput.addEventListener('change', () => {
    draft.ffmpegPath = ffmpegInput.value.trim() || null;
  });
  const ffmpegBrowse = document.createElement('button');
  ffmpegBrowse.className = 'settings-mini-btn';
  ffmpegBrowse.textContent = '浏览…';
  ffmpegBrowse.addEventListener('click', () => {
    void (async () => {
      const selected = await open({ title: '选择 ffmpeg 可执行文件', directory: false });
      if (typeof selected !== 'string') return;
      ffmpegInput.value = selected;
      ffmpegInput.title = selected;
      draft.ffmpegPath = selected;
    })();
  });
  const ffmpegClear = document.createElement('button');
  ffmpegClear.className = 'settings-mini-btn';
  ffmpegClear.textContent = '清空';
  ffmpegClear.addEventListener('click', () => {
    ffmpegInput.value = '';
    ffmpegInput.title = '';
    draft.ffmpegPath = null;
  });
  // 应用内下载（T29-4：下载入口仅设置页）：锁定版本源装进 tools/，进度走状态行
  const ffmpegDownload = document.createElement('button');
  ffmpegDownload.className = 'settings-mini-btn';
  ffmpegDownload.textContent = '应用内下载';
  ffmpegDownload.title = '下载锁定版本的内置 ffmpeg 到应用数据目录（一次性，约 40MB）';
  ffmpegDownload.addEventListener('click', () => {
    void (async () => {
      ffmpegDownload.disabled = true;
      ffmpegStatusHint.textContent = '准备下载…';
      try {
        const channel = new Channel<string>();
        channel.onmessage = (message) => {
          ffmpegStatusHint.textContent = message;
        };
        await invoke('ffmpeg_download', { onProgress: channel });
        await refreshStatuses();
      } catch (err) {
        ffmpegStatusHint.textContent = `下载失败: ${String(err)}`;
      } finally {
        ffmpegDownload.disabled = false;
      }
    })();
  });
  const ffmpegRow = document.createElement('div');
  ffmpegRow.className = 'settings-row';
  ffmpegRow.append(ffmpegLabel, ffmpegInput, ffmpegBrowse, ffmpegClear, ffmpegDownload);
  ffmpegSection.append(ffmpegRow);
  syncFns.push(() => {
    ffmpegInput.value = draft.ffmpegPath ?? '';
    ffmpegInput.title = draft.ffmpegPath ?? '';
  });
  panel.append(ffmpegSection);

  // ---------- 编码器（T29-2：路径覆盖 + 来源状态） ----------
  const encoder = document.createElement('section');
  encoder.className = 'settings-section';
  const encoderTitle = document.createElement('h3');
  encoderTitle.textContent = '编码器';
  const encoderHint = document.createElement('p');
  encoderHint.className = 'settings-hint';
  encoderHint.textContent =
    '留空使用内置编码器（安装包已捆绑，标「内置 + 版本号」；捆绑缺失时不会自动下载，' +
    '请从各条目的「官方发布页」下载后把可执行文件路径填到下方输入框接入）。' +
    '设置外部路径且有效时优先使用。保存后修改对后续新建评测轮立即生效，运行中的任务不受影响。';
  encoder.append(encoderTitle, encoderHint);

  for (const field of ENCODER_FIELDS) {
    const statusLine = document.createElement('div');
    statusLine.className = 'settings-status settings-status-indented';
    const badge = document.createElement('span');
    badge.className = 'settings-badge';
    const lineHint = document.createElement('span');
    lineHint.className = 'settings-status-hint';
    // 「官方发布页」图标按钮（决策 0025；v0.1.4 反馈由文本链接改图标）：地址来自后端
    // 锁定清单（release_page 单一数据源，与核心库缺失报错、关于页库链接同源），渲染前过
    // isSafeLibraryUrl 白名单——非 https 时不设 href 并转禁用态。
    // #45 反馈：按钮排到「清空」后面（与路径框同行），不再放状态行。
    const releaseLink = document.createElement('a');
    releaseLink.className = 'settings-icon-btn';
    releaseLink.title = '从编码器官方发布页下载可执行文件，保存后在左侧路径框指定其路径';
    releaseLink.setAttribute('aria-label', '官方发布页');
    setExternalTarget(releaseLink);
    releaseLink.append(externalLinkIcon());
    // 详文气泡（#45）：状态行只留版本号，完整说明悬停/聚焦「圆圈叹号」图标时
    // 气泡展开；ⓘ 图标收进「未配置」徽标内部（#45 反馈），气泡锚定包裹徽标的
    // wrap；图标是否显示由 renderStatus 按有无说明控制，FFmpeg 行不走此机制
    const infoBubble = document.createElement('span');
    infoBubble.className = 'settings-bubble';
    const infoIcon = document.createElement('span');
    infoIcon.className = 'settings-status-info-icon';
    infoIcon.setAttribute('role', 'img');
    infoIcon.setAttribute('aria-label', '状态详情');
    infoIcon.setAttribute('tabindex', '0');
    infoIcon.append(infoIconSvg());
    const infoWrap = document.createElement('span');
    infoWrap.className = 'settings-status-info';
    infoWrap.append(badge, infoBubble);
    badge.append(infoIcon);
    statusLine.append(infoWrap, lineHint);
    const info = { wrap: infoWrap, bubble: infoBubble, icon: infoIcon };
    statusRenderers.push(() => {
      renderStatus(statuses.get(field.key), badge, lineHint, info);
      const href = statuses.has(field.key) ? releasePageHref(statuses.get(field.key)!) : null;
      if (href) {
        releaseLink.href = href;
        releaseLink.removeAttribute('aria-disabled');
      } else {
        releaseLink.removeAttribute('href');
        releaseLink.setAttribute('aria-disabled', 'true');
      }
    });

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = field.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-path';
    input.placeholder = '内置';
    input.addEventListener('change', () => {
      draft.encoderOverrides = {
        ...draft.encoderOverrides,
        [field.key]: input.value.trim() || null,
      } as EncoderOverrides;
    });
    const browse = document.createElement('button');
    browse.className = 'settings-mini-btn';
    browse.textContent = '浏览…';
    browse.addEventListener('click', () => {
      void (async () => {
        const selected = await open({
          title: `选择 ${field.label} 可执行文件`,
          directory: false,
        });
        if (typeof selected !== 'string') return;
        input.value = selected;
        input.title = selected;
        draft.encoderOverrides = {
          ...draft.encoderOverrides,
          [field.key]: selected,
        } as EncoderOverrides;
      })();
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'settings-mini-btn';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      input.value = '';
      input.title = '';
      draft.encoderOverrides = {
        ...draft.encoderOverrides,
        [field.key]: null,
      } as EncoderOverrides;
    });
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.append(label, input, browse, clearBtn, releaseLink);
    encoder.append(statusLine, row);
    syncFns.push(() => {
      input.value = draft.encoderOverrides[field.key] ?? '';
      input.title = draft.encoderOverrides[field.key] ?? '';
    });
  }
  panel.append(encoder);

  // ---------- 保存 / 重置（D16/D17：一键保存全部；失败整体回滚并显示原因） ----------
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'settings-primary-btn';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    void (async () => {
      // pending 态（issue #42）：保存可能跑外部 ffmpeg 路径探测（后端 5s 有界超时），
      // 期间禁用 + 文案反馈，避免界面像假死；完成/失败后恢复，结果仍由 commitAll
      // 按既有逻辑显示（成功清空错误行并刷新状态，失败显示中文原因）
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        await commitAll();
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    })();
  });
  const resetBtn = document.createElement('button');
  resetBtn.className = 'settings-mini-btn';
  resetBtn.textContent = '恢复默认';
  resetBtn.title = '清空全部外部路径，恢复默认并发 / 主题 / 目录';
  resetBtn.addEventListener('click', () => {
    void (async () => {
      draft = defaultSettings();
      applyTheme(draft.theme); // 默认深色立即生效
      syncInputs();
      await commitAll();
    })();
  });
  actions.append(saveBtn, resetBtn);
  panel.append(errorLine);
  panel.append(actions);

  // ---------- 关于（固定底部，T29-2） ----------
  const about = document.createElement('section');
  about.className = 'settings-section settings-about';
  const aboutTitle = document.createElement('h3');
  aboutTitle.textContent = '关于';
  about.append(aboutTitle);
  const aboutBody = document.createElement('div');
  aboutBody.className = 'settings-about-body';
  aboutBody.textContent = '加载中…';
  about.append(aboutBody);
  panel.append(about);

  void (async () => {
    try {
      const info = await invoke<AboutData>('about_info');
      aboutBody.replaceChildren(...renderAbout(info));
    } catch (err) {
      aboutBody.textContent = `加载「关于」信息失败: ${String(err)}`;
    }
  })();

  document.body.append(overlay);
  // 初次按草稿同步全部控件值（select 的 DOM 默认停在首选项，必须显式对齐当前设置）
  syncInputs();
  void refreshStatuses();
}

/** 渲染「关于」正文：项目信息行 + 库版本清单（库名 https 链接渲染为超链接，
 *  每项附版本与开源协议文本，协议读后端锁定清单）。 */
function renderAbout(info: AboutData): Node[] {
  const nodes: Node[] = [];
  const headLine = document.createElement('p');
  headLine.className = 'settings-about-name';
  const strong = document.createElement('strong');
  strong.textContent = info.appName;
  headLine.append(
    strong,
    document.createTextNode(
      ` v${info.appVersion}（核心库 v${info.coreVersion}）`,
    ),
  );
  nodes.push(headLine);

  const intro = document.createElement('p');
  intro.textContent = info.intro;
  nodes.push(intro);

  const meta = document.createElement('p');
  meta.className = 'settings-about-meta';
  const licenseLabel = document.createElement('span');
  licenseLabel.textContent = `许可证：${info.license}`;
  // repoUrl 与库链接同走 isSafeLibraryUrl 白名单（后端常量可信，保持渲染口径一致）
  if (isSafeLibraryUrl(info.repoUrl)) {
    const repoLink = document.createElement('a');
    repoLink.href = info.repoUrl;
    repoLink.textContent = '仓库主页';
    repoLink.className = 'settings-link';
    setExternalTarget(repoLink);
    meta.append(licenseLabel, document.createTextNode(' · '), repoLink);
  } else {
    meta.append(licenseLabel, document.createTextNode(' · 仓库主页'));
  }
  nodes.push(meta);

  const libTitle = document.createElement('p');
  libTitle.className = 'settings-about-meta';
  libTitle.textContent = '引用的库（版本来自构建锁定清单）：';
  nodes.push(libTitle);
  const list = document.createElement('ul');
  list.className = 'settings-libraries';
  for (const lib of info.libraries) {
    const item = document.createElement('li');
    if (isSafeLibraryUrl(lib.url)) {
      const link = document.createElement('a');
      link.href = lib.url;
      link.textContent = lib.name;
      link.className = 'settings-link';
      setExternalTarget(link);
      item.append(link);
    } else {
      item.append(document.createTextNode(lib.name));
    }
    item.append(document.createTextNode(` ${lib.version} · 许可证：${lib.license}`));
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

// 「官方发布页」图标按钮的内联 SVG（feather external-link 造型）。项目零图标依赖，
// 手绘 24×24 描边图形，描边色随 currentColor 走主题变量
function externalLinkIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'M15 3h6v6',
    'M10 14L21 3',
  ]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// 状态详文气泡的「圆圈叹号」图标（#45）。与 externalLinkIcon 同理零依赖手绘，
// 叹号圆圈造型对「未配置/不可用」状态语义比 ⓘ 更贴近。
// 顶栏状态详文气泡（长状态截断时）也复用同款图标，故导出。
export function infoIconSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  const bar = document.createElementNS(NS, 'path');
  bar.setAttribute('d', 'M12 7v6');
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', '12');
  dot.setAttribute('cy', '16.5');
  dot.setAttribute('r', '1.2');
  dot.setAttribute('fill', 'currentColor');
  dot.setAttribute('stroke', 'none');
  svg.append(circle, bar, dot);
  return svg;
}
