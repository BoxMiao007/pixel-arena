// 功能域注册契约：舞台视图、检视器分区、结果坞页签、命令。
//
// 外壳只认识这些接口，不认识具体功能；功能域在自己的 index.ts 里注册，外壳在
// 「分组或轮次变化」时销毁并重新 mount，状态变化时只调 update()。
// 详见 docs/refactor/frontend-redesign.md 第 7 节。

import type { Group, GroupKind, Round } from '../core/model';

export interface ViewCtx {
  group: Group;
  round: Round;
}

/** 挂载后的句柄：update 幂等且不得重建正在编辑的输入框；destroy 释放监听与媒体。 */
export interface MountedView {
  update(): void;
  destroy(): void;
}

/** 舞台视图：同一时刻按组类型选一个（图片组 = 对比查看器，视频组 = 视频对比）。 */
export interface StageView {
  id: string;
  label: string;
  kinds: GroupKind[];
  mount(host: HTMLElement, ctx: ViewCtx): MountedView;
}

/** 检视器分区：按 order 排列，按组类型过滤。 */
export interface PanelSection {
  id: string;
  title: string;
  order: number;
  kinds: GroupKind[];
  mount(host: HTMLElement, ctx: ViewCtx): MountedView;
}

/** 结果坞页签。 */
export interface DockTab {
  id: string;
  label: string;
  order: number;
  kinds: GroupKind[];
  mount(host: HTMLElement, ctx: ViewCtx): MountedView;
}

/** 命令上下文：按钮触发时带上自身作为锚点（菜单从按钮下方弹出）。 */
export interface CommandContext {
  anchor?: HTMLElement;
}

/** 命令：快捷键与按钮共用的动作入口；按组类型区分的用 id 后缀 -image / -video。 */
export interface Command {
  id: string;
  run: (context?: CommandContext) => void | Promise<void>;
  enabled?: () => boolean;
}

/**
 * 舞台键位：外壳统一监听 keydown，输入框/浮层打开时不派发；功能域只声明自己的键。
 * keys 用 KeyboardEvent.key 的写法（如 '1'、' '、'+'、'ArrowLeft'），匹配时忽略大小写。
 */
export interface KeyBinding {
  id: string;
  keys: readonly string[];
  /** 限定组类型；省略表示都生效。 */
  kinds?: GroupKind[];
  /** 额外条件（如「仅在查看器挂载时」）。 */
  when?: () => boolean;
  run: (event: KeyboardEvent) => void;
}

const keyBindings: KeyBinding[] = [];

export function registerKeyBinding(binding: KeyBinding): void {
  upsertById(keyBindings, binding);
}

export function keyBindingsSnapshot(): readonly KeyBinding[] {
  return keyBindings;
}

const stageViews: StageView[] = [];
const panelSections: PanelSection[] = [];
const dockTabs: DockTab[] = [];
const commands = new Map<string, Command>();

/**
 * 同 id 覆盖而不是静默丢弃：命令/视图/分区/页签都按 id 唯一，覆盖语义让热更新
 * 与「后注册者优先」可预期，也避免「重复注册到底是忽略还是覆盖」两套行为。
 */
function upsertById<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

export function registerStageView(view: StageView): void {
  upsertById(stageViews, view);
}

export function stageViewFor(kind: GroupKind): StageView | null {
  return stageViews.find((view) => view.kinds.includes(kind)) ?? null;
}

export function registerPanelSection(section: PanelSection): void {
  upsertById(panelSections, section);
}

export function panelSectionsFor(kind: GroupKind): PanelSection[] {
  return panelSections
    .filter((section) => section.kinds.includes(kind))
    .sort((a, b) => a.order - b.order);
}

export function registerDockTab(tab: DockTab): void {
  upsertById(dockTabs, tab);
}

export function dockTabsFor(kind: GroupKind): DockTab[] {
  return dockTabs.filter((tab) => tab.kinds.includes(kind)).sort((a, b) => a.order - b.order);
}

export function registerCommand(command: Command): void {
  commands.set(command.id, command);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** 执行命令；不存在或不可用返回 false（快捷键据此决定要不要拦默认行为）。 */
export async function runCommand(id: string, context?: CommandContext): Promise<boolean> {
  const command = commands.get(id);
  if (!command) return false;
  if (command.enabled && !command.enabled()) return false;
  try {
    await command.run(context);
  } catch (err) {
    console.error(`命令 ${id} 执行失败:`, err);
  }
  return true;
}

/** 按当前组类型执行 <base>-image / <base>-video 命令。 */
export function runKindCommand(
  base: string,
  kind: GroupKind,
  context?: CommandContext,
): Promise<boolean> {
  return runCommand(`${base}-${kind}`, context);
}
