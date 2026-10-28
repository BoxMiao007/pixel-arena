// 结果坞「BD-rate」页签：参照格式、口径说明、按格式汇总表。
//
// 数据来自 round_bdrate（与导出报告同一份核心库实现）。缓存按轮存在 ./bdrate.ts，
// 指纹（原图 + 每张跑分图的字节数与 PSNR）变了才重算；切换页签/切轮不会重复请求。
// 失败不清空上一次成功结果：表格留着，上面加一条可重试的错误条。

import type { Round } from '../../core/model';
import { errorText } from '../../core/util';
import { el } from '../../ui/dom';
import { button, spinner } from '../../ui/primitives';
import type { DockTab, MountedView, ViewCtx } from '../../shell/registry';
import { bdrateSignature, cachedBdrate, rememberBdrate } from './bdrate';
import { roundBdrate, type BdrateSummary } from './ipc';
import { formatBdRateCell } from './metrics';
import { liveRound } from './round';
import {
  mountTable,
  type TableColumn,
  type TableHandle,
  type TableRow,
  type TableSpec,
} from './table';

const COLUMNS: TableColumn[] = [
  { key: 'format', label: '格式', width: 120, align: 'start' },
  { key: 'bdrate', label: 'BD-rate', width: 110, align: 'end' },
  { key: 'points', label: '样本点', width: 88, align: 'end' },
  { key: 'note', label: '说明', width: 300, align: 'start' },
];

function buildSpec(summary: BdrateSummary): TableSpec {
  const rows: TableRow[] = summary.entries.map((entry) => ({
    key: `bdrate:${entry.format}`,
    className: entry.note === '参照格式' ? 'results-table__reference' : undefined,
    cells: [
      { text: entry.format },
      {
        text: formatBdRateCell(entry.bdRatePercent),
        className:
          entry.bdRatePercent !== null && entry.bdRatePercent < 0 ? 'is-negative' : undefined,
      },
      { text: String(entry.pointCount) },
      { text: entry.note ?? '', title: entry.note ?? undefined },
    ],
  }));
  return {
    caption: 'BD-rate 汇总',
    columns: COLUMNS,
    rows,
    sort: null,
    onSort: () => {},
    emptyText: '没有可汇总的格式',
  };
}

function errorBox(message: string, onRetry: () => void): HTMLElement {
  return el(
    'div',
    { class: 'results-inline-error' },
    el('span', {
      class: 'results-inline-error__text',
      text: `BD-rate 汇总计算失败：${message}`,
    }),
    button({ label: '重试', size: 'sm', onClick: onRetry }),
  );
}

