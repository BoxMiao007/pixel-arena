// 视频评测区块（T14）：选原视频 → 添加跑分视频 → ffmpeg 跑分（VMAF/PSNR/SSIM + 耗时）。
// 与 main.ts 的图片流程并列、独立渲染；跑分沿用 T06 模式：前端逐对调用，每对回来
// 整份工作区刷新一次，进度天然可见。并行开发期不与图片表格抽公共模块（见 notes/T14.md）。

import { invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { fileName } from './util';

// 与核心库 workspace.rs 的 CandidateVideo（camelCase）一一对应
export type MetricValue = number | 'inf';

export interface VideoCandidate {
  path: string;
  fileSize: number;
  sizeRatio: number | null;
  metrics: Record<string, MetricValue> | null;
  error: string | null;
  elapsedMs: number | null;
}

/** main.ts 传进来的本轮视频评测数据（字段为空表示还没用过视频功能）。 */
export interface VideoBlockRound {
  id: string;
  videoReferencePath: string | null;
  videoCandidates: VideoCandidate[];
}

/** main.ts 的 Workspace 的结构化最小镜像：video.ts 不消费返回值，只为类型相容。 */
interface WorkspaceLike {
  groups: { rounds: { videoCandidates?: VideoCandidate[] }[] }[];
}

export interface VideoBlockCtx {
  groupId: string;
  round: VideoBlockRound;
  /** 全局跑分标志（图片/视频跑分共用：谁在跑，两边按钮都置灰）。 */
  scoring: boolean;
  /** 正在跑分的那一对的路径（行内显示「跑分中…」）。 */
  scoringPath: string | null;
  /** main.ts 的 apply：改动 → IPC → 整份工作区替换 → 重渲染（失败亮状态栏）。 */
  apply(action: () => Promise<WorkspaceLike>): Promise<void>;
  /** main.ts 的单对跑分：invoke round_score_video_candidate → 替换 ws → render。 */
  scoreOne(candidatePath: string): Promise<void>;
  /** 共享跑分标志的读写（main.ts 持有 scoring/scoringPath 两个模块级变量）。 */
  setScoring(active: boolean, path: string | null): void;
  setStatus(text: string, isError?: boolean): void;
  /** 触发整页重渲染（改本模块的排序状态后用）。 */
  rerender(): void;
}

// 核心库不限定视频封装格式（ffmpeg 自己识别），过滤器只是选文件的提示
const VIDEO_FILTER = {
  name: '视频（MP4 / MKV / WebM 等）',
  extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'flv'],
};

// ---------- 纯函数（video.test.ts 守护） ----------

/** 指标列顺序偏好：VMAF 是视频跑分的主指标排最前，其余按首现顺序跟在后面。 */
export function videoMetricKeys(candidates: VideoCandidate[]): string[] {
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.metrics) continue;
    for (const key of Object.keys(candidate.metrics)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const preferred = ['VMAF', 'PSNR', 'SSIM'].filter((key) => keys.includes(key));
  return [...preferred, ...keys.filter((key) => !preferred.includes(key))];
}

/** 排序取值：缺值（未跑分/失败/无耗时）返回 null，排序时沉底。 */
export function videoSortableValue(
  candidate: VideoCandidate,
  key: string,
): number | string | null {
  if (key === 'name') return fileName(candidate.path);
  if (key === 'fileSize') return candidate.fileSize;
  if (key === 'sizeRatio') return candidate.sizeRatio;
  if (key === 'elapsedMs') return candidate.elapsedMs;
  const metric = candidate.metrics?.[key];
  if (metric === undefined) return null;
  return metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
}

export function firstClickDir(key: string): 1 | -1 {
  // 文件大小越小越好、耗时越短越好、名称自然升序；指标与体积比默认降序
  return key === 'fileSize' || key === 'name' || key === 'elapsedMs' ? 1 : -1;
}

export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ---------- 排序状态（模块级，跟随评测轮；重启归零，与 main.ts 的图片表一致） ----------

let sortState: { key: string; dir: 1 | -1 } | null = null;
let sortRoundId: string | null = null;

// ---------- 挂载 ----------

