// 结果坞「效率对比」页签：少图也能用的体积/画质对比，多质量点时附 BD-rate。
//
// 与旧的「BD-rate」页签的差别（docs/decisions.md 0034）：
// - 主表只依赖「体积更小 + 画质更高」的支配关系，1 张图也有内容，2 张起判「划算」；
// - BD-rate 从「页签的主角」降为下方的补充节，且只在至少两个格式各有 3 个有损
//   质量点时才请求（否则核心库只会返回「样本不足」）；
// - 点某一行让舞台切到那张跑分图，与评分表的交互一致。

import { formatRatio, formatSize } from '../../core/format';
import type { Round } from '../../core/model';
import { getActiveCandidate, setActiveCandidate } from '../../core/ui-state';
import { errorText, fileName, truncateFileName } from '../../core/util';
import { el } from '../../ui/dom';
import { badge, button, spinner } from '../../ui/primitives';
import { requestRender } from '../../shell/controller';
import type { DockTab, MountedView, ViewCtx } from '../../shell/registry';
import { bdrateSignature, cachedBdrate, rememberBdrate } from './bdrate';
import {
  bdrateEligibility,
  buildEfficiencyTable,
  dominatorText,
  type BdrateEligibility,
  type EfficiencyTable,
} from './efficiency';
import { roundBdrate, type BdrateSummary } from './ipc';
import { formatBdRateCell, formatMetricFor } from './metrics';
import { liveRound } from './round';
import {
  mountTable,
  type TableColumn,
  type TableHandle,
  type TableRow,
  type TableSpec,
} from './table';

const BDRATE_COLUMNS: TableColumn[] = [
  { key: 'format', label: '格式', width: 110 },
  { key: 'bdrate', label: 'BD-rate', width: 104, align: 'end' },
  { key: 'points', label: '样本点', width: 84, align: 'end' },
  { key: 'note', label: '说明', width: 280 },
];

function efficiencyColumns(table: EfficiencyTable): TableColumn[] {
  return [
    { key: 'name', label: '跑分图', width: 190 },
    { key: 'size', label: '体积', width: 92, align: 'end' },
    { key: 'ratio', label: '体积比', width: 78, align: 'end' },
    {
      key: 'quality',
      label: table.metric.label,
      title: table.metric.hint,
      width: 104,
      align: 'end',
    },
    { key: 'verdict', label: '判定', width: 84 },
    { key: 'why', label: '说明', width: 264 },
  ];
}

function efficiencySpec(
  table: EfficiencyTable,
  activePath: string | null,
  onActivate: (path: string) => void,
): TableSpec {
  const rows: TableRow[] = table.rows.map((row) => {
    const why = row.frontier
      ? '没有更小又更高画质的图'
      : row.dominator !== null
        ? dominatorText(row, table.metric)
        : table.comparable
          ? ''
          : '再加一张跑分图就能标出谁更划算';
    // 不足两张时不判「划算」：唯一一张图没有可比对象，标绿反而误导。
    const verdict = row.frontier
      ? { node: badge('划算', 'ok', '没有更小又更高画质的图') }
      : table.comparable
        ? { text: '不划算', className: 'efficiency-tab__verdict' }
        : { text: '—' };
    return {
      key: row.path,
      selected: activePath === row.path,
      onActivate: () => onActivate(row.path),
      cells: [
        {
          node: el('span', {
            class: 'results-table__name',
            text: truncateFileName(fileName(row.path), 30),
            title: row.path,
          }),
        },
        { text: formatSize(row.fileSize) },
        { text: row.sizeRatio === null ? '—' : formatRatio(row.sizeRatio) },
        { text: formatMetricFor(table.metric.key, row.value) },
        verdict,
        { text: why, title: why },
      ],
    };
  });
  return {
    caption: '效率对比：按体积升序的跑分图与画质',
    columns: efficiencyColumns(table),
    rows,
    sort: null,
    onSort: () => {},
    emptyText: '还没有可对比的跑分图',
  };
}

function bdrateSpec(summary: BdrateSummary): TableSpec {
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
    caption: `BD-rate 汇总${summary.referenceFormat ? `（参照格式：${summary.referenceFormat}）` : ''}`,
    columns: BDRATE_COLUMNS,
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
    el('span', { class: 'results-inline-error__text', text: `BD-rate 汇总计算失败：${message}` }),
    button({ label: '重试', size: 'sm', onClick: onRetry }),
  );
}

