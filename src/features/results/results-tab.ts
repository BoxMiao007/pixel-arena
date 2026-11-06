// 结果坞「评分表」页签：列集合、最佳值、失败行展开、三态排序、列显隐。
//
// 生命周期：外壳在「分组/轮次/页签」变化时销毁并重新 mount，其余状态变化只调
// update()。排序与展开态按轮存在 core/ui-state 的 roundScoped 里，切页签不丢。
// 表格骨架（表头/行渲染/排序比较）在 ./table.ts，视频域只读复用。

import { formatRatio, formatSize } from '../../core/format';
import { highlightChips, type HighlightChip } from '../../core/highlight';
import { formatLabelForPath } from '../../core/format-label';
import type { CandidateImage, GroupKind, Round } from '../../core/model';
import { isBusy, isPathRunning } from '../../core/store';
import {
  getActiveCandidate,
  getPref,
  roundScoped,
  setActiveCandidate,
  setPref,
} from '../../core/ui-state';
import { copyText, fileName, truncateFileName } from '../../core/util';
import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { openPopover } from '../../ui/overlay';
import { button, iconButton } from '../../ui/primitives';
import { highlightChipList } from '../../ui/highlight-chips';
import { openImageMenu } from '../../ui/image-menu';
import { toast } from '../../ui/toast';
import { requestRender } from '../../shell/controller';
import type { DockTab, MountedView, ViewCtx } from '../../shell/registry';
import {
  formatMetricFor,
  metricHeaderTitle,
  metricMeta,
  metricPreferredDir,
  metricSortValue,
  orderMetricKeys,
} from './metrics';
import { rowStatus, rowStatusText } from './status';
import { liveRound } from './round';
import { createEdgeFade, type EdgeFade } from './scroll-edge';
import {
  mountTable,
  nextSortState,
  sortRowsBy,
  type SortState,
  type SortValue,
  type TableCell,
  type TableColumn,
  type TableHandle,
  type TableRow,
  type TableSpec,
} from './table';

/** 排序状态用对象包一层：roundScoped 返回同一个引用，改 .value 即可写回。 */
interface SortHolder {
  value: SortState | null;
}

interface ExpandedHolder {
  value: Set<string>;
}

interface ColumnDef {
  key: string;
  label: string;
  title?: string;
  align: 'start' | 'end';
  width: number;
  sortable: boolean;
  preferredDir: 1 | -1;
}

const COLUMN_WIDTHS = {
  // 220 → 240：带判断徽标的行要在文件名后留出约 60px，别把文件名截成认不出的样子
  name: 240,
  format: 84,
  fileSize: 96,
  sizeRatio: 88,
  encodingParams: 150,
  status: 128,
  note: 168,
  // 指标表头最长的是 SSIMULACRA2 / Butteraugli：104px 会把 11 个字母的单词
  // 在容器右缘切成半个字形，120px 留给「缩略号 + 排序箭头」刚刚够。
  metric: 120,
} as const;

function collectMetricKeys(candidates: readonly CandidateImage[]): string[] {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.metrics) continue;
    for (const key of Object.keys(candidate.metrics)) keys.add(key);
  }
  return orderMetricKeys(keys);
}

function hasEncodingParams(candidates: readonly CandidateImage[]): boolean {
  return candidates.some((candidate) => (candidate.encodingParams ?? '') !== '');
}

function hasNotes(candidates: readonly CandidateImage[]): boolean {
  return candidates.some((candidate) => (candidate.note ?? null) !== null);
}

/** 数据里已经出现过的可选列（只有它们能进列菜单）。 */
function availableOptional(metricKeys: readonly string[], candidates: readonly CandidateImage[]): Set<string> {
  const available = new Set<string>(metricKeys);
  available.add('format');
  if (hasEncodingParams(candidates)) available.add('encodingParams');
  if (hasNotes(candidates)) available.add('note');
  return available;
}

/** 默认可见：全部指标 + 有编码参数才显示参数列 + 有备注才显示备注列；格式列默认隐藏。 */
function defaultVisible(metricKeys: readonly string[], candidates: readonly CandidateImage[]): Set<string> {
  const visible = new Set<string>(metricKeys);
  if (hasEncodingParams(candidates)) visible.add('encodingParams');
  if (hasNotes(candidates)) visible.add('note');
  return visible;
}

