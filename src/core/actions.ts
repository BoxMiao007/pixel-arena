// 跨域动作：分组 / 轮次 CRUD、系统文件对话框、原图与跑分图增删。
//
// 这些动作被外壳、检视器、快捷键共同调用，所以收在 core；只做「校验 -> IPC ->
// 写回 store -> 状态栏」四件事，不含任何界面结构。破坏性动作先确认（见 ui/overlay）。

import { open, save } from '@tauri-apps/plugin-dialog';
import {
  groupHasContent,
  roundHasContent,
  type Group,
  type GroupKind,
  type Round,
} from './model';
import { ipc } from './ipc';
import { getState, runWorkspace, setSettings } from './store';
import { dropRoundScoped } from './ui-state';
import { exportDefaultPath, nextRecentDir, openDefaultPath, type SettingsData } from './settings';
import { confirm, prompt } from '../ui/overlay';
import { toast } from '../ui/toast';
import { ffmpegReady } from './ffmpeg';

export const IMAGE_FILTER = {
  name: '图片（PNG / JPEG / WebP / AVIF / JPEG XL）',
  extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'jxl'],
};

export const VIDEO_FILTER = {
  name: '视频（MP4 / MKV / WebM / MOV）',
  extensions: ['mp4', 'mkv', 'webm', 'mov', 'm4v'],
};

/** 组 / 轮被关闭后通知各功能域清理自己的会话态（如条目队列）。 */
type RemovalHook = (groupId: string) => void;
const groupRemovedHooks: RemovalHook[] = [];

export function onGroupRemoved(hook: RemovalHook): void {
  groupRemovedHooks.push(hook);
}

function emitGroupRemoved(groupId: string): void {
  for (const hook of groupRemovedHooks) hook(groupId);
}

/** 当前设置（未加载时为 null）。 */
export function currentSettings(): SettingsData | null {
  return getState().settings;
}

/** 打开对话框的默认位置：记录状态开启时恢复最近目录。 */
export function dialogDefaultPath(): string | undefined {
  const settings = currentSettings();
  return settings ? openDefaultPath(settings) : undefined;
}

/** 记录最近使用目录（记录状态关闭时不写；保存失败不打断主流程）。 */
export function notePickedPath(path: string): void {
  const settings = currentSettings();
  if (!settings) return;
  const next = nextRecentDir(settings, path);
  if (!next) return;
  void ipc
    .settingsSave(next)
    .then((saved) => setSettings(saved))
    .catch((err) => console.warn('记录最近使用的目录失败（不影响主流程）:', err));
}

