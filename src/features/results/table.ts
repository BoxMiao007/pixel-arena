// 结果表骨架：列配置 + 行渲染 + 三态排序。图片结果表与视频结果表共用。
//
// 本模块刻意不认识任何业务字段：列宽、表头文案、每格文本、每行排序键都由调用方
// 预先算好传进来（TableSpec）。这样视频域只 import 不修改就能复用同一套骨架，
// 而排序方向、最佳值、失败展开这些「图片语义」留在各自域里。
//
// 更新策略：
// - 列集合（键/文案/宽度/对齐）变化才重建 thead 与 colgroup，重建后把焦点还给
//   同一个 [data-sort-key]；
// - 每次 update 只重建 tbody（行数 10–60 量级，一次 DocumentFragment 提交），
//   表格滚动位置保留；
// - 排序按钮的箭头与 aria-sort 原位更新，不触发 thead 重建，所以点排序不会丢焦点。

import { el } from '../../ui/dom';
import { icon } from '../../ui/icons';

export interface SortState {
  key: string;
  dir: 1 | -1;
}

export type SortValue = number | string | null;

/** 三态排序：无 → 首选方向 → 反向 → 无。 */
export function nextSortState(
  current: SortState | null,
  key: string,
  preferred: 1 | -1,
): SortState | null {
  if (!current || current.key !== key) return { key, dir: preferred };
  if (current.dir === preferred) return { key, dir: preferred === 1 ? -1 : 1 };
  return null;
}

/**
 * 比较两个排序值：缺值恒沉底（与升降序无关）；字符串按 zh-CN 本地序；
 * 数值用大小比较（不用相减，避免 +∞ − +∞ = NaN 破坏排序）。
 */
export function compareSortValues(a: SortValue, b: SortValue, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, 'zh-CN') * dir;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return 0;
    return (a < b ? -1 : 1) * dir;
  }
  // 同一列类型恒定；真混进来也不让排序崩掉。
  return 0;
}

/**
 * 稳定排序：主键相同时用 stableKey 兜底，保证跑分中局部刷新不会让等值行互换位置。
 * sort 为 null 时原样返回（调用方保持选入顺序）。
 */
export function sortRowsBy<T>(
  rows: readonly T[],
  sort: SortState | null,
  valueOf: (row: T) => SortValue,
  stableKey: (row: T) => string,
): T[] {
  const list = [...rows];
  if (!sort) return list;
  const { dir } = sort;
  list.sort((a, b) => {
    const primary = compareSortValues(valueOf(a), valueOf(b), dir);
    if (primary !== 0) return primary;
    return stableKey(a).localeCompare(stableKey(b), 'zh-CN');
  });
  return list;
}

export interface TableColumn {
  /** 列 id，同时是排序键。 */
  key: string;
  label: string;
  /** 表头悬浮说明（单位、优方向等）。 */
  title?: string;
  /** 数字列右对齐。 */
  align?: 'start' | 'end';
  /** 列宽（px，table-layout: fixed）。 */
  width: number;
  sortable?: boolean;
  /** 首次点击的排序方向；缺省降序。 */
  preferredDir?: 1 | -1;
}

export interface TableCell {
  text?: string;
  /** 自定义内容（如失败状态按钮），给出时忽略 text。 */
  node?: HTMLElement;
  title?: string;
  /** 视觉隐藏的补充文本，读屏能读到（如「最佳」）。 */
  srText?: string;
  className?: string;
}

export interface TableRow {
  /** 行身份（跑分图路径等），用于选中与定位。 */
  key: string;
  /** 与 columns 一一对应；null 表示空单元格。 */
  cells: readonly (TableCell | null)[];
  className?: string;
  selected?: boolean;
  /** 固定行的排名列文本（原图基准行写「基准」）；缺省按数据行序号。 */
  rankText?: string;
  /** 展开行内容（失败原因等）；非 null 时在本行后插一条跨列详情行。 */
  detail?: HTMLElement | null;
  /** 行点击（键盘走各域自己的按钮，这里只补鼠标增强）。 */
  onActivate?: () => void;
}