/** 持久化偏好（可见列表）与当前数据求交；偏好为 null 时用默认列集。 */
function visibleOptional(round: Round, metricKeys: readonly string[]): Set<string> {
  const available = availableOptional(metricKeys, round.candidates);
  const stored = getPref('resultsColumns');
  if (stored === null) return defaultVisible(metricKeys, round.candidates);
  return new Set(stored.filter((key) => available.has(key)));
}

function columnDefs(visible: Set<string>, metricKeys: readonly string[]): ColumnDef[] {
  const defs: ColumnDef[] = [
    {
      key: 'name',
      label: '跑分图',
      title: '文件名；点开在查看器中查看这张图',
      align: 'start',
      width: COLUMN_WIDTHS.name,
      sortable: true,
      preferredDir: 1,
    },
  ];
  if (visible.has('format')) {
    defs.push({
      key: 'format',
      label: '格式',
      title: '按扩展名判定（已知格式固定显示名）',
      align: 'start',
      width: COLUMN_WIDTHS.format,
      sortable: true,
      preferredDir: 1,
    });
  }
  defs.push(
    {
      key: 'fileSize',
      label: '文件大小',
      title: '跑分图本身的大小',
      align: 'end',
      width: COLUMN_WIDTHS.fileSize,
      sortable: true,
      preferredDir: 1,
    },
    {
      key: 'sizeRatio',
      label: '体积比',
      title: '相对原图的体积；小于 100% 表示压小了',
      align: 'end',
      width: COLUMN_WIDTHS.sizeRatio,
      sortable: true,
      preferredDir: -1,
    },
  );
  if (visible.has('encodingParams')) {
    defs.push({
      key: 'encodingParams',
      label: '编码参数',
      title: '一站式或高级创建写入的参数；外部导入未知',
      align: 'start',
      width: COLUMN_WIDTHS.encodingParams,
      sortable: true,
      preferredDir: 1,
    });
  }
  for (const key of metricKeys) {
    if (!visible.has(key)) continue;
    const meta = metricMeta(key);
    defs.push({
      key,
      label: meta.label,
      title: metricHeaderTitle(meta),
      align: 'end',
      width: COLUMN_WIDTHS.metric,
      sortable: true,
      preferredDir: metricPreferredDir(meta),
    });
  }
  defs.push({
    key: 'status',
    label: '状态',
    title: '失败原因可点开查看与复制',
    align: 'start',
    width: COLUMN_WIDTHS.status,
    sortable: false,
    preferredDir: -1,
  });
  if (visible.has('note')) {
    defs.push({
      key: 'note',
      label: '备注',
      title: '目标大小方式的不可达标注',
      align: 'start',
      width: COLUMN_WIDTHS.note,
      sortable: false,
      preferredDir: -1,
    });
  }
  return defs;
}

function toTableColumn(def: ColumnDef): TableColumn {
  return {
    key: def.key,
    label: def.label,
    title: def.title,
    align: def.align,
    width: def.width,
    sortable: def.sortable,
    preferredDir: def.preferredDir,
  };
}

function sortValueFor(candidate: CandidateImage, key: string): SortValue {
  switch (key) {
    case 'name':
      return fileName(candidate.path);
    case 'format':
      return formatLabelForPath(candidate.path);
    case 'fileSize':
      return candidate.fileSize;
    case 'sizeRatio':
      return candidate.sizeRatio;
    case 'encodingParams':
      return candidate.encodingParams ?? null;
    default:
      return metricSortValue(candidate.metrics?.[key]);
  }
}

export interface BestValue {
  value: number;
  /** 有值的行数：只有一行有值时不高亮（整列发亮没有信息量）。 */
  present: number;
}

/** 每列最优值（只对「越小/越大更好」的数值列算）；失败行与缺值不参与。 */
export function bestValues(candidates: readonly CandidateImage[], metricKeys: readonly string[]): Map<string, BestValue> {
  const best = new Map<string, BestValue>();
  const scored = candidates.filter((candidate) => candidate.error === null && candidate.metrics !== null);

  const consider = (key: string, value: number, better: 'higher' | 'lower'): void => {
    const current = best.get(key);
    if (!current) {
      best.set(key, { value, present: 1 });
      return;
    }
    current.present += 1;
    const isBetter = better === 'higher' ? value > current.value : value < current.value;
    if (isBetter) current.value = value;
  };

  for (const key of metricKeys) {
    const better = metricMeta(key).better;
    for (const candidate of scored) {
      const value = metricSortValue(candidate.metrics?.[key]);
      if (value === null) continue;
      consider(key, value, better);
    }
  }
  for (const candidate of candidates) {
    if (candidate.error !== null) continue;
    consider('fileSize', candidate.fileSize, 'lower');
    if (candidate.sizeRatio !== null) consider('sizeRatio', candidate.sizeRatio, 'lower');
  }
  return best;
}