/** 系统文件对话框：单选。取消返回 null。 */
export async function pickFile(options: {
  title: string;
  filters: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const selected = await open({
    title: options.title,
    multiple: false,
    directory: false,
    filters: options.filters,
    defaultPath: dialogDefaultPath(),
  });
  if (typeof selected !== 'string') return null;
  notePickedPath(selected);
  return selected;
}

/** 系统文件对话框：多选（取消或空选返回空数组）。 */
export async function pickFiles(options: {
  title: string;
  filters: { name: string; extensions: string[] }[];
}): Promise<string[]> {
  const selected = await open({
    title: options.title,
    multiple: true,
    directory: false,
    filters: options.filters,
    defaultPath: dialogDefaultPath(),
  });
  if (Array.isArray(selected)) return selected;
  if (typeof selected === 'string') return [selected];
  return [];
}

/** 系统目录对话框（默认导出目录等）。 */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ title, directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

/** 保存对话框：给导出用，默认文件名 + 默认目录按设置走。 */
export async function pickSavePath(options: {
  title: string;
  defaultName: string;
  filters: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  const settings = currentSettings();
  const selected = await save({
    title: options.title,
    defaultPath: exportDefaultPath(settings?.defaultExportDir ?? null, options.defaultName),
    filters: options.filters,
  });
  return typeof selected === 'string' ? selected : null;
}

// ---------- 分组 ----------

function nextGroupName(kind: GroupKind): string {
  const state = getState();
  const count = state.workspace?.groups.filter((group) => group.kind === kind).length ?? 0;
  return `${kind === 'video' ? '视频' : '图片'}跑分组 ${count + 1}`;
}

/** 新建跑分组：先命名（默认名可回车直接接受），再建组（后端自动附带一个轮）。 */
export async function createGroup(kind: GroupKind): Promise<void> {
  const name = await prompt({
    title: kind === 'video' ? '新建视频跑分组' : '新建图片跑分组',
    label: '名称',
    value: nextGroupName(kind),
    confirmLabel: '新建',
  });
  if (name === null) return;
  const workspace = await runWorkspace(() => ipc.groupCreate(name, kind), {
    success: `已新建「${name}」`,
  });
  if (workspace && kind === 'video' && !ffmpegReady()) {
    toast('FFmpeg 未就绪：视频跑分前请先在设置页下载或指定路径', 'danger');
  }
}

export async function renameGroup(group: Group, name: string): Promise<void> {
  if (name.trim() === group.name) return;
  await runWorkspace(() => ipc.groupRename(group.id, name), { success: '已重命名跑分组' });
}

/** 关闭跑分组：有内容先确认；后端会删组并激活相邻组。 */
export async function closeGroup(group: Group): Promise<void> {
  if (groupHasContent(group)) {
    const ok = await confirm({
      title: '关闭跑分组',
      message: `「${group.name}」里有 ${group.rounds.length} 个评测轮且已有评测内容，关闭后这些数据会从工作区移除且无法恢复。`,
      confirmLabel: '关闭并丢弃',
      danger: true,
    });
    if (!ok) return;
  }
  for (const round of group.rounds) dropRoundScoped(round.id);
  const workspace = await runWorkspace(() => ipc.groupClose(group.id), {
    success: `已关闭「${group.name}」`,
  });
  if (workspace) emitGroupRemoved(group.id);
}

export async function activateGroup(group: Group): Promise<void> {
  if (getState().workspace?.activeGroupId === group.id) return;
  await runWorkspace(() => ipc.groupActivate(group.id));
}

// ---------- 评测轮 ----------

export function nextRoundName(group: Group): string {
  return `评测轮 ${group.rounds.length + 1}`;
}

export async function createRound(group: Group): Promise<void> {
  const name = await prompt({
    title: '新建评测轮',
    label: '名称',
    value: nextRoundName(group),
    confirmLabel: '新建',
  });
  if (name === null) return;
  await runWorkspace(() => ipc.roundCreate(group.id, name), { success: `已新建「${name}」` });
}

export async function renameRound(group: Group, round: Round, name: string): Promise<void> {
  if (name.trim() === round.name) return;
  await runWorkspace(() => ipc.roundRename(group.id, round.id, name), { success: '已重命名评测轮' });
}

/** 删除评测轮：有内容先确认（破坏性、不可恢复）。 */
export async function deleteRound(group: Group, round: Round): Promise<void> {
  if (roundHasContent(round)) {
    const ok = await confirm({
      title: '删除评测轮',
      message: `「${round.name}」里已有原图或跑分结果，删除后无法恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
  }
  dropRoundScoped(round.id);
  await runWorkspace(() => ipc.roundDelete(group.id, round.id), { success: '已删除评测轮' });
}

export async function activateRound(group: Group, round: Round): Promise<void> {
  if (group.activeRoundId === round.id) return;
  await runWorkspace(() => ipc.roundActivate(group.id, round.id));
}

// ---------- 轮内内容 ----------

export async function setRoundReference(
  groupId: string,
  roundId: string,
  path: string,
): Promise<void> {
  const round = getState()
    .workspace?.groups.find((g) => g.id === groupId)
    ?.rounds.find((r) => r.id === roundId);
  // 同一张原图不重复写：round_set_reference 会清掉已有跑分行的指标
  if (round?.referencePath === path) return;
  await runWorkspace(() => ipc.roundSetReference(groupId, roundId, path), {
    success: '已设置原图',
  });
}

export async function addCandidates(
  groupId: string,
  roundId: string,
  paths: readonly string[],
  encodingParams?: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await runWorkspace(() => ipc.roundAddCandidates(groupId, roundId, paths, encodingParams), {
    success: `已添加 ${paths.length} 张跑分图`,
  });
}

export async function removeCandidate(
  groupId: string,
  roundId: string,
  path: string,
): Promise<void> {
  await runWorkspace(() => ipc.roundRemoveCandidate(groupId, roundId, path), {
    success: '已移除跑分图',
  });
}

export async function clearCandidates(groupId: string, roundId: string): Promise<void> {
  const ok = await confirm({
    title: '清空跑分图',
    message: '本轮已选与已跑分的图片行会全部清空，原图与评测轮保留，磁盘上的文件不会被删除。',
    confirmLabel: '清空',
    danger: true,
  });
  if (!ok) return;
  await runWorkspace(() => ipc.roundClearCandidates(groupId, roundId), { success: '已清空跑分图' });
}

/** 选择原图并设为基准（系统对话框 + 落库）。 */
export async function chooseReference(groupId: string, roundId: string): Promise<void> {
  const path = await pickFile({ title: '选择原图', filters: [IMAGE_FILTER] });
  if (!path) return;
  await setRoundReference(groupId, roundId, path);
}

/** 追加跑分图（多选系统对话框 + 落库）。 */
export async function chooseCandidates(groupId: string, roundId: string): Promise<void> {
  const paths = await pickFiles({ title: '添加跑分图', filters: [IMAGE_FILTER] });
  if (paths.length === 0) return;
  await addCandidates(groupId, roundId, paths);
}
