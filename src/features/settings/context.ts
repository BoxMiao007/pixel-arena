// 设置面板的内部契约：分区模块只依赖这个上下文，不直接摸 store / overlay。
//
// 这样对话框外壳能一次性管住生命周期（订阅、销毁、底部保存态），分区模块保持
// 「给定上下文、画一棵 DOM、把外部变化同步进来」的简单形状。

import type { SettingsData } from '../../core/settings';
import type { SettingsPatch } from '../../core/settings-save';
import type { ToolsWatcher } from './tools';

/** 一个设置分区的挂载结果。 */
export interface SectionModule {
  node: HTMLElement;
  /** 设置变化时同步控件显示（不得重建正在编辑的输入框）。 */
  sync(settings: SettingsData): void;
  /** 分区首次被切到时调用（懒加载，例如「关于」的 IPC）。 */
  activate?(): void;
  /** 对话框关闭时释放订阅。 */
  destroy?(): void;
}

export interface SettingsCtx {
  /** 当前已保存的设置（对话框只在设置已加载时打开，这里恒有值）。 */
  settings(): SettingsData;
  /** 字段级保存：成功返回 null，失败返回可就地显示的中文原因。 */
  save(patch: SettingsPatch): Promise<string | null>;
  /** 写面板底部的一行状态（已保存 / 保存失败 / 已恢复默认）。 */
  announce(text: string): void;
  /** 工具状态观察器（对话框级共享，一次探测喂「FFmpeg」「编码器」「关于」三处）。 */
  tools: ToolsWatcher;
}