function isBest(best: Map<string, BestValue>, key: string, value: number | null): boolean {
  if (value === null) return false;
  const entry = best.get(key);
  return entry !== undefined && entry.present > 1 && entry.value === value;
}

/**
 * 单元格内容（除带交互的文件名列与状态列）。纯函数：最优值标记、格式化都在这层
 * 决定，表格骨架只负责把它画出来（含 srText 的视觉隐藏文本）。
 */
export function formatCellFor(candidate: CandidateImage, key: string, best: Map<string, BestValue>): TableCell {
  switch (key) {
    case 'format':
      return { text: formatLabelForPath(candidate.path) };
    case 'fileSize': {
      const isTop = candidate.error === null && isBest(best, key, candidate.fileSize);
      return {
        text: formatSize(candidate.fileSize),
        title: isTop ? '本列最小' : undefined,
        className: isTop ? 'is-best' : undefined,
        srText: isTop ? '最佳' : undefined,
      };
    }
    case 'sizeRatio': {
      const value = candidate.sizeRatio;
      const isTop = value !== null && isBest(best, key, value);
      return {
        text: value === null ? '—' : formatRatio(value),
        title: isTop ? '本列最小' : undefined,
        className: isTop ? 'is-best' : undefined,
        srText: isTop ? '最佳' : undefined,
      };
    }
    case 'encodingParams':
      return {
        text: candidate.encodingParams || '—',
        title: candidate.encodingParams ?? undefined,
      };
    case 'note':
      return { text: candidate.note ?? '', title: candidate.note ?? undefined };
    default: {
      const value = metricSortValue(candidate.metrics?.[key]);
      const isTop = isBest(best, key, value);
      return {
        text: formatMetricFor(key, candidate.metrics?.[key]),
        title: isTop ? `${metricMeta(key).label} 本列最优` : undefined,
        className: isTop ? 'is-best' : undefined,
        srText: isTop ? '最佳' : undefined,
      };
    }
  }
}

function referenceCellFor(key: string, round: Round): TableCell | null {
  const path = round.referencePath ?? '';
  switch (key) {
    case 'name':
      return {
        text: path === '' ? '' : `${truncateFileName(fileName(path))}（原图）`,
        title: path,
      };
    case 'format':
      return { text: path === '' ? '—' : formatLabelForPath(path) };
    case 'fileSize':
      return { text: round.referenceSize === null ? '—' : formatSize(round.referenceSize) };
    case 'sizeRatio':
      return { text: '100%' };
    case 'encodingParams':
      return { text: '—' };
    case 'status':
      return { text: '基准' };
    default:
      return { text: '—' };
  }
}

/**
 * 无结果空态的一行说明（不铺大空态组件、不占满结果坞，样式见 results.css）。
 * 视频分组里这张表仍用于旧工作区的图片结果，所以文案要说清「会显示在这里」。
 */
export function emptyNoteText(kind: GroupKind): string {
  return kind === 'video' ? '旧工作区的图片跑分结果会显示在这里' : '跑分后这里出现指标表';
}

/**
 * 评分表页签的挂载句柄。比通用 MountedView 多一个可选动作入口：外壳把
 * 「列选择」这类页签自己的按钮挂到结果坞页签行右侧（shell/regions.ts 的 mountDock），
 * 这样页签内容区顶部不再需要一条只有图标的 34px 工具条。
 */
export interface ResultsTabView extends MountedView {
  mountDockActions(actionHost: HTMLElement): MountedView;
}

