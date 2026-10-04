// 跑分组标签页与评测轮管理（T05）。
// 前端不持有任何持久化逻辑：每次改动都经 IPC 命令落到核心库并立即写盘，
// 命令返回最新工作区整份状态，前端照着重渲染即可，不自己算状态。

import { invoke } from '@tauri-apps/api/core';
import './style.css';

// 与核心库 workspace.rs 的 serde 输出（camelCase）一一对应
interface Round {
  id: string;
  name: string;
}

interface Group {
  id: string;
  name: string;
  rounds: Round[];
  activeRoundId: string | null;
}

interface Workspace {
  formatVersion: number;
  groups: Group[];
  activeGroupId: string | null;
}

let ws: Workspace | null = null;

const $tabs = document.querySelector<HTMLDivElement>('#tabs')!;
const $rounds = document.querySelector<HTMLDivElement>('#rounds')!;
const $content = document.querySelector<HTMLElement>('#content')!;
const $status = document.querySelector<HTMLSpanElement>('#status')!;
const $addGroup = document.querySelector<HTMLButtonElement>('#add-group')!;
const $addRound = document.querySelector<HTMLButtonElement>('#add-round')!;

function activeGroup(): Group | null {
  if (!ws || !ws.activeGroupId) return null;
  return ws.groups.find((g) => g.id === ws!.activeGroupId) ?? null;
}

function setStatus(text: string, isError = false): void {
  $status.textContent = text;
  $status.classList.toggle('status-error', isError);
}

function markSaved(): void {
  setStatus(`已自动保存 ${new Date().toLocaleTimeString('zh-CN')}`);
}

// 所有改动走这里：调 IPC -> 用返回的工作区替换本地状态 -> 重渲染。
// 失败时把中文错误亮在状态栏，不弹窗打断。
async function apply(action: () => Promise<Workspace>): Promise<void> {
  try {
    ws = await action();
    render();
    markSaved();
  } catch (err) {
    setStatus(`出错: ${String(err)}`, true);
  }
}

function createGroup(): void {
  const name = `跑分组 ${ws ? ws.groups.length + 1 : 1}`;
  void apply(() => invoke('group_create', { name }));
}

function createRound(): void {
  const group = activeGroup();
  if (!group) return;
  const name = `评测轮 ${group.rounds.length + 1}`;
  void apply(() => invoke('round_create', { groupId: group.id, name }));
}

async function boot(): Promise<void> {
  const versionEl = document.querySelector<HTMLSpanElement>('#core-version');
  try {
    const version = await invoke<string>('core_version');
    if (versionEl) versionEl.textContent = `核心库 v${version}`;
  } catch (err) {
    if (versionEl) versionEl.textContent = `IPC 调用失败: ${String(err)}`;
  }
  try {
    ws = await invoke<Workspace>('workspace_load');
    render();
    if (ws.groups.length > 0) setStatus('已恢复上次的工作区');
  } catch (err) {
    setStatus(`恢复工作区失败: ${String(err)}`, true);
    render(); // 用空状态渲染，保证界面可用
  }
}

// ---------- 渲染 ----------

function render(): void {
  renderTabs();
  renderRounds();
  renderContent();
}

function renderTabs(): void {
  $tabs.replaceChildren();
  if (!ws) return;
  for (const group of ws.groups) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (group.id === ws.activeGroupId ? ' active' : '');
    tab.title = `${group.name}（单击切换，双击重命名）`;

    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = group.name;
    label.addEventListener('click', () => {
      if (ws && ws.activeGroupId !== group.id) {
        void apply(() => invoke('group_activate', { id: group.id }));
      }
    });
    label.addEventListener('dblclick', () => startRename(label, group.name, (name) => {
      void apply(() => invoke('group_rename', { id: group.id, name }));
    }));

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭跑分组';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void apply(() => invoke('group_close', { id: group.id }));
    });

    tab.append(label, close);
    $tabs.append(tab);
  }
  $addGroup.disabled = false;
  $addRound.disabled = !activeGroup();
}

function renderRounds(): void {
  $rounds.replaceChildren();
  const group = activeGroup();
  $addRound.disabled = !group;
  if (!ws || !group) return;

  if (group.rounds.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = '还没有评测轮，点右侧按钮新建';
    $rounds.append(hint);
    return;
  }
  for (const round of group.rounds) {
    const chip = document.createElement('div');
    chip.className = 'round' + (round.id === group.activeRoundId ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'round-name';
    label.textContent = round.name;
    label.title = `${round.name}（单击切换，双击改名）`;
    label.addEventListener('click', () => {
      if (group.activeRoundId !== round.id) {
        void apply(() => invoke('round_activate', { groupId: group.id, roundId: round.id }));
      }
    });
    label.addEventListener('dblclick', () => startRename(label, round.name, (name) => {
      void apply(() => invoke('round_rename', { groupId: group.id, roundId: round.id, name }));
    }));

    const del = document.createElement('button');
    del.className = 'round-delete';
    del.textContent = '×';
    del.title = '删除评测轮';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void apply(() => invoke('round_delete', { groupId: group.id, roundId: round.id }));
    });

    chip.append(label, del);
    $rounds.append(chip);
  }
}

function renderContent(): void {
  $content.replaceChildren();
  if (!ws || ws.groups.length === 0) {
    $content.textContent = '点上方「＋ 新建跑分组」开始一次评测。';
    return;
  }
  const group = activeGroup();
  if (!group || !group.activeRoundId) {
    $content.textContent = '新建或选择一轮评测，开始对比查看与跑分。';
    return;
  }
  const round = group.rounds.find((r) => r.id === group.activeRoundId);
  const p = document.createElement('p');
  p.className = 'content-placeholder';
  p.textContent = `当前评测轮「${round ? round.name : ''}」：
图片对比查看器与跑分结果区将在后续版本提供（选图 T06、查看器 T07）。`;
  $content.append(p);
}

// ---------- 行内重命名 ----------

// 把 label 换成输入框：Enter / 失焦提交，Esc 取消。空名提交会得到后端「名称不能为空」。
function startRename(
  label: HTMLElement,
  current: string,
  commit: (name: string) => void,
): void {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = current;
  input.maxLength = 60;
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (submit: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    render(); // 先还原界面；提交成功后 apply 会再渲染一次
    if (submit && name !== current) commit(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

$addGroup.addEventListener('click', createGroup);
$addRound.addEventListener('click', createRound);

void boot();
