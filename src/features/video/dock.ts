// 结果坞「视频指标」页签：排序 / 最佳值标记 / 失败行展开 / 点击联动舞台。
//
// 表格骨架与指标格式化只读复用 results 域（ui 无关的纯函数 + 通用 TableSpec），
// 视频列序（VMAF 最前）与排序取值留在本域（./metrics.ts）。
// 排序与展开态按轮存在 core/ui-state 的 roundScoped 里，切页签不丢。

import { formatElapsed, formatRatio, formatSize } from '../../core/format';
import type { CandidateVideo, Round } from '../../core/model';
import { busyEntry, isPathRunning, subscribe } from '../../core/store';
import {
  getActiveCandidate,
  roundScoped,
  setActiveCandidate,
} from '../../core/ui-state';
import { copyText, fileName, truncateFileName } from '../../core/util';
import { requestRender } from '../../shell/controller';
import type { MountedView, ViewCtx } from '../../shell/registry';
import { el } from '../../ui/dom';
import { button } from '../../ui/primitives';
import { toast } from '../../ui/toast';
import { progressBar } from '../../ui/primitives';
import { VIDEO_BUSY_ID } from './actions';
import { firstClickDir, videoMetricKeys, videoSortableValue } from './metrics';
import {
  mountTable,
  nextSortState,
  sortRowsBy,
  type SortState,
  type TableCell,
  type TableColumn,
  type TableHandle,
  type TableRow,
  type TableSpec,
} from '../results/table';
import {
  formatMetricFor,
  metricHeaderTitle,
  metricMeta,
  metricPreferredDir,
} from '../results/metrics';
import { rowStatus, rowStatusText } from '../results/status';
import { videoRound } from './inspector/shared';

const METRIC_WIDTH = 104;

interface SortHolder {
  value: SortState | null;
}

interface ExpandedHolder {
  value: Set<string>;
}

function buildColumns(metricKeys: readonly string[]): TableColumn[] {
  return [
    { key: 'name', label: '跑分视频', width: 220, sortable: true, preferredDir: 1 },
    {
      key: 'fileSize',
      label: '文件大小',
      width: 96,
      align: 'end',
      sortable: true,
      preferredDir: 1,
      title: '越小越省空间',
    },
    {
      key: 'sizeRatio',
      label: '体积比',
      width: 88,
      align: 'end',
      sortable: true,
      preferredDir: -1,
      title: '跑分视频体积 / 原视频体积',
    },
    ...metricKeys.map((key) => {
      const meta = metricMeta(key);
      return {
        key,
        label: meta.label,
        width: METRIC_WIDTH,
        align: 'end' as const,
        sortable: true,
        preferredDir: metricPreferredDir(meta),
        title: metricHeaderTitle(meta),
      };
    }),
    {
      key: 'elapsedMs',
      label: '耗时',
      width: 96,
      align: 'end',
      sortable: true,
      preferredDir: 1,
      title: '该段 ffmpeg 子进程耗时（含失败）',
    },
    { key: 'status', label: '状态', width: 128, sortable: false },
  ];
}

/** 每列的最佳值（指标按优方向，体积比/耗时取最小）：用于行内徽标。 */
function bestValues(
  candidates: readonly CandidateVideo[],
  metricKeys: readonly string[],
): Map<string, number> {
  const best = new Map<string, number>();
  for (const key of metricKeys) {
    const better = metricMeta(key).better;
    let value: number | null = null;
    for (const candidate of candidates) {
      const metric = candidate.metrics?.[key];
      if (metric === undefined) continue;
      const numeric = metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
      if (value === null || (better === 'lower' ? numeric < value : numeric > value)) {
        value = numeric;
      }
    }
    if (value !== null) best.set(key, value);
  }
  let ratio: number | null = null;
  let elapsed: number | null = null;
  for (const candidate of candidates) {
    if (candidate.sizeRatio !== null && (ratio === null || candidate.sizeRatio < ratio)) {
      ratio = candidate.sizeRatio;
    }
    if (
      candidate.elapsedMs !== null &&
      candidate.elapsedMs !== undefined &&
      (elapsed === null || candidate.elapsedMs < elapsed)
    ) {
      elapsed = candidate.elapsedMs;
    }
  }
  if (ratio !== null) best.set('sizeRatio', ratio);
  if (elapsed !== null) best.set('elapsedMs', elapsed);
  return best;
}

function metricCell(
  key: string,
  candidate: CandidateVideo,
  best: Map<string, number>,
): TableCell {
  const metric = candidate.metrics?.[key];
  const value = metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
  const isBest = value !== undefined && best.has(key) && value === best.get(key);
  return {
    text: formatMetricFor(key, metric),
    className: isBest ? 'is-best' : undefined,
    srText: isBest ? '最佳' : undefined,
  };
}