function mountResultsTab(host: HTMLElement, ctx: ViewCtx): ResultsTabView {
  const roundId = ctx.round.id;
  const sortHolder = roundScoped<SortHolder>('results.sort', roundId, () => ({ value: null }));
  const expandedHolder = roundScoped<ExpandedHolder>('results.expanded', roundId, () => ({
    value: new Set<string>(),
  }));

  host.classList.add('results-tab');
  const tableHost = el('div', { class: 'results-tab__table is-frozen-name' });
  const emptyHost = el('div', { class: 'results-tab__empty' });
  const statusLine = el('div', {
    class: 'results-tab__status',
    attrs: { 'aria-live': 'polite' },
  });
  // 表格直接贴页签行：内容区不再留一条只放图标按钮的空带。
  host.append(tableHost, emptyHost, statusLine);
  // 横向溢出提示（右缘渐隐）的监听跟着表格走，随本句柄一起销毁。
  const edgeFade: EdgeFade = createEdgeFade(tableHost);

  let table: TableHandle | null = null;
  let lastSignature = '';

  /** 当前轮的数据（store 找不到时回落到挂载时的快照）。 */
  function currentRound(): Round {
    return liveRound(roundId) ?? ctx.round;
  }

  function signatureOf(round: Round): string {
    const metricKeys = collectMetricKeys(round.candidates);
    const visible = visibleOptional(round, metricKeys);
    const running = round.candidates.map((candidate) => (isPathRunning(candidate.path) ? 1 : 0)).join('');
    const data = round.candidates.map((candidate) =>
      [
        candidate.path,
        candidate.fileSize,
        candidate.sizeRatio,
        candidate.error,
        candidate.note,
        candidate.encodingParams,
        candidate.metrics ? JSON.stringify(candidate.metrics) : '',
      ].join('\u0001'),
    );
    const video = (round.videoCandidates ?? []).map((candidate) => candidate.path).join('\u0001');
    return JSON.stringify([
      round.id,
      round.name,
      round.referencePath,
      round.referenceSize,
      round.videoReferencePath ?? null,
      video,
      sortHolder.value,
      [...visible],
      [...expandedHolder.value],
      getActiveCandidate(roundId),
      isBusy(),
      running,
      data,
    ]);
  }

  function buildSpec(round: Round): { spec: TableSpec; columns: ColumnDef[] } {
    const metricKeys = collectMetricKeys(round.candidates);
    const visible = visibleOptional(round, metricKeys);
    const columns = columnDefs(visible, metricKeys);
    const best = bestValues(round.candidates, metricKeys);
    // 本轮判断徽标（画质最好 / 体积最小 / 综合最优）：和检视器列表、多视图角标同一份判定。
    const chips = highlightChips(round.candidates);
    const activePath = getActiveCandidate(roundId);
    const expanded = expandedHolder.value;
    const sort = sortHolder.value;

    const sorted = sortRowsBy(
      round.candidates,
      sort,
      (candidate) => sortValueFor(candidate, sort?.key ?? ''),
      (candidate) => candidate.path,
    );

    const rows: TableRow[] = sorted.map((candidate, index) => ({
      key: candidate.path,
      // 名次列的第 1 名单独标出来（样式只改数字颜色，不做彩条卡片）。
      className: index === 0 ? 'is-rank-one' : undefined,
      cells: columns.map((column) => {
        if (column.key === 'name') return nameCell(candidate, chips.get(candidate.path));
        if (column.key === 'status') return statusCell(candidate, expanded.has(candidate.path));
        return formatCellFor(candidate, column.key, best);
      }),
      selected: activePath === candidate.path,
      onActivate: () => activate(candidate.path),
      // 右键图片菜单：另存为 / 打开图片 / 打开文件位置 / 复制路径（与查看器画布同一份）。
      onContextMenu: (event) => {
        openImageMenu(event.currentTarget as HTMLElement, candidate.path, {
          at: { x: event.clientX, y: event.clientY },
        });
      },
      detail: expanded.has(candidate.path) ? errorDetail(candidate.error ?? '') : null,
    }));

    const pinned: TableRow[] = [];
    if (round.referencePath !== null) {
      pinned.push({
        key: `reference:${round.referencePath}`,
        rankText: '基准',
        className: 'results-table__reference',
        cells: columns.map((column) => referenceCellFor(column.key, round)),
        onContextMenu: (event) => {
          const path = round.referencePath;
          if (path === null) return;
          openImageMenu(event.currentTarget as HTMLElement, path, {
            at: { x: event.clientX, y: event.clientY },
          });
        },
      });
    }

    return {
      columns,
      spec: {
        caption: `评分结果（${round.name}）`,
        columns: columns.map(toTableColumn),
        pinned,
        rows,
        sort,
        onSort: (key) => {
          const column = columns.find((item) => item.key === key);
          if (!column) return;
          sortHolder.value = nextSortState(sortHolder.value, key, column.preferredDir);
          paint();
        },
        emptyText: '还没有跑分图',
      },
    };
  }

  function nameCell(candidate: CandidateImage, chips: readonly HighlightChip[] | undefined): TableCell {
    const node = el(
      'button',
      {
        class: 'results-table__name',
        title: candidate.path,
        attrs: { type: 'button', 'aria-label': `在查看器中查看 ${fileName(candidate.path)}` },
        on: {
          click: (event) => {
            event.stopPropagation();
            activate(candidate.path);
          },
        },
      },
      el('span', { class: 'truncate', text: truncateFileName(fileName(candidate.path)) }),
    );
    const chipList = highlightChipList(chips);
    if (!chipList) return { node };
    // 徽标跟文件名同一格：本轮只有少数几行会拿到帽子，挤占宽度可接受；
    // 文件名已经自带 truncate，窄列时让位给徽标（完整路径仍在按钮 title 里）。
    return { node: el('span', { class: 'results-table__name-cell' }, node, chipList) };
  }

  function statusCell(candidate: CandidateImage, isExpanded: boolean): TableCell {
    const status = rowStatus(candidate, isPathRunning(candidate.path));
    const text = rowStatusText(status, candidate.error);
    if (status !== 'fail') {
      return { text, className: `results-status results-status--${status}` };
    }
    const node = el(
      'button',
      {
        class: 'results-status results-status--fail results-status--toggle',
        title: candidate.error ?? '',
        attrs: {
          type: 'button',
          'aria-expanded': String(isExpanded),
          'aria-label': `${text}，${isExpanded ? '收起' : '展开'}失败原因`,
        },
        on: {
          click: (event) => {
            event.stopPropagation();
            toggleExpanded(candidate.path);
          },
        },
      },
      el('span', { class: 'truncate', text }),
      icon(isExpanded ? 'chevronUp' : 'chevronDown', 'icon icon--12'),
    );
    return { node };
  }

  function errorDetail(error: string): HTMLElement {
    return el(
      'div',
      { class: 'results-detail' },
      el('pre', { class: 'results-detail__text', text: error }),
      button({
        label: '复制错误',
        size: 'sm',
        variant: 'quiet',
        onClick: () => copyText(error, () => toast('已复制失败原因', 'ok')),
      }),
    );
  }

  function toggleExpanded(path: string): void {
    if (expandedHolder.value.has(path)) expandedHolder.value.delete(path);
    else expandedHolder.value.add(path);
    paint();
    focusRow(path, '.results-status--toggle');
  }

  function activate(path: string): void {
    setActiveCandidate(roundId, path);
    requestRender();
    focusRow(path, '.results-table__name');
  }

  /** 焦点还原：tbody 每次重建，点击目标节点会被换掉，按行键 + 选择器找回。 */
  function focusRow(path: string, selector: string): void {
    for (const row of tableHost.querySelectorAll<HTMLElement>('[data-row-key]')) {
      if (row.dataset.rowKey !== path) continue;
      row.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
      return;
    }
  }

  function openColumnsMenu(anchor: HTMLElement): void {
    const round = currentRound();
    const metricKeys = collectMetricKeys(round.candidates);
    const available = availableOptional(metricKeys, round.candidates);
    const visible = visibleOptional(round, metricKeys);
    const content = el('div', { class: 'results-columns' });
    content.append(el('p', { class: 'results-columns__title', text: '显示列' }));

    const items: { key: string; label: string }[] = [];
    if (available.has('format')) items.push({ key: 'format', label: '格式' });
    if (available.has('encodingParams')) items.push({ key: 'encodingParams', label: '编码参数' });
    if (available.has('note')) items.push({ key: 'note', label: '备注' });
    for (const key of metricKeys) items.push({ key, label: metricMeta(key).label });

    const sortKey = sortHolder.value?.key ?? null;
    for (const item of items) {
      const checkIcon = el('span', { class: 'results-columns__check' });
      const updateCheck = (on: boolean): void => {
        checkIcon.replaceChildren(...(on ? [icon('check', 'icon icon--12')] : []));
      };
      updateCheck(visible.has(item.key));
      const row = el(
        'button',
        {
          class: 'results-columns__item',
          attrs: {
            type: 'button',
            'aria-pressed': String(visible.has(item.key)),
          },
          on: {
            click: () => {
              const on = row.getAttribute('aria-pressed') !== 'true';
              row.setAttribute('aria-pressed', String(on));
              updateCheck(on);
              toggleColumn(item.key, on);
            },
          },
        },
        checkIcon,
        el('span', { class: 'results-columns__label', text: item.label }),
      );
      content.append(row);
    }
    if (sortKey !== null && items.every((item) => item.key !== sortKey)) {
      content.append(
        el('p', { class: 'results-columns__hint', text: '当前排序列不在可选项里' }),
      );
    }
    openPopover(anchor, content, { align: 'end', label: '选择显示的列' });
  }

  function toggleColumn(key: string, on: boolean): void {
    const round = currentRound();
    const metricKeys = collectMetricKeys(round.candidates);
    const next = visibleOptional(round, metricKeys);
    if (on) next.add(key);
    else next.delete(key);
    setPref('resultsColumns', [...next]);
    // 排序键被隐藏时回到选入顺序，避免「看不到排序依据」。
    if (sortHolder.value?.key === key) sortHolder.value = null;
    paint();
  }

  function paint(): void {
    const round = currentRound();
    const signature = signatureOf(round);
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (round.candidates.length === 0) {
      if (table) table.destroy();
      table = null;
      edgeFade.track(null);
      tableHost.hidden = true;
      emptyHost.hidden = false;
      emptyHost.replaceChildren(
        el('p', {
          class: 'results-empty-note',
          text: emptyNoteText(ctx.group.kind),
        }),
      );
      statusLine.hidden = true;
      statusLine.textContent = '';
      return;
    }

    tableHost.hidden = false;
    emptyHost.hidden = true;
    emptyHost.replaceChildren();
    statusLine.hidden = false;

    const { spec, columns } = buildSpec(round);
    if (!table) table = mountTable(tableHost, spec);
    else table.update(spec);

    // 外部来源（查看器聚焦栏/格）改了 activeCandidate 时，选中行可能不在可视区：
    // 只在选中行存在且不在视口内时平滑滚过去，用户手动点行时由 focusRow 管焦点。
    const selectedRow = tableHost.querySelector<HTMLElement>('tr.is-selected');
    if (selectedRow) {
      const scroll = tableHost.querySelector<HTMLElement>('.results-table-scroll');
      if (scroll) {
        const sr = scroll.getBoundingClientRect();
        const rr = selectedRow.getBoundingClientRect();
        if (rr.bottom > sr.bottom || rr.top < sr.top) {
          selectedRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }
    // 列集合/行数变了之后重新量一次溢出：表格是 table-layout: fixed，列宽变了
    // 容器宽度不变，ResizeObserver 不会触发，只能在这里同步。
    edgeFade.track(tableHost.querySelector<HTMLElement>('.results-table-scroll'));

    const sort = sortHolder.value;
    let sortLabel = '按选入顺序';
    if (sort) {
      const label = columns.find((column) => column.key === sort.key)?.label ?? sort.key;
      sortLabel = `按${label}${sort.dir === 1 ? '升序' : '降序'}`;
    }
    statusLine.textContent = `${sortLabel}，共 ${round.candidates.length} 行`;
  }

  /**
   * 页签行右侧的「选择显示的列」按钮。外壳在页签挂载后调一次，页签销毁时调
   * 返回句柄的 destroy()——按钮与页签同生命周期，切页签/切轮不会留下悬挂按钮。
   * 幂等：重复调用只会把同一个按钮重新挂回（不叠加），折叠态由 CSS 隐藏。
   */
  let dockActionHost: HTMLElement | null = null;
  let columnsButton: HTMLButtonElement | null = null;

  function mountDockActions(actionHost: HTMLElement): MountedView {
    if (columnsButton === null) {
      columnsButton = iconButton({
        icon: 'layers',
        label: '选择显示的列',
        variant: 'quiet',
        size: 'sm',
        onClick: (event) => {
          const anchor = event.currentTarget;
          if (anchor instanceof HTMLElement) openColumnsMenu(anchor);
        },
      });
    }
    const button = columnsButton;
    dockActionHost = actionHost;
    actionHost.replaceChildren(button);
    return {
      // 菜单每次打开时现读当前轮数据，按钮本身没有需要增量更新的状态。
      update: () => {},
      destroy: () => {
        if (dockActionHost !== actionHost) return;
        actionHost.replaceChildren();
        dockActionHost = null;
      },
    };
  }

  paint();
  return {
    update: paint,
    mountDockActions,
    destroy: () => {
      edgeFade.destroy();
      table?.destroy();
      table = null;
      host.replaceChildren();
    },
  };
}

export const resultsTab: DockTab = {
  id: 'results',
  label: '评分表',
  order: 10,
  kinds: ['image', 'video'],
  mount: mountResultsTab,
};
