// 设置面板（T23 设置中心）：标题栏「设置」按钮打开的覆盖层面板。
// 四组项即改即存（每次改动整体调 settings_save，后端做空串归一 + 存在性校验），
// 失败把中文错误亮在面板底部并回滚该控件的显示值；成功后主题切换整页重渲染，
// 画布底色随之立即生效。面板挂在 body 下（内容区整页重渲染不波及）。

import { open } from '@tauri-apps/plugin-dialog';
import { applyTheme } from './theme';
import {
  ENCODER_FIELDS,
  type EncoderOverrides,
  type ScoreConcurrencyPref,
  type SettingsData,
  type ThemePref,
} from './settings';

/** 设置面板对外依赖（main.ts 提供）：保存与改后的重渲染。 */
export interface SettingsUiHost {
  /** 整体保存；返回后端归一后的最新设置。失败 reject（中文错误）。 */
  save(next: SettingsData): Promise<SettingsData>;
  /** 保存成功后的界面刷新（主题变化需要重渲染画布）。 */
  onApplied(): void;
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

/** 打开设置面板（每次从当前设置构建，关闭即销毁）。 */
export function openSettingsPanel(settings: SettingsData, host: SettingsUiHost): void {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  overlay.append(panel);

  const errorLine = document.createElement('p');
  errorLine.className = 'settings-error';

  const close = (): void => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // 保存的统一入口：成功后清错误行并刷新界面；失败显示错误并回滚控件
  const commit = async (next: SettingsData, revert: () => void): Promise<void> => {
    try {
      const saved = await host.save(next);
      errorLine.textContent = '';
      // 后端可能归一了值（如空串路径收成 null），同步回本地显示
      Object.assign(settings, saved);
      host.onApplied();
    } catch (err) {
      errorLine.textContent = String(err);
      revert();
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

  // 记录状态开关
  const recordCheck = document.createElement('input');
  recordCheck.type = 'checkbox';
  recordCheck.checked = settings.recordState;
  const recordWrap = document.createElement('label');
  recordWrap.className = 'settings-check';
  const recordText = document.createElement('span');
  recordText.textContent = '记住上次状态（启动时恢复标签页、窗口大小与最近目录）';
  recordCheck.addEventListener('change', () => {
    void commit({ ...settings, recordState: recordCheck.checked }, () => {
      recordCheck.checked = settings.recordState;
    });
  });
  recordWrap.append(recordCheck, recordText);
  general.append(recordWrap);

  // 界面主题
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
  themeSelect.value = settings.theme;
  themeSelect.addEventListener('change', () => {
    const pref = themeSelect.value as ThemePref;
    applyTheme(pref); // 先应用再保存：保存失败也保持所见（偏好属于可重试的轻量状态）
    void commit({ ...settings, theme: pref }, () => {
      themeSelect.value = settings.theme;
      applyTheme(settings.theme);
    });
  });
  const themeRow = document.createElement('div');
  themeRow.className = 'settings-row';
  themeRow.append(themeLabel, themeSelect);
  general.append(themeRow);

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
  concurrencySelect.value = settings.scoreConcurrency;
  concurrencySelect.addEventListener('change', () => {
    const tier = concurrencySelect.value as ScoreConcurrencyPref;
    void commit({ ...settings, scoreConcurrency: tier }, () => {
      concurrencySelect.value = settings.scoreConcurrency;
    });
  });
  const concurrencyRow = document.createElement('div');
  concurrencyRow.className = 'settings-row';
  concurrencyRow.append(concurrencyLabel, concurrencySelect);
  general.append(concurrencyRow);

  // 默认导出目录
  const exportLabel = document.createElement('span');
  exportLabel.className = 'settings-label';
  exportLabel.textContent = '默认导出目录';
  const exportInput = document.createElement('input');
  exportInput.type = 'text';
  exportInput.className = 'settings-path';
  exportInput.placeholder = '未设置（使用系统默认位置）';
  exportInput.value = settings.defaultExportDir ?? '';
  exportInput.title = exportInput.value;
  const browseBtn = document.createElement('button');
  browseBtn.className = 'settings-mini-btn';
  browseBtn.textContent = '浏览…';
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const selected = await open({ title: '选择默认导出目录', directory: true });
      if (typeof selected !== 'string') return;
      exportInput.value = selected;
      exportInput.title = selected;
      await commit({ ...settings, defaultExportDir: selected }, () => {
        exportInput.value = settings.defaultExportDir ?? '';
      });
    })();
  });
  const clearExportBtn = document.createElement('button');
  clearExportBtn.className = 'settings-mini-btn';
  clearExportBtn.textContent = '清空';
  clearExportBtn.addEventListener('click', () => {
    exportInput.value = '';
    exportInput.title = '';
    void commit({ ...settings, defaultExportDir: null }, () => {
      exportInput.value = settings.defaultExportDir ?? '';
    });
  });
  const exportRow = document.createElement('div');
  exportRow.className = 'settings-row';
  exportRow.append(exportLabel, exportInput, browseBtn, clearExportBtn);
  general.append(exportRow);
  panel.append(general);

  // ---------- 编码器（高级）----------
  const encoder = document.createElement('section');
  encoder.className = 'settings-section';
  const encoderTitle = document.createElement('h3');
  encoderTitle.textContent = '编码器（高级）';
  const encoderHint = document.createElement('p');
  encoderHint.className = 'settings-hint';
  encoderHint.textContent =
    '留空使用内置自动下载的编码器；自定义路径需指向对应的可执行文件，保存时校验存在。';
  encoder.append(encoderTitle, encoderHint);

  for (const field of ENCODER_FIELDS) {
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = field.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-path';
    input.placeholder = '内置';
    input.value = settings.encoderOverrides[field.key] ?? '';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'settings-mini-btn';
    clearBtn.textContent = '清空';
    const saveField = (raw: string): void => {
      const overrides: EncoderOverrides = { ...settings.encoderOverrides, [field.key]: raw };
      void commit({ ...settings, encoderOverrides: overrides }, () => {
        input.value = settings.encoderOverrides[field.key] ?? '';
      });
    };
    // 失焦或回车提交；Esc 还原
    input.addEventListener('change', () => saveField(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') {
        input.value = settings.encoderOverrides[field.key] ?? '';
      }
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      saveField('');
    });
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.append(label, input, clearBtn);
    encoder.append(row);
  }
  panel.append(encoder);
  panel.append(errorLine);
  document.body.append(overlay);
}