export function mountVideoBlock(host: HTMLElement, ctx: VideoBlockCtx): void {
  const { round } = ctx;
  // 排序状态跟随评测轮：切到另一轮就归零
  if (sortRoundId !== round.id) {
    sortRoundId = round.id;
    sortState = null;
  }

  const box = document.createElement('div');
  box.className = 'video-block';

  const title = document.createElement('div');
  title.className = 'video-block-title';
  title.textContent = '视频跑分（VMAF / PSNR / SSIM）';
  title.title = '指标经 ffmpeg 计算；音轨不参与评分；视频 SSIM 为 ffmpeg 口径，与图片 SSIM 不直接可比';
  box.append(title);

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const pickReferenceBtn = document.createElement('button');
  pickReferenceBtn.className = 'add-btn';
  pickReferenceBtn.textContent = round.videoReferencePath ? '重选原视频' : '选择原视频';
  pickReferenceBtn.title = '从文件系统选一段原视频作为画质与压缩的基准';
  pickReferenceBtn.disabled = ctx.scoring;
  pickReferenceBtn.addEventListener('click', () => void pickVideoReference(ctx));

  const referenceLabel = document.createElement('span');
  referenceLabel.className = 'reference-label';
  referenceLabel.textContent = round.videoReferencePath
    ? `原视频：${fileName(round.videoReferencePath)}`
    : '尚未选择原视频';
  referenceLabel.title = round.videoReferencePath ?? '';

  const addCandidatesBtn = document.createElement('button');
  addCandidatesBtn.className = 'add-btn';
  addCandidatesBtn.textContent = '添加跑分视频';
  addCandidatesBtn.title = '多选已用其他工具压缩好的视频';
  addCandidatesBtn.disabled = ctx.scoring;
  addCandidatesBtn.addEventListener('click', () => void pickVideoCandidates(ctx));

  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'add-btn score-btn';
  scoreBtn.textContent = ctx.scoring && ctx.scoringPath !== null ? '视频跑分中…' : '开始视频跑分';
  const ready = round.videoReferencePath && round.videoCandidates.length > 0;
  scoreBtn.title = ready
    ? '逐对经 ffmpeg 计算 VMAF/PSNR/SSIM（首次会先下载 ffmpeg，约 40MB，一次性）'
    : '需要先选原视频并至少添加一段跑分视频';
  scoreBtn.disabled = ctx.scoring || !ready;
  scoreBtn.addEventListener('click', () => void startVideoScoring(ctx));

  toolbar.append(pickReferenceBtn, referenceLabel, addCandidatesBtn, scoreBtn);
  box.append(toolbar);

  if (round.videoCandidates.length > 0) {
    box.append(buildVideoTable(ctx));
  } else {
    const hint = document.createElement('p');
    hint.className = 'content-placeholder';
    hint.textContent = round.videoReferencePath
      ? '原视频已就位。点「添加跑分视频」多选已压缩的视频，再「开始视频跑分」。'
      : '视频评测（可选）：与图片评测互不干扰。先「选择原视频」作为基准，再添加跑分视频。';
    box.append(hint);
  }

  host.append(box);
}

// ---------- 选视频与跑分 ----------

/** 弹系统文件对话框选原视频。取消选择则不动工作区。 */
async function pickVideoReference(ctx: VideoBlockCtx): Promise<void> {
  const selected = await open({ title: '选择原视频', multiple: false, filters: [VIDEO_FILTER] });
  if (typeof selected !== 'string') return; // 用户取消
  await ctx.apply(() =>
    invoke<WorkspaceLike>('round_set_video_reference', {
      groupId: ctx.groupId,
      roundId: ctx.round.id,
      path: selected,
    }),
  );
}

/** 弹系统文件对话框多选跑分视频。取消或空选则不动工作区。 */
async function pickVideoCandidates(ctx: VideoBlockCtx): Promise<void> {
  const selected = await open({
    title: '添加跑分视频（可多选）',
    multiple: true,
    filters: [VIDEO_FILTER],
  });
  if (selected === null) return; // 用户取消
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return;
  await ctx.apply(() =>
    invoke<WorkspaceLike>('round_add_video_candidates', {
      groupId: ctx.groupId,
      roundId: ctx.round.id,
      paths,
    }),
  );
}

/**
 * 触发视频跑分：先一次性确保 ffmpeg 就绪（首次会下载约 40MB，进度显示在状态栏），
 * 然后逐对调用跑分命令，每对回来整份工作区刷新一次——进度与单对失败天然可见。
 * 命令本身出错（如 ffmpeg 下载失败）时中止整个循环。
 */
async function startVideoScoring(ctx: VideoBlockCtx): Promise<void> {
  const queue = ctx.round.videoCandidates.map((c) => c.path);
  ctx.setScoring(true, null);

  try {
    const channel = new Channel<string>();
    channel.onmessage = (message) => ctx.setStatus(message);
    ctx.setStatus('正在准备 ffmpeg（首次约 40MB，之后直接复用）…');
    await invoke<string>('video_ensure_ffmpeg', { onProgress: channel });

    for (let i = 0; i < queue.length; i++) {
      ctx.setScoring(true, queue[i]);
      ctx.setStatus(`视频跑分中 ${i + 1}/${queue.length}：${fileName(queue[i])}`);
      await ctx.scoreOne(queue[i]);
    }
    ctx.setStatus(`视频跑分完成，共 ${queue.length} 段`);
  } catch (err) {
    ctx.setStatus(`出错: ${String(err)}`, true);
  } finally {
    ctx.setScoring(false, null);
  }
}

