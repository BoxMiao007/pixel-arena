// 导出菜单与导出动作：CSV / HTML 走 IPC 写文件，复制为 CSV / Markdown 走剪贴板。
//
// 口径（规格 §1.7、§4.3）：
// - 文件内容以核心库 report.rs 为唯一真源，这里不拼报告正文；
// - 文件写出期间占一个长任务（beginBusy('export')），任一长任务在跑都不再开新导出；
// - 用户取消保存对话框 = 静默返回，不写状态栏；
// - 失败把中文原文放进状态栏 detail（可点开复制），并给一条带「重试」的轻提示。

import { pickSavePath } from '../../core/actions';
import { activeRound } from '../../core/model';
import type { Round } from '../../core/model';
import { beginBusy, endBusy, getState, isBusy, setStatus } from '../../core/store';
import { copyText, errorText } from '../../core/util';
import { openMenu } from '../../ui/overlay';
import { toast } from '../../ui/toast';
import { setPanelCollapsed, requestRender, shellState } from '../../shell/controller';
import { exportFileName } from './filename';
import { roundExport } from './ipc';
import { toClipboardCsv, toMarkdown, type ClipboardInput } from './serialize';

const BUSY_ID = 'export';

/** 生成时间只作展示，格式与旧界面一致（zh-CN、24 小时制）。 */
function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/**
 * 导出的前置条件：忙（跑分/自动编码/导出中）或本轮没有可导出内容时返回原因文案；
 * 可导出返回 null。按钮的 disabled 与原因提示、命令入口共用这一份判定。
 */
export function exportBlockedReason(round: Round): string | null {
  if (isBusy()) return '有任务正在进行，结束后再导出';
  const hasImage = round.candidates.length > 0;
  const hasVideo = (round.videoCandidates?.length ?? 0) > 0;
  if (!hasImage && !hasVideo) return '这一轮还没有可导出的结果';
  return null;
}

async function exportRound(kind: 'csv' | 'html'): Promise<void> {
  const session = activeRound(getState().workspace);
  if (!session) {
    setStatus('还没有选中评测轮');
    return;
  }
  const reason = exportBlockedReason(session.round);
  if (reason !== null) {
    setStatus(reason);
    return;
  }

  let path: string | null;
  try {
    path = await pickSavePath({
      title: kind === 'csv' ? '导出 CSV' : '导出 HTML 报告',
      defaultName: exportFileName(session.round, kind),
      filters: [
        kind === 'csv'
          ? { name: 'CSV（逗号分隔）', extensions: ['csv'] }
          : { name: 'HTML 报告', extensions: ['html'] },
      ],
    });
  } catch (err) {
    const message = errorText(err);
    setStatus(`打开保存对话框失败：${message}`, { isError: true, detail: message });
    return;
  }
  if (path === null) return; // 用户取消：静默

  // 对话框打开期间别的入口可能刚启动跑分：这时不抢写文件，让用户稍后再来。
  if (isBusy()) {
    setStatus('有任务正在进行，结束后再导出');
    return;
  }

  beginBusy(BUSY_ID, kind === 'csv' ? '正在导出 CSV' : '正在导出 HTML 报告');
  try {
    const written = await roundExport({
      groupId: session.group.id,
      roundId: session.round.id,
      kind,
      path,
      generatedAt: nowText(),
    });
    setStatus(`已导出：${written}`, { detail: written });
    toast('报告已导出', 'ok', {
      action: { label: '复制路径', onSelect: () => copyText(written, () => toast('已复制路径', 'ok')) },
    });
  } catch (err) {
    const message = errorText(err);
    setStatus(`导出失败：${message}`, { isError: true, detail: message });
    toast('导出失败', 'danger', {
      action: { label: '重试', onSelect: () => void exportRound(kind) },
    });
  } finally {
    endBusy(BUSY_ID);
  }
}

async function copyResults(kind: 'csv' | 'markdown'): Promise<void> {
  const session = activeRound(getState().workspace);
  if (!session) {
    setStatus('还没有选中评测轮');
    return;
  }
  const reason = exportBlockedReason(session.round);
  if (reason !== null) {
    setStatus(reason);
    return;
  }

  const input: ClipboardInput = {
    group: session.group,
    round: session.round,
    generatedAt: nowText(),
  };
  const text = kind === 'csv' ? toClipboardCsv(input) : toMarkdown(input);
  copyText(text, () => toast(kind === 'csv' ? '已复制 CSV' : '已复制 Markdown', 'ok'));
}

/** 菜单锚点：优先用户刚点/聚焦的入口（工作栏、结果坞或顶栏），其次结果坞页签栏
 * （快捷键在别处按下时的兜底）。 */
function resolveAnchor(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('.workbar, .dock, .titlebar')) {
    return active;
  }
  if (shellState.dockCollapsed) {
    setPanelCollapsed('dock', false);
    requestRender();
  }
  // 键盘入口优先落在工作栏的「导出」按钮下方；没有则退回结果坞页签栏。
  return (
    document.querySelector<HTMLElement>('[data-export-anchor]') ??
    document.querySelector<HTMLElement>('.dock__tabs') ??
    document.querySelector<HTMLElement>('.dock__head')
  );
}

/** 菜单动作：写文件两项走核心库 report.rs，复制两项走 ./serialize 的纯文本。 */
export interface ExportMenuAction {
  label: string;
  onSelect: () => void;
}

/**
 * 导出菜单的四个动作。抽成纯函数是为了让「菜单里到底有哪几项」可单测——
 * 每项的内部行为由 exportBlockedReason / exportFileName / serialize 的测试覆盖。
 */
export function exportMenuActions(): ExportMenuAction[] {
  return [
    { label: '导出 CSV…', onSelect: () => void exportRound('csv') },
    { label: '导出 HTML…', onSelect: () => void exportRound('html') },
    { label: '复制为 CSV', onSelect: () => void copyResults('csv') },
    { label: '复制为 Markdown', onSelect: () => void copyResults('markdown') },
  ];
}

/**
 * 打开导出菜单。anchor 省略时自动找锚点（快捷键入口用）。
 * 忙或没有可导出内容时不开菜单，改成状态栏说明（避免整菜单都是灰项）。
 */
export function openExportMenu(anchor?: HTMLElement): void {
  const session = activeRound(getState().workspace);
  if (!session) {
    setStatus('还没有可导出的评测轮');
    return;
  }
  const reason = exportBlockedReason(session.round);
  if (reason !== null) {
    setStatus(reason);
    return;
  }
  // 不切用户当前的页签（可能正看效率对比），没有导出按钮时借用页签栏做锚点。
  const target = anchor ?? resolveAnchor();
  if (!target) {
    setStatus('结果坞还没有打开，先打开一条评测轮');
    return;
  }
  openMenu(target, exportMenuActions(), { align: 'end', label: '导出本轮结果' });
}
