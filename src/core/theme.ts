// 界面主题：浅色 / 深色 / 跟随系统，持久化在设置文件。
// 实际主题写在 <html> 的 data-theme 属性上，tokens.css 用 CSS 变量随属性切换；
// 画布底色由 CSS 变量承担（viewer/video 绘制时读 --canvas / --canvas-checker）。

export type ThemePref = 'light' | 'dark' | 'system';

/** 纯函数：用户偏好 → 实际主题。system 按系统深浅解析。 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

// 加载设置前的实际主题 = 现状深色（升级用户观感不变）
let current: 'light' | 'dark' = 'dark';

/** 把偏好应用到文档根（data-theme 属性）；system 按当前系统深浅解析。 */
export function applyTheme(pref: ThemePref): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  current = resolveTheme(pref, systemDark);
  document.documentElement.dataset.theme = current;
}

/** 当前实际主题（applyTheme 之后的值）。 */
export function currentTheme(): 'light' | 'dark' {
  return current;
}