/** 主表下方的一句提示：为什么不判划算 / 为什么没有 BD-rate。 */
function hintText(
  round: Round,
  table: EfficiencyTable | null,
  eligibility: BdrateEligibility,
): string {
  if (round.candidates.length === 0) return '';
  const parts: string[] = [];
  if (table === null) {
    parts.push('本轮没有可用于对比的画质指标，先跑分。');
  } else {
    if (table.rows.length === 0) parts.push('本轮还没有跑分成功的图。');
    else if (!table.comparable) parts.push('只有 1 张可比较的跑分图，再加一张就能标出谁更划算。');
    if (table.skipped > 0) parts.push(`${table.skipped} 张未跑分或失败的图没有参与对比。`);
  }
  if (!eligibility.enabled) {
    parts.push(
      eligibility.maxPoints > 0
        ? `BD-rate 需要每个格式至少 3 个质量点（本轮最多 ${eligibility.maxPoints} 个），所以不显示；要多点可在检视器「编码阶梯」里用「质量优先」。`
        : 'BD-rate 需要每个格式至少 3 个有损质量点，本轮还没有，所以不显示。',
    );
  }
  return parts.join(' ');
}

function mountEfficiencyTab(host: HTMLElement, ctx: ViewCtx): MountedView {
  const mountRound = ctx.round;
  host.classList.add('efficiency-tab');

  const head = el('div', { class: 'efficiency-tab__head' });
  const title = el('h3', { class: 'efficiency-tab__title', text: '效率对比' });
  const reference = el('span', { class: 'efficiency-tab__ref' });
  head.append(title, reference);
  const legend = el('p', {
    class: 'efficiency-tab__legend',
    text: '同体积下画质更高、同画质下体积更小才算划算。',
  });
  const hint = el('p', { class: 'efficiency-tab__note' });
  const tableHost = el('div', { class: 'efficiency-tab__table' });

  const bdrateSection = el('section', { class: 'efficiency-tab__bdrate' });
  const bdrateHead = el('div', { class: 'efficiency-tab__bdrate-head' });
  const bdrateTitle = el('h4', { class: 'efficiency-tab__bdrate-title', text: 'BD-rate' });
  const bdrateLegend = el('span', {
    class: 'efficiency-tab__bdrate-legend',
    text: '负值 = 同画质下更省码率',
  });
  bdrateHead.append(bdrateTitle, bdrateLegend);
  const bdrateStatus = el('div', { class: 'efficiency-tab__status' });
  const bdrateTableHost = el('div', { class: 'efficiency-tab__bdrate-table' });
  bdrateSection.append(bdrateHead, bdrateStatus, bdrateTableHost);

  const empty = el('p', {
    class: 'results-empty-note',
    text: '跑分后这里按体积与画质排出谁更划算',
  });
  host.append(head, legend, hint, tableHost, bdrateSection, empty);

  let table: TableHandle | null = null;
  let bdrateTable: TableHandle | null = null;
  let summary: BdrateSummary | null = null;
  let error: string | null = null;
  let loading = false;
  let attemptedSignature = '';
  let inFlight: string | null = null;
  let renderedKey = '';

  function currentRound(): Round {
    return liveRound(mountRound.id) ?? mountRound;
  }

  function dropTable(): void {
    table?.destroy();
    table = null;
  }

  function dropBdrateTable(): void {
    bdrateTable?.destroy();
    bdrateTable = null;
  }

  async function loadBdrate(round: Round, signature: string): Promise<void> {
    inFlight = signature;
    loading = true;
    error = null;
    summary = null;
    render(true);
    try {
      const next = await roundBdrate(ctx.group.id, round.id);
      if (inFlight !== signature) return; // 已切轮或指纹已变，丢弃旧响应
      inFlight = null;
      summary = next;
      loading = false;
      attemptedSignature = signature;
      rememberBdrate(round, next);
      const latest = bdrateSignature(currentRound());
      if (latest !== signature) {
        // 计算期间跑分结果又变了：让下一次 refresh 重新取（不在这里递归）。
        attemptedSignature = '';
      }
    } catch (err) {
      if (inFlight !== signature) return;
      inFlight = null;
      loading = false;
      error = errorText(err);
      // 记下指纹，避免每次状态通知都自动重试；重试交给错误条上的按钮。
      attemptedSignature = bdrateSignature(currentRound());
    }
    render(true);
  }

  /** 按当前数据决定是否要（重新）取 BD-rate 汇总。 */
  function syncBdrate(round: Round): BdrateEligibility {
    const eligibility = bdrateEligibility(round);
    if (!eligibility.enabled) {
      inFlight = null;
      summary = null;
      error = null;
      loading = false;
      attemptedSignature = '';
      return eligibility;
    }
    const signature = bdrateSignature(round);
    if (signature === attemptedSignature || signature === inFlight) return eligibility;
    const cached = cachedBdrate(round);
    if (cached) {
      summary = cached;
      error = null;
      loading = false;
      attemptedSignature = signature;
      return eligibility;
    }
    void loadBdrate(round, signature);
    return eligibility;
  }

  function activate(path: string): void {
    setActiveCandidate(mountRound.id, path);
    requestRender();
  }

  function render(force = false): void {
    const round = currentRound();
    const view = buildEfficiencyTable(round);
    const eligibility = bdrateEligibility(round);
    const activePath = getActiveCandidate(round.id);
    const key = JSON.stringify([
      view,
      eligibility,
      loading,
      error,
      summary,
      activePath,
      round.referencePath,
      round.candidates.length,
    ]);
    if (!force && key === renderedKey) return;
    renderedKey = key;

    const hasCandidates = round.candidates.length > 0;
    head.hidden = !hasCandidates;
    legend.hidden = !hasCandidates;
    hint.hidden = !hasCandidates;
    empty.hidden = hasCandidates;
    reference.textContent =
      round.referencePath === null ? '还没有选原图' : `原图：${fileName(round.referencePath)}`;
    hint.textContent = hintText(round, view, eligibility);

    if (!hasCandidates || view === null) {
      dropTable();
      tableHost.hidden = true;
      bdrateSection.hidden = true;
      dropBdrateTable();
      return;
    }

    tableHost.hidden = false;
    const spec = efficiencySpec(view, activePath, activate);
    if (table === null) table = mountTable(tableHost, spec);
    else table.update(spec);

    bdrateSection.hidden = !eligibility.enabled;
    if (bdrateSection.hidden) {
      dropBdrateTable();
      bdrateStatus.hidden = true;
      bdrateStatus.replaceChildren();
      return;
    }

    bdrateTitle.textContent = summary?.referenceFormat
      ? `BD-rate（参照格式：${summary.referenceFormat}）`
      : 'BD-rate';

    if (loading) {
      dropBdrateTable();
      bdrateTableHost.hidden = true;
      bdrateStatus.hidden = false;
      bdrateStatus.replaceChildren(
        el(
          'div',
          { class: 'efficiency-tab__loading' },
          spinner('正在计算 BD-rate'),
          el('span', { class: 'muted', text: '按格式拟合率失真曲线' }),
        ),
      );
      return;
    }

    if (summary === null) {
      dropBdrateTable();
      bdrateTableHost.hidden = true;
      bdrateStatus.hidden = false;
      bdrateStatus.replaceChildren(
        errorBox(error ?? '未知原因', () => {
          attemptedSignature = '';
          inFlight = null;
          refresh();
        }),
      );
      return;
    }

    if (error !== null) {
      bdrateStatus.hidden = false;
      bdrateStatus.replaceChildren(
        errorBox(error, () => {
          attemptedSignature = '';
          inFlight = null;
          refresh();
        }),
      );
    } else {
      bdrateStatus.hidden = true;
      bdrateStatus.replaceChildren();
    }
    bdrateTableHost.hidden = false;
    const specBd = bdrateSpec(summary);
    if (bdrateTable === null) bdrateTable = mountTable(bdrateTableHost, specBd);
    else bdrateTable.update(specBd);
  }

  /** 数据变化后同时刷新 BD-rate 的取数与界面。 */
  function refresh(): void {
    syncBdrate(currentRound());
    render();
  }

  refresh();

  return {
    update: () => refresh(),
    destroy: () => {
      inFlight = null;
      dropTable();
      dropBdrateTable();
      host.replaceChildren();
    },
  };
}

export const efficiencyTab: DockTab = {
  id: 'efficiency',
  label: '效率对比',
  order: 20,
  // BD-rate 的拟合只针对图片；视频组的 BD-rate 页签从来没有数据，索性不再挂。
  kinds: ['image'],
  mount: mountEfficiencyTab,
};