export interface TableSpec {
  /** 表格说明（视觉隐藏，读屏用）。 */
  caption: string;
  columns: readonly TableColumn[];
  /** 固定在最上方、不参与排序的行。 */
  pinned?: readonly TableRow[];
  rows: readonly TableRow[];
  sort: SortState | null;
  onSort: (key: string) => void;
  emptyText?: string;
  /** 数据行超过该值时启用 content-visibility（默认 80）。 */
  virtualizeAfter?: number;
}

export interface TableHandle {
  update(spec: TableSpec): void;
  destroy(): void;
}

const RANK_WIDTH = 44;
const DEFAULT_VIRTUALIZE_AFTER = 80;

interface HeadRef {
  th: HTMLTableCellElement;
  button: HTMLButtonElement;
  iconHost: HTMLElement;
}

/** 排序按钮的下一步动作说明（同时用于 aria-label 与 tooltip）。 */
function nextSortLabel(column: TableColumn, sort: SortState | null): string {
  const preferred = column.preferredDir ?? -1;
  const prefText = preferred === 1 ? '升序' : '降序';
  if (sort?.key !== column.key) return `按${column.label}${prefText}排序`;
  return sort.dir === preferred ? `按${column.label}反向排序` : `取消按${column.label}排序`;
}

function columnSignature(columns: readonly TableColumn[]): string {
  return columns
    .map((column) =>
      [
        column.key,
        column.label,
        column.width,
        column.align ?? 'start',
        column.sortable ? 1 : 0,
        column.preferredDir ?? -1,
      ].join('~'),
    )
    .join('|');
}

function buildColgroup(columns: readonly TableColumn[]): HTMLTableColElement[] {
  return [
    el('col', { style: { width: `${RANK_WIDTH}px` } }),
    ...columns.map((column) => el('col', { style: { width: `${column.width}px` } })),
  ];
}

function buildBody(spec: TableSpec): HTMLTableSectionElement {
  const body = el('tbody');
  const columnCount = spec.columns.length + 1;
  const pinned = spec.pinned ?? [];

  if (pinned.length === 0 && spec.rows.length === 0) {
    body.appendChild(
      el(
        'tr',
        { class: 'results-table__empty-row' },
        el('td', {
          class: 'results-table__empty',
          text: spec.emptyText ?? '暂无数据',
          attrs: { colspan: columnCount },
        }),
      ),
    );
    return body;
  }

  const appendRow = (row: TableRow, rank: string): void => {
    const tr = el('tr', {
      class: row.className,
      dataset: { rowKey: row.key },
      attrs: row.selected ? { 'aria-current': 'true' } : undefined,
    });
    if (row.selected) tr.classList.add('is-selected');
    if (row.onActivate) tr.dataset.activate = '1';
    tr.appendChild(
      el('td', {
        class: 'results-table__rank',
        text: rank,
        title: '按当前排序的序号',
      }),
    );
    for (let i = 0; i < spec.columns.length; i += 1) {
      const column = spec.columns[i];
      const cell = row.cells[i] ?? null;
      const classes = [column.align === 'end' ? 'is-end' : null, cell?.className ?? null]
        .filter((item): item is string => item !== null)
        .join(' ');
      const td = el('td', {
        class: classes.length > 0 ? classes : undefined,
        title: cell?.title,
        dataset: { col: column.key },
      });
      if (cell?.node) td.appendChild(cell.node);
      else td.textContent = cell?.text ?? '';
      if (cell?.srText) {
        td.appendChild(el('span', { class: 'results-table__sr', text: cell.srText }));
      }
      tr.appendChild(td);
    }
    if (row.onActivate) {
      const activate = row.onActivate;
      tr.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('button, a, input, select, textarea')) {
          return;
        }
        activate();
      });
    }
    body.appendChild(tr);

    if (row.detail) {
      body.appendChild(
        el(
          'tr',
          { class: 'results-table__detail', dataset: { detailKey: row.key } },
          el('td', { attrs: { colspan: columnCount } }, row.detail),
        ),
      );
    }
  };

  for (const row of pinned) appendRow(row, row.rankText ?? '基准');
  spec.rows.forEach((row, index) => appendRow(row, row.rankText ?? String(index + 1)));
  return body;
}