// ---------- 结果表 ----------

function buildVideoTable(ctx: VideoBlockCtx): HTMLTableElement {
  const { round, scoring, scoringPath } = ctx;
  const candidates = round.videoCandidates;
  const table = document.createElement('table');
  table.className = 'result-table';

  // 列：排名 | 跑分视频 | 文件大小 | 体积比 | 指标列… | 耗时 | 状态
  const columns: { key: string; label: string; sortable: boolean }[] = [
    { key: 'name', label: '跑分视频', sortable: true },
    { key: 'fileSize', label: '文件大小', sortable: true },
    { key: 'sizeRatio', label: '体积比', sortable: true },
    ...videoMetricKeys(candidates).map((key) => ({ key, label: key, sortable: true })),
    { key: 'elapsedMs', label: '耗时', sortable: true },
    { key: 'status', label: '状态', sortable: false },
  ];

  const rows = [...candidates];
  if (sortState) {
    const { key, dir } = sortState;
    rows.sort((a, b) => {
      const va = videoSortableValue(a, key);
      const vb = videoSortableValue(b, key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // 缺值（未跑分/失败）沉底
      if (vb === null) return -1;
      if (typeof va === 'string' && typeof vb === 'string') {
        return va.localeCompare(vb, 'zh-CN') * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
  }

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  const rankTh = document.createElement('th');
  rankTh.textContent = '排名';
  headRow.append(rankTh);
  for (const column of columns) {
    const th = document.createElement('th');
    if (!column.sortable) {
      th.textContent = column.label;
      headRow.append(th);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'sort-btn';
    btn.title = '点击排序（再点反向）';
    const arrow = sortState?.key === column.key ? (sortState.dir === 1 ? ' ↑' : ' ↓') : '';
    btn.textContent = column.label + arrow;
    btn.addEventListener('click', () => {
      if (scoring) return; // 跑分中表在逐对刷新，不允许改排序
      if (sortState?.key === column.key) {
        sortState.dir = (sortState.dir * -1) as 1 | -1;
      } else {
        sortState = { key: column.key, dir: firstClickDir(column.key) };
      }
      ctx.rerender();
    });
    th.append(btn);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  rows.forEach((candidate, index) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(index + 1);

    const name = document.createElement('td');
    name.className = 'cell-name';
    name.textContent = fileName(candidate.path);
    name.title = candidate.path;

    const fileSize = document.createElement('td');
    fileSize.textContent = formatSize(candidate.fileSize);

    const ratio = document.createElement('td');
    ratio.textContent =
      candidate.sizeRatio === null ? '—' : formatRatio(candidate.sizeRatio);

    const metricCells: HTMLTableCellElement[] = [];
    for (const key of videoMetricKeys(candidates)) {
      const td = document.createElement('td');
      const metric = candidate.metrics?.[key];
      td.textContent = metric === undefined ? '—' : formatMetric(metric);
      td.classList.add('cell-metric');
      metricCells.push(td);
    }

    const elapsed = document.createElement('td');
    elapsed.textContent =
      candidate.elapsedMs === null ? '—' : formatElapsed(candidate.elapsedMs);

    const status = document.createElement('td');
    status.className = 'cell-status';
    if (candidate.error !== null) {
      status.textContent = `失败：${candidate.error}`;
      status.classList.add('status-fail');
      status.title = candidate.error;
    } else if (scoringPath === candidate.path) {
      status.textContent = '跑分中…';
      status.classList.add('status-running');
    } else if (candidate.metrics === null) {
      status.textContent = '待跑分';
      status.classList.add('status-pending');
    } else {
      status.textContent = '完成';
    }

    tr.append(rank, name, fileSize, ratio, ...metricCells, elapsed, status);
    body.append(tr);
  });
  table.append(body);
  return table;
}

// ---------- 格式化（与 main.ts 的图片表口径一致；并行期有意各持一份） ----------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRatio(ratio: number): string {
  return ratio < 1 ? `${(ratio * 100).toFixed(1)}%` : `×${ratio.toFixed(2)}`;
}

function formatMetric(metric: MetricValue): string {
  if (metric === 'inf') return '∞';
  // ≥10 的指标（VMAF/PSNR 等）两位小数，小值（SSIM）四位
  return Math.abs(metric) >= 10 ? metric.toFixed(2) : metric.toFixed(4);
}
