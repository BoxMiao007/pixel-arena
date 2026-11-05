// 结果坞「效率对比」页签：按体积排出每张跑分图，并判「划算」（决策 0035）。
//
// - 主表只依赖「体积更小 + 画质更高」的支配关系，1 张图也有内容，2 张起判划算；
// - 不再有 BD-rate：页签与导出报告都不再输出率失真拟合的结果（BD-rate 需要每格式
//   至少 3 个质量点，日常少图时只能给出「样本不足」）；
// - 点某一行让舞台切到那张跑分图，与评分表的交互一致。

import { formatRatio, formatSize } from '../../core/format';
import type { Round } from '../../core/model';
import { getActiveCandidate, setActiveCandidate } from '../../core/ui-state';
import { fileName, truncateFileName } from '../../core/util';
import { el } from '../../ui/dom';
import { badge } from '../../ui/primitives';
import { requestRender } from '../../shell/controller';
import type { DockTab, MountedView, ViewCtx } from '../../shell/registry';
import { buildEfficiencyTable, dominatorText, type EfficiencyTable } from './efficiency';
import { formatMetricFor } from './metrics';
import { liveRound } from './round';
import { createEdgeFade, type EdgeFade } from './scroll-edge';
import {
  mountTable,
  type TableColumn,
  type TableHandle,
  type TableRow,
  type TableSpec,
} from './table';

function efficiencyColumns(table: EfficiencyTable): TableColumn[] {
  return [
    { key: 'name', label: '跑分图', width: 190, title: '文件名' },
    { key: 'size', label: '体积', width: 92, align: 'end', title: '跑分图本身的大小' },
    { key: 'ratio', label: '体积比', width: 78, align: 'end', title: '相对原图的体积；小于 100% 表示压小了' },
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

/** 主表上方的一句提示：为什么不判划算 / 为什么没有内容。 */
function hintText(round: Round, table: EfficiencyTable | null): string {
  if (round.candidates.length === 0) return '';
  if (table === null) return '本轮没有可用于对比的画质指标，先跑分。';
  const parts: string[] = [];
  if (table.rows.length === 0) parts.push('本轮还没有跑分成功的图。');
  else if (!table.comparable) parts.push('只有 1 张可比较的跑分图，再加一张就能标出谁更划算。');
  if (table.skipped > 0) parts.push(`${table.skipped} 张未跑分或失败的图没有参与对比。`);
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
  // 与评分表同一套右缘渐隐（列多时提示还能横向滚动），随页签销毁解除监听。
  const edgeFade: EdgeFade = createEdgeFade(tableHost);
  const empty = el('p', {
    class: 'results-empty-note',
    text: '跑分后这里按体积排序列出每张图，并标出更划算的。',
  });
  host.append(head, legend, hint, tableHost, empty);

  let table: TableHandle | null = null;
  let renderedKey = '';

  function currentRound(): Round {
    return liveRound(mountRound.id) ?? mountRound;
  }

  function activate(path: string): void {
    setActiveCandidate(mountRound.id, path);
    requestRender();
  }

  function render(force = false): void {
    const round = currentRound();
    const view = buildEfficiencyTable(round);
    const activePath = getActiveCandidate(round.id);
    const key = JSON.stringify([view, activePath, round.referencePath, round.candidates.length]);
    if (!force && key === renderedKey) return;
    renderedKey = key;

    const hasCandidates = round.candidates.length > 0;
    head.hidden = !hasCandidates;
    legend.hidden = !hasCandidates;
    hint.hidden = !hasCandidates;
    empty.hidden = hasCandidates;
    reference.textContent =
      round.referencePath === null ? '还没有选原图' : `原图：${fileName(round.referencePath)}`;
    hint.textContent = hintText(round, view);

    if (!hasCandidates || view === null) {
      table?.destroy();
      table = null;
      edgeFade.track(null);
      tableHost.hidden = true;
      return;
    }

    tableHost.hidden = false;
    const spec = efficiencySpec(view, activePath, activate);
    if (table === null) table = mountTable(tableHost, spec);
    else table.update(spec);
    edgeFade.track(tableHost.querySelector<HTMLElement>('.results-table-scroll'));
  }

  render();

  return {
    update: () => render(),
    destroy: () => {
      edgeFade.destroy();
      table?.destroy();
      table = null;
      host.replaceChildren();
    },
  };
}

export const efficiencyTab: DockTab = {
  id: 'efficiency',
  label: '效率对比',
  order: 20,
  // 效率对比只对图片有意义；视频组不挂页签。
  kinds: ['image'],
  mount: mountEfficiencyTab,
};