export function mountTable(host: HTMLElement, initial: TableSpec): TableHandle {
  host.classList.add('results-table-host');
  const scroll = el('div', { class: 'results-table-scroll' });
  const table = el('table', { class: 'results-table' });
  const caption = el('caption', { class: 'results-table__caption' });
  let thead = el('thead');
  let body = el('tbody');
  let cols: HTMLTableColElement[] = [];
  let signature = '';
  const headRefs = new Map<string, HeadRef>();

  table.append(caption, thead, body);
  scroll.appendChild(table);
  host.appendChild(scroll);

  const applySort = (spec: TableSpec): void => {
    for (const [key, ref] of headRefs) {
      const column = spec.columns.find((item) => item.key === key);
      if (!column) continue;
      const dir = spec.sort?.key === key ? spec.sort.dir : 0;
      ref.th.setAttribute(
        'aria-sort',
        dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none',
      );
      ref.iconHost.replaceChildren(
        ...(dir === 0
          ? []
          : [icon(dir === 1 ? 'chevronUp' : 'chevronDown', 'icon results-table__sort-icon')]),
      );
      const action = nextSortLabel(column, spec.sort);
      ref.button.setAttribute('aria-label', action);
      ref.button.title = column.title ? `${column.title}；${action}` : action;
    }
  };

  const buildHead = (spec: TableSpec): void => {
    const activeSortKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.sortKey ?? null
        : null;
    headRefs.clear();
    const row = el('tr');
    row.appendChild(
      el('th', {
        class: 'results-table__rank',
        text: '#',
        title: '按当前排序的序号',
        attrs: { scope: 'col' },
      }),
    );
    for (const column of spec.columns) {
      const th = el('th', {
        class: column.align === 'end' ? 'is-end' : undefined,
        title: column.title,
        attrs: { scope: 'col' },
        dataset: { col: column.key },
      });
      if (!column.sortable) {
        th.textContent = column.label;
        row.appendChild(th);
        continue;
      }
      const iconHost = el('span', {
        class: 'results-table__sort-icon',
        attrs: { 'aria-hidden': 'true' },
      });
      const button = el(
        'button',
        {
          class: 'results-table__sort',
          dataset: { sortKey: column.key },
          attrs: { type: 'button' },
          on: {
            click: () => {
              spec.onSort(column.key);
            },
          },
        },
        el('span', { class: 'results-table__sort-label', text: column.label }),
        iconHost,
      );
      th.appendChild(button);
      row.appendChild(th);
      headRefs.set(column.key, { th, button, iconHost });
    }
    const nextHead = el('thead');
    nextHead.appendChild(row);
    thead.replaceWith(nextHead);
    thead = nextHead;
    applySort(spec);
    if (activeSortKey !== null) {
      const target = [...headRefs.values()].find(
        (ref) => ref.button.dataset.sortKey === activeSortKey,
      );
      target?.button.focus({ preventScroll: true });
    }
  };

  const update = (spec: TableSpec): void => {
    caption.textContent = spec.caption;
    const scrollTop = scroll.scrollTop;
    const nextSignature = columnSignature(spec.columns);
    if (nextSignature !== signature) {
      signature = nextSignature;
      for (const col of cols) col.remove();
      cols = buildColgroup(spec.columns);
      caption.after(...cols);
      buildHead(spec);
    } else {
      applySort(spec);
    }
    const nextBody = buildBody(spec);
    body.replaceWith(nextBody);
    body = nextBody;
    const totalWidth = RANK_WIDTH + spec.columns.reduce((sum, column) => sum + column.width, 0);
    table.style.minWidth = `${totalWidth}px`;
    table.classList.toggle(
      'is-large',
      spec.rows.length > (spec.virtualizeAfter ?? DEFAULT_VIRTUALIZE_AFTER),
    );
    scroll.scrollTop = scrollTop;
  };

  const destroy = (): void => {
    headRefs.clear();
    host.replaceChildren();
  };

  update(initial);
  return { update, destroy };
}
