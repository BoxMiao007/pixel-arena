// 视频域动作：选片（对话框 / 拖放共用）、移除、整轮跑分。
//
// 两个拖放入口必须保持签名（shell/file-drop.ts 的默认路由动态 import 本模块）：
//   chooseVideoReference(groupId, roundId, path)
//   chooseVideoCandidates(groupId, roundId, paths)
// 落库统一走 store.runWorkspace（IPC → 整份工作区替换 → 通知各分区 update）。
//
// 跑分是整轮单 IPC：进度只有 N/M，期间行内只能表达「跑分中」；真正的完成度写
// store.busy（completed/total），dock 页签据此画确定进度。

import { activeRound } from '../../core/model';
import {
  beginBusy,
  endBusy,
  getState,
  isBusy,
  runWorkspace,
  setStatus,
  setWorkspace,
  updateBusy,
} from '../../core/store';
import { notePickedPath, pickFile, pickFiles } from '../../core/actions';
import { toast } from '../../ui/toast';
import { DROP_EXTENSIONS } from '../../shell/file-drop';
import { videoIpc } from './video-ipc';

/** 整轮跑分的忙任务 id（同一时刻只跑一轮）。 */
export const VIDEO_BUSY_ID = 'video-score';

const VIDEO_FILTER = {
  name: '视频（MP4 / MKV / WebM 等）',
  extensions: [...DROP_EXTENSIONS.video],
};

interface Session {
  groupId: string;
  roundId: string;
}

function activeVideoSession(): Session | null {
  const session = activeRound(getState().workspace);
  if (!session || session.group.kind !== 'video') return null;
  return { groupId: session.group.id, roundId: session.round.id };
}

function videoRound(groupId: string, roundId: string) {
  const workspace = getState().workspace;
  const group = workspace?.groups.find((item) => item.id === groupId);
  const round = group?.rounds.find((item) => item.id === roundId);
  return group?.kind === 'video' && round ? round : null;
}

function guardBusy(): boolean {
  if (!isBusy()) return false;
  toast('有任务正在运行，完成后再改动来源', 'danger');
  return true;
}

/** 拖放/对话框共用：设为原视频（后端覆盖语义：旧跑分结果作废，体积比重算）。 */
export async function chooseVideoReference(
  groupId: string,
  roundId: string,
  path: string,
): Promise<void> {
  const target = path.trim();
  if (!target || guardBusy()) return;
  notePickedPath(target); // 拖放路径同样记入最近目录
  await runWorkspace(() => videoIpc.setReference(groupId, roundId, target), {
    success: '已更新原视频；旧视频跑分结果已作废',
  });
}

/** 拖放/对话框共用：追加跑分视频（后端去重；任一文件不存在整批失败并给中文原因）。 */
export async function chooseVideoCandidates(
  groupId: string,
  roundId: string,
  paths: readonly string[],
): Promise<void> {
  const list = paths.map((path) => path.trim()).filter((path) => path !== '');
  if (list.length === 0 || guardBusy()) return;
  notePickedPath(list[0]);
  await runWorkspace(() => videoIpc.addCandidates(groupId, roundId, list), {
    success: `已添加 ${list.length} 段跑分视频`,
  });
}

/** 移除一段跑分视频（只摘这一行，其余数据不动）。 */
export async function removeVideoCandidate(
  groupId: string,
  roundId: string,
  candidatePath: string,
): Promise<void> {
  if (guardBusy()) return;
  await runWorkspace(() => videoIpc.removeCandidate(groupId, roundId, candidatePath), {
    success: '已移除该段跑分视频',
  });
}

/** 弹系统对话框选原视频。取消不动工作区。 */
export async function pickVideoReference(groupId: string, roundId: string): Promise<void> {
  if (guardBusy()) return;
  const path = await pickFile({ title: '选择原视频', filters: [VIDEO_FILTER] });
  if (!path) return;
  await chooseVideoReference(groupId, roundId, path);
}

/** 弹系统对话框多选跑分视频。取消或空选不动工作区。 */
export async function pickVideoCandidates(groupId: string, roundId: string): Promise<void> {
  if (guardBusy()) return;
  const paths = await pickFiles({ title: '添加跑分视频（可多选）', filters: [VIDEO_FILTER] });
  if (paths.length === 0) return;
  await chooseVideoCandidates(groupId, roundId, paths);
}

/**
 * 对整轮全部跑分视频跑分：一次 IPC 提交整轮，后端按并发度同时起 ffmpeg 进程。
 * 进度写 store.busy（N/M），状态栏同步一句；单段失败不整轮失败，原因写在行内。
 */
export async function runVideoScoring(groupId: string, roundId: string): Promise<void> {
  if (isBusy()) {
    toast('已有跑分任务在运行，等它完成再开始', 'danger');
    return;
  }
  const round = videoRound(groupId, roundId);
  if (!round) return;
  if (!round.videoReferencePath) {
    setStatus('视频跑分需要先选原视频', { isError: true });
    return;
  }
  const paths = (round.videoCandidates ?? []).map((candidate) => candidate.path);
  if (paths.length === 0) {
    setStatus('视频跑分需要至少一段跑分视频', { isError: true });
    return;
  }

  beginBusy(VIDEO_BUSY_ID, '视频跑分中', paths);
  updateBusy(VIDEO_BUSY_ID, { detail: `0/${paths.length}`, completed: 0, total: paths.length });
  setStatus(`视频跑分中 0/${paths.length}`);
  try {
    const workspace = await videoIpc.scoreCandidates({
      groupId,
      roundId,
      onProgress: (progress) => {
        updateBusy(VIDEO_BUSY_ID, {
          detail: `${progress.completed}/${progress.total}`,
          completed: progress.completed,
          total: progress.total,
        });
        setStatus(`视频跑分中 ${progress.completed}/${progress.total}`);
      },
    });
    setWorkspace(workspace);
    setStatus(`视频跑分完成，共 ${paths.length} 段`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 后端未返回工作区：行内状态保持「待跑分」，原因在状态栏可点开全文。
    setStatus(`视频跑分失败：${message}`, { isError: true, detail: message });
  } finally {
    endBusy(VIDEO_BUSY_ID);
  }
}

// ---------- 命令入口（Ctrl+O / Ctrl+Shift+O / Ctrl+Enter 经 registry 调用） ----------

export async function pickVideoReferenceForActiveRound(): Promise<void> {
  const session = activeVideoSession();
  if (!session) return;
  await pickVideoReference(session.groupId, session.roundId);
}

export async function pickVideoCandidatesForActiveRound(): Promise<void> {
  const session = activeVideoSession();
  if (!session) return;
  await pickVideoCandidates(session.groupId, session.roundId);
}

export async function runVideoScoringForActiveRound(): Promise<void> {
  const session = activeVideoSession();
  if (!session) return;
  await runVideoScoring(session.groupId, session.roundId);
}
