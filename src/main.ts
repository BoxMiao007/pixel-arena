// 前端入口：先加载设置（主题不闪、界面偏好按「记录状态」门控），再装配外壳，
// 最后异步加载工作区 / 版本 / FFmpeg 状态。任何一步失败都只影响对应区域，
// 界面保持可用（空态 + 状态栏中文原因）。

import './styles/index.css';

import { ipc } from './core/ipc';
import { getState, setCoreVersion, setSettings, setStatus, setWorkspace } from './core/store';
import { applyTheme } from './core/theme';
import { refreshFfmpeg } from './core/ffmpeg';
import { bootApp } from './shell/app';
import { requestRender } from './shell/controller';

// 功能域按副作用注册舞台视图 / 检视器分区 / 结果坞页签 / 命令；
// 必须在 bootApp 之前导入完成。
import './features/viewer';
import './features/results';
import './features/encoding';
import './features/video';
import './features/settings';
import './shell/help';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('缺少 #app 挂载点');

  // 1) 设置优先：主题与界面偏好在首帧前就位
  try {
    const settings = await ipc.settingsLoad();
    setSettings(settings);
    applyTheme(settings.theme);
  } catch (err) {
    setStatus(`加载设置失败：${errorText(err)}`, {
      isError: true,
      detail: errorText(err),
    });
  }

  // 跟随系统主题：只有用户选了「跟随系统」才重解析
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getState().settings?.theme === 'system') {
      applyTheme('system');
      requestRender();
    }
  });

  // 2) 外壳（空态可交互，工作区随后填充）
  bootApp(root);

  // 3) 工作区
  try {
    const workspace = await ipc.workspaceLoad();
    setWorkspace(workspace, { markSaved: false });
  } catch (err) {
    setStatus(`恢复工作区失败：${errorText(err)}`, {
      isError: true,
      detail: errorText(err),
    });
  }

  // 4) 版本与 FFmpeg（不阻塞界面）
  void ipc
    .coreVersion()
    .then((version) => setCoreVersion(version))
    .catch((err) => console.warn('读取核心库版本失败:', err));
  void refreshFfmpeg();
}

void boot();