function mountBdrateTab(host: HTMLElement, ctx: ViewCtx): MountedView {
  const mountRound = ctx.round;
  host.classList.add('bdrate-tab');

  const head = el('div', { class: 'bdrate-tab__head' });
  const title = el('h3', { class: 'bdrate-tab__title', text: 'BD-rate 汇总' });
  const reference = el('span', { class: 'bdrate-tab__ref' });
  head.append(title, reference);
  const legend = el('p', {
    class: 'bdrate-tab__legend',
    text: 'BD-rate 为负表示同画质下码率更低。',
  });
  const noteLine = el('p', { class: 'bdrate-tab__note' });
  const statusHost = el('div', { class: 'bdrate-tab__status-host' });
  const tableHost = el('div', { class: 'bdrate-tab__table' });
  host.append(head, legend, noteLine, statusHost, tableHost);

  let table: TableHandle | null = null;
  let summary: BdrateSummary | null = cachedBdrate(mountRound);
  let error: string | null = null;
  let loading = summary === null && mountRound.candidates.length > 0;
  let currentSignature = bdrateSignature(mountRound);
  let token = 0;
  let renderedKey = '';

  function currentRound(): Round {
    return liveRound(mountRound.id) ?? mountRound;
  }

  function dropTable(): void {
    table?.destroy();
    table = null;
  }

  async function load(): Promise<void> {
    const round = currentRound();
    if (round.candidates.length === 0) {
      token += 1;
      summary = null;
      error = null;
      loading = false;
      render(true);
      return;
    }
    const signature = bdrateSignature(round);
    const myToken = ++token;
    loading = true;
    error = null;
    render(true);
    try {
      const next = await roundBdrate(ctx.group.id, round.id);
      if (myToken !== token) return;
      summary = next;
      loading = false;
      error = null;
      rememberBdrate(round, next);
      const latest = bdrateSignature(currentRound());
      currentSignature = latest;
      // 请求期间跑分结果又变了：本次结果已经过期，直接再算一次（令牌会挡住旧响应）。
      if (latest !== signature) {
        void load();
        return;
      }
    } catch (err) {
      if (myToken !== token) return;
      loading = false;
      error = errorText(err);
      // 记下当前指纹，避免每次状态通知都自动重试；重试交给错误条上的按钮。
      currentSignature = bdrateSignature(currentRound());
    }
    render(true);
  }

  function render(force = false): void {
    const round = currentRound();
    const key = JSON.stringify([
      bdrateSignature(round),
      currentSignature,
      loading,
      error,
      summary,
    ]);
    if (!force && key === renderedKey) return;
    renderedKey = key;

    const hasRows = round.candidates.length > 0;
    head.hidden = !hasRows;
    legend.hidden = !hasRows;
    reference.textContent = summary
      ? summary.referenceFormat
        ? `参照格式：${summary.referenceFormat}`
        : '无可用参照格式'
      : '';
    noteLine.hidden = !summary?.note;
    noteLine.textContent = summary?.note ?? '';

    if (!hasRows) {
      dropTable();
      tableHost.hidden = true;
      statusHost.hidden = false;
      statusHost.replaceChildren(
        el('p', { class: 'results-empty-note', text: '跑分后这里出现 BD-rate 汇总' }),
      );
      return;
    }

    if (loading) {
      dropTable();
      tableHost.hidden = true;
      statusHost.hidden = false;
      statusHost.replaceChildren(
        el(
          'div',
          { class: 'bdrate-tab__loading' },
          spinner('正在计算 BD-rate'),
          el('span', { class: 'muted', text: '按格式拟合率失真曲线，通常很快' }),
        ),
      );
      return;
    }

    if (summary === null) {
      dropTable();
      tableHost.hidden = true;
      statusHost.hidden = false;
      statusHost.replaceChildren(
        error === null
          ? el('p', { class: 'muted', text: '尚未计算。' })
          : errorBox(error, () => void load()),
      );
      return;
    }

    tableHost.hidden = false;
    if (error === null) {
      statusHost.hidden = true;
      statusHost.replaceChildren();
    } else {
      statusHost.hidden = false;
      statusHost.replaceChildren(errorBox(error, () => void load()));
    }
    const spec = buildSpec(summary);
    if (table === null) table = mountTable(tableHost, spec);
    else table.update(spec);
  }

  function update(): void {
    const round = currentRound();
    const signature = bdrateSignature(round);
    if (signature !== currentSignature && !loading) {
      const cached = cachedBdrate(round);
      if (cached) {
        token += 1;
        currentSignature = signature;
        summary = cached;
        error = null;
        render(true);
        return;
      }
      if (round.candidates.length > 0) {
        void load();
        return;
      }
      token += 1;
      currentSignature = signature;
      summary = null;
      error = null;
      render(true);
      return;
    }
    render();
  }

  if (loading) void load();
  else render(true);

  return {
    update,
    destroy: () => {
      token += 1;
      dropTable();
      host.replaceChildren();
    },
  };
}

export const bdrateTab: DockTab = {
  id: 'bdrate',
  label: 'BD-rate',
  order: 20,
  kinds: ['image', 'video'],
  mount: mountBdrateTab,
};