export function mountVideoMetricsTab(host: HTMLElement, ctx: ViewCtx): MountedView {
  const roundId = ctx.round.id;

  const root = el('div', { class: 'video-metrics' });
  const progress = progressBar();
  const progressHost = el('div', { class: 'video-metrics__progress' }, progress.node);
  progressHost.hidden = true;
  const tableHost = el('div', { class: 'video-metrics__table' });
  root.append(progressHost, tableHost);
  host.replaceChildren(root);

  const sortHolder = roundScoped<SortHolder>('video-sort', roundId, () => ({ value: null }));
  const expandedHolder = roundScoped<ExpandedHolder>('video-expanded', roundId, () => ({
    value: new Set<string>(),
  }));
  let table: TableHandle | null = null;
  let mode: 'empty' | 'table' = 'empty';

  const buildSpec = (round: Round): TableSpec => {
    const candidates = [...(round.videoCandidates ?? [])];
    const metricKeys = videoMetricKeys(candidates);
    const columns = buildColumns(metricKeys);
    const best = bestValues(candidates, metricKeys);
    const sorted = sortRowsBy<CandidateVideo>(
      candidates,
      sortHolder.value,
      (candidate) => videoSortableValue(candidate, sortHolder.value?.key ?? 'name'),
      (candidate) => candidate.path,
    );
    const active = getActiveCandidate(roundId);
    const expanded = expandedHolder.value;

    const toggleExpanded = (path: string): void => {
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      requestRender();
    };

    const rows: TableRow[] = sorted.map((candidate) => {
      const running = isPathRunning(candidate.path);
      const status = rowStatus(candidate, running);
      const statusCell: TableCell =
        status === 'fail' && candidate.error !== null
          ? {
              node: el('button', {
                class: 'video-status-toggle',
                attrs: {
                  type: 'button',
                  'aria-expanded': String(expanded.has(candidate.path)),
                  title: candidate.error,
                },
                text: '失败',
                on: {
                  click: (event) => {
                    event.stopPropagation();
                    toggleExpanded(candidate.path);
                  },
                },
              }),
              className: 'is-fail',
            }
          : { text: rowStatusText(status, candidate.error) };

      const cells: (TableCell | null)[] = [
        {
          text: truncateFileName(fileName(candidate.path)),
          title: candidate.path,
          className: 'cell-name',
        },
        { text: formatSize(candidate.fileSize) },
        {
          text: candidate.sizeRatio === null ? '—' : formatRatio(candidate.sizeRatio),
          className:
            candidate.sizeRatio !== null && best.get('sizeRatio') === candidate.sizeRatio
              ? 'is-best'
              : undefined,
          srText:
            candidate.sizeRatio !== null && best.get('sizeRatio') === candidate.sizeRatio
              ? '最小'
              : undefined,
        },
        ...metricKeys.map((key) => metricCell(key, candidate, best)),
        {
          text:
            candidate.elapsedMs === null || candidate.elapsedMs === undefined
              ? '—'
              : formatElapsed(candidate.elapsedMs),
          className:
            candidate.elapsedMs !== undefined &&
            candidate.elapsedMs !== null &&
            best.get('elapsedMs') === candidate.elapsedMs
              ? 'is-best'
              : undefined,
          srText:
            candidate.elapsedMs !== undefined &&
            candidate.elapsedMs !== null &&
            best.get('elapsedMs') === candidate.elapsedMs
              ? '最快'
              : undefined,
        },
        statusCell,
      ];

      const error = candidate.error;
      const detail =
        status === 'fail' && error !== null && expanded.has(candidate.path)
          ? el(
              'div',
              { class: 'video-detail' },
              el('p', { class: 'video-detail__title', text: '失败原因' }),
              el('pre', { class: 'video-detail__reason', text: error }),
              el(
                'div',
                { class: 'video-detail__actions' },
                button({
                  label: '复制原因',
                  size: 'sm',
                  icon: 'copy',
                  onClick: () => copyText(error, () => toast('已复制失败原因', 'ok')),
                }),
              ),
            )
          : null;

      return {
        key: candidate.path,
        selected: active === candidate.path,
        cells,
        detail,
        onActivate: () => {
          setActiveCandidate(roundId, candidate.path);
          requestRender();
        },
      };
    });

    return {
      caption: '视频跑分结果',
      columns,
      rows,
      sort: sortHolder.value,
      onSort: (key) => {
        sortHolder.value = nextSortState(sortHolder.value, key, firstClickDir(key));
        update();
      },
      emptyText: '还没有跑分视频：在右侧「跑分视频」分区添加后开始跑分。',
    };
  };

  const update = (): void => {
    const round = videoRound(ctx.group.id, roundId);
    if (!round) return;

    // 没有跑分视频 = 没有可展示的结果：与其他页签同一口径，只留一行 12px 说明。
    if ((round.videoCandidates ?? []).length === 0) {
      if (mode !== 'empty') {
        table?.destroy();
        table = null;
        tableHost.replaceChildren();
        mode = 'empty';
      }
      if (tableHost.childElementCount === 0) {
        tableHost.appendChild(
          el('p', {
            class: 'results-empty-note video-metrics__empty',
            text: '跑分后这里出现视频指标',
          }),
        );
      }
      progressHost.hidden = true;
      return;
    }

    const spec = buildSpec(round);
    if (mode !== 'table') {
      tableHost.replaceChildren();
      table = mountTable(tableHost, spec);
      mode = 'table';
    } else {
      table?.update(spec);
    }

    const entry = busyEntry(VIDEO_BUSY_ID);
    progressHost.hidden = entry === undefined;
    if (entry) {
      if (typeof entry.completed === 'number' && typeof entry.total === 'number') {
        progress.set(entry.completed, entry.total, `视频跑分 ${entry.completed}/${entry.total}`);
      } else {
        progress.setIndeterminate(entry.detail !== '' ? entry.detail : entry.label);
      }
    }
  };

  const unsubscribe = subscribe(update);
  update();

  return {
    update,
    destroy(): void {
      unsubscribe();
      table?.destroy();
      table = null;
    },
  };
}
