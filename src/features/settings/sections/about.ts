// 关于分区：版本、许可证、引用的库清单、可复制的诊断信息。
//
// 懒加载：切到「关于」才发 about_info（打开设置窗口不需要等它）。库名只在后端给的是
// https 时渲染成链接（同 core/settings.isSafeLibraryUrl 的白名单口径）；诊断信息把
// 应用/核心库版本与六个工具的实际生效路径拼成纯文本，方便一次复制进问题反馈。

import { ipc } from '../../../core/ipc';
import { isSafeLibraryUrl, type AboutData, type SettingsData } from '../../../core/settings';
import { copyText } from '../../../core/util';
import { el } from '../../../ui/dom';
import { button, spinner } from '../../../ui/primitives';
import { toast } from '../../../ui/toast';
import type { SectionModule, SettingsCtx } from '../context';
import { diagnosticsText, licenseShort } from '../model';

/** 外链：只由 https 地址进入（target=_blank 交给 opener 插件转系统浏览器）。 */
function externalLink(href: string, text: string): HTMLAnchorElement {
  return el('a', {
    class: 'settings__link',
    text,
    attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
  });
}

export function createAboutSection(ctx: SettingsCtx): SectionModule {
  const content = el('div', { class: 'settings__group' });
  const errorLine = el('p', {
    class: 'settings__notice is-error',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  errorLine.hidden = true;
  const retryBtn = button({
    label: '重试',
    size: 'sm',
    variant: 'quiet',
    onClick: () => void load(),
  });
  retryBtn.hidden = true;

  const node = el('div', { class: 'settings__group' }, content, errorLine, retryBtn);

  let about: AboutData | null = null;
  let loading = false;

  const copyButton = (): HTMLElement =>
    button({
      label: '复制诊断信息',
      icon: 'copy',
      size: 'sm',
      variant: 'secondary',
      title: '复制应用与核心库版本、六个工具的来源与实际生效路径',
      onClick: () => {
        const snapshot = ctx.tools.snapshot();
        const text = diagnosticsText({
          about,
          tools: snapshot.statuses,
          phase: snapshot.phase,
          error: snapshot.error,
        });
        copyText(text, () => toast('诊断信息已复制', 'ok'));
      },
    });

  const render = (info: AboutData): void => {
    const name = el('div', { class: 'settings__about-name' });
    name.append(
      el('strong', { text: `${info.appName} v${info.appVersion}` }),
      el('span', { class: 'settings__about-core', text: `核心库 v${info.coreVersion}` }),
    );

    const meta = el('div', { class: 'settings__about-meta' });
    meta.append(el('span', { text: `许可证：${info.license}` }));
    if (isSafeLibraryUrl(info.repoUrl)) meta.append(externalLink(info.repoUrl, '仓库主页'));

    const libs = el('div', { class: 'settings__libs' });
    libs.append(
      el(
        'div',
        { class: 'settings__libs-row settings__libs-row--head' },
        el('span', { text: '库' }),
        el('span', { text: '版本' }),
        el('span', { text: '许可证' }),
      ),
    );
    for (const lib of info.libraries) {
      const cell = el('span', { class: 'settings__libs-name' });
      if (isSafeLibraryUrl(lib.url)) cell.append(externalLink(lib.url, lib.name));
      else cell.textContent = lib.name;
      libs.append(
        el(
          'div',
          { class: 'settings__libs-row' },
          cell,
          el('span', { class: 'settings__libs-version mono', text: lib.version }),
          // 许可证列只放短标识（BSD-3-Clause / GPL / MIT），完整条款在悬停里
          el('span', {
            class: 'settings__libs-license',
            text: licenseShort(lib.license),
            title: lib.license,
          }),
        ),
      );
    }

    content.replaceChildren(
      name,
      el('p', { class: 'settings__about-intro', text: info.intro }),
      meta,
      copyButton(),
      el('div', { class: 'settings__about-libs-title', text: '引用的库' }),
      libs,
    );
  };

  async function load(): Promise<void> {
    if (loading || about) return;
    loading = true;
    errorLine.hidden = true;
    retryBtn.hidden = true;
    content.replaceChildren(el('div', { class: 'settings__loading' }, spinner('加载版本信息…')));
    try {
      about = await ipc.aboutInfo();
      render(about);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      content.replaceChildren();
      errorLine.textContent = `加载「关于」信息失败：${message}`;
      errorLine.hidden = false;
      retryBtn.hidden = false;
    } finally {
      loading = false;
    }
  }

  return {
    node,
    sync: (_settings: SettingsData) => {
      // 关于区不随设置变化；保留接口形状统一。
    },
    activate: () => void load(),
  };
}
