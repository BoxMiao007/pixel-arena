// 检视器分区「编码阶梯」：一站式两种模式 + 单点模式 + 阶梯预览 + 真实进度。
//
// 与旧控件的差别（Phase B）：
// - 模式用 segmented、质量用 sliderField、目标大小用数字输入 + KB/MB；
// - 格式与无损组仍是多选胶囊，但「单点模式」与「无损组」降到次级行；
// - **提交前能看见清单**：真取点后按「格式一行、质量点一排」渲染，可逐点取消；
// - 一键只生成 + 跑分，进度用真实 N/M（不伪造），失败项就地展开。

import { button, chip, progressBar, segmented, sliderField } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { copyText } from '../../../core/util';
import { isBusy } from '../../../core/store';
import { runCommand } from '../../../shell/registry';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import {
  LOSSLESS_FORMATS,
  LOSSY_FORMATS,
  groupLadderByFormat,
  ladderItemKey,
} from '../logic/ladder';
import { busyProgressView } from '../logic/progress';
import {
  busyIdOf,
  ensureLadderCatalog,
  generateLadder,
  loadLadder,
  plannedCount,
  runSizeSearch,
  sizeLadderPreview,
  status,
} from '../actions';
import {
  formatLadderOf,
  ladderStateFor,
  syncLadderKey,
  toggleLadderItem,
  toggleSelectionFormat,
} from '../session';
import { busyOf, debounce, mountSection, paintBody } from './common';

const UNIT_BYTES = { KB: 1024, MB: 1024 * 1024 } as const;

/** 目标大小的显示值（单位随 state.unit 切换，真值永远是字节）。 */
function formatTargetIn(state: { targetBytes: number; unit: 'KB' | 'MB' }): string {
  const value = state.targetBytes / UNIT_BYTES[state.unit];
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 从文案里抽出 http(s) 链接（预检结论里带官方发布页）。 */
function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s，；）)]+/g) ?? [])];
}

export const ladderSection: PanelSection = {
  id: 'ladder',
  title: '编码阶梯',
  order: 40,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const state = ladderStateFor(ctx.round.id);
    const { body } = mountSection(host, { id: 'ladder', title: '编码阶梯', defaultOpen: false });
    let disposed = false;

    const sizeMode = (): boolean => state.mode === 'size' && !state.singlePoint;

    const repaint = (): void => {
      if (!disposed) render();
    };

    // 取点：滑杆停手 200ms 后再打 IPC（拖动期间只更新数值显示）
    const fetchLadder = debounce(() => {
      void loadLadder(state).then(repaint);
    }, 200);

    const ensure = async (): Promise<void> => {
      try {
        await ensureLadderCatalog();
      } catch (err) {
        status(`加载编码器目录失败：${String(err)}`, true);
        return;
      }
      const keyChanged = syncLadderKey(state);
      if (keyChanged || (state.ladder === null && !sizeMode())) await loadLadder(state);
      repaint();
    };

    /** 打开设置页（命令由设置域注册；没有就只提示，不假装能跳）。 */
    const openSettings = async (): Promise<void> => {
      if (!(await runCommand('open-settings'))) {
        status('设置入口还没就绪：请从顶栏「设置」打开编码器区指定外部路径', true);
      }
    };

    const sizeRow = (): HTMLElement => {
      const input = el('input', {
        class: 'input ladder__size',
        attrs: { type: 'number', min: '0', step: 'any', 'aria-label': '目标大小' },
      }) as HTMLInputElement;
      input.value = formatTargetIn(state);
      input.addEventListener('change', () => {
        const bytes = Math.round(Number(input.value) * UNIT_BYTES[state.unit]);
        if (Number.isFinite(bytes) && bytes >= 1) {
          state.targetBytes = bytes;
          syncLadderKey(state);
          repaint();
          return;
        }
        // 非法输入不落状态：回显真值并在状态栏说明（输入框旁另有 field__hint）
        input.value = formatTargetIn(state);
        status('目标大小无效：请输入大于 0 的数值', true);
      });
      const unit = el('select', {
        class: 'select ladder__unit',
        attrs: { 'aria-label': '大小单位' },
      }) as HTMLSelectElement;
      for (const name of ['KB', 'MB'] as const) {
        unit.append(el('option', { text: name, attrs: { value: name } }));
      }
      unit.value = state.unit;
      unit.addEventListener('change', () => {
        state.unit = unit.value === 'MB' ? 'MB' : 'KB';
        repaint();
      });
      return el(
        'div',
        { class: 'ladder__size-row' },
        el('span', { class: 'field__label', text: '目标大小' }),
        input,
        unit,
      );
    };

    const render = (): void => {
      const busy = isBusy();
      const ladderBusy = busyOf(busyIdOf('ladder', ctx.round.id));
      const key = [
        'ladder',
        ctx.round.id,
        state.mode,
        state.singlePoint ? 'single' : 'multi',
        state.baseline,
        state.targetBytes,
        state.unit,
        state.selection.lossyFormats.join(','),
        state.selection.losslessFormats.join(','),
        state.excluded.size,
        state.ladder === null ? 'noladder' : 'ladder',
        Object.keys(state.sizeOutcomes).length,
        ladderBusy?.detail ?? '',
        ladderBusy?.completed ?? '',
        ladderBusy?.total ?? '',
        state.failures.length,
        state.encoderIssue === null ? '' : 'issue',
        busy ? 'busy' : 'idle',
        ctx.round.referencePath === null ? 'noref' : 'ref',
      ].join(':');

      paintBody(body, key, () => {
        const modeControl = segmented({
          items: [
            { id: 'quality', label: '质量优先', title: '统一基准质量，自动在基准附近取多个点' },
            { id: 'size', label: '大小优先', title: '输入期望文件大小，每个格式自动逼近' },
          ],
          value: state.mode,
          ariaLabel: '自动编码模式',
          size: 'sm',
          onChange: (id) => {
            if (state.singlePoint) return;
            state.mode = id === 'size' ? 'size' : 'quality';
            syncLadderKey(state);
            void ensure();
          },
        });

        const primaryParam = state.singlePoint
          ? el('div', { class: 'ladder__locked' }, [
              el('span', { class: 'ladder__locked-text', text: '单点模式' }),
              el('span', {
                class: 'ladder__locked-hint',
                text: '每个有损格式只压一个质量点；关掉可回到多档取点',
              }),
            ])
          : state.mode === 'quality'
            ? sliderField({
                label: '基准质量',
                min: 0,
                max: 100,
                step: 1,
                value: state.baseline,
                onInput: (value) => {
                  state.baseline = value;
                  syncLadderKey(state);
                  fetchLadder.run();
                },
              }).node
            : sizeRow();

        const formatChips = el(
          'div',
          { class: 'ladder__chips', attrs: { role: 'group', 'aria-label': '编码格式' } },
          ...LOSSY_FORMATS.map((format) =>
            chip({
              label: format.label,
              active: state.selection.lossyFormats.includes(format.format),
              disabled: busy,
              title: state.selection.lossyFormats.includes(format.format)
                ? `取消 ${format.label}`
                : `选择 ${format.label}`,
              onClick: () => {
                toggleSelectionFormat(state, 'lossy', format.format);
                repaint();
              },
            }),
          ),
        );

        const singleToggle = el(
          'button',
          {
            class: `ladder__toggle${state.singlePoint ? ' is-on' : ''}`,
            attrs: {
              type: 'button',
              role: 'switch',
              'aria-checked': String(state.singlePoint),
              'aria-label': '单点模式',
            },
            on: {
              click: () => {
                state.singlePoint = !state.singlePoint;
                if (state.singlePoint) state.mode = 'quality';
                syncLadderKey(state);
                repaint();
                fetchLadder.run();
              },
            },
          },
          el(
            'span',
            { class: 'ladder__toggle-track' },
            el('span', { class: 'ladder__toggle-thumb' }),
          ),
          el('span', { text: '单点模式' }),
        );

        const losslessChips = el(
          'div',
          { class: 'ladder__chips', attrs: { role: 'group', 'aria-label': '无损对照组' } },
          ...LOSSLESS_FORMATS.map((format) =>
            chip({
              label: format.label,
              active: state.selection.losslessFormats.includes(format.format),
              disabled: busy,
              title: '无损对照组：像素与原图逐位一致，作为参照',
              onClick: () => {
                toggleSelectionFormat(state, 'lossless', format.format);
                repaint();
              },
            }),
          ),
        );

        // 预览网格：真取点后按格式分行，逐点可取消
        const previewLadder =
          sizeMode() ? sizeLadderPreview(state) : formatLadderOf(state);
        const rows = groupLadderByFormat(previewLadder);
        const grid = el('div', { class: 'ladder__grid' });
        for (const row of rows) {
          const points = el('div', { class: 'ladder__points' });
          for (const item of row.items) {
            const on = !state.excluded.has(ladderItemKey(item));
            points.append(
              chip({
                label: row.lossless ? '对照' : `q${item.quality}`,
                active: on,
                disabled: busy,
                title: row.lossless
                  ? `${row.label}：无损对照组`
                  : `${row.label} q${item.quality}${on ? '（点击取消这一档）' : '（点击加回这一档）'}`,
                onClick: () => {
                  toggleLadderItem(state, item);
                  repaint();
                },
              }),
            );
          }
          grid.append(
            el('div', { class: 'ladder__row' }, [
              el('span', {
                class: 'ladder__row-label',
                text: row.lossless ? `${row.label}（无损）` : row.label,
              }),
              points,
            ]),
          );
        }

        const planned = plannedCount(state);
        const progress = progressBar({ label: '生成进度' });
        if (ladderBusy) {
          const view = busyProgressView(ladderBusy);
          if (view.kind === 'determinate') progress.set(view.completed, view.total, view.label);
          else progress.setIndeterminate(view.label);
        }

        const selectedAny =
          state.selection.lossyFormats.length > 0 || state.selection.losslessFormats.length > 0;
        const countText = sizeMode()
          ? !selectedAny
            ? '还没有选择格式'
            : Object.keys(state.sizeOutcomes).length === 0
              ? '先点「搜索目标大小」探一遍（探测编码需要几十秒）'
              : `将生成 ${planned} 项（含无损对照组）`
          : state.ladder === null
            ? '正在取点…'
            : `将生成 ${planned} 项`;

        const runDisabled = busy || ctx.round.referencePath === null || planned === 0;

        return el(
          'div',
          { class: 'ladder' },
          el('div', { class: 'ladder__controls' }, [modeControl.node, primaryParam]),
          formatChips,
          el('div', { class: 'ladder__secondary' }, [singleToggle, losslessChips]),
          el('div', { class: 'ladder__preview' }, [
            el('div', { class: 'ladder__preview-head' }, [
              el('span', { class: 'ladder__preview-title', text: '本次清单' }),
              el('span', { class: 'ladder__preview-count', text: countText }),
            ]),
            grid,
          ]),
          el('div', { class: 'ladder__actions' }, [
            button({
              label: state.singlePoint ? '按单点自动跑分' : '开始自动跑分',
              variant: 'primary',
              disabled: runDisabled,
              title:
                ctx.round.referencePath === null
                  ? '先选择原图'
                  : planned === 0
                    ? '先选择至少一个格式或无损组'
                    : `生成 ${planned} 份产物并逐张跑分`,
              onClick: () => void generateLadder(ctx, state),
            }),
            sizeMode()
              ? button({
                  label:
                    Object.keys(state.sizeOutcomes).length === 0 ? '搜索目标大小' : '重新搜索',
                  variant: 'secondary',
                  disabled: busy || state.selection.lossyFormats.length === 0,
                  title: '对每个勾选格式逼近目标大小（探测编码在后端完成）',
                  onClick: () => void runSizeSearch(ctx, state).then(repaint),
                })
              : null,
          ]),
          ladderBusy ? el('div', { class: 'ladder__progress' }, progress.node) : null,
          state.encoderIssue
            ? el('div', { class: 'ladder__issue' }, [
                el('p', { class: 'ladder__issue-text', text: state.encoderIssue.split('\n')[0] }),
                el('div', { class: 'ladder__issue-actions' }, [
                  button({
                    label: '打开设置',
                    variant: 'secondary',
                    size: 'sm',
                    onClick: () => void openSettings(),
                  }),
                  button({
                    label: '复制发布页链接',
                    variant: 'quiet',
                    size: 'sm',
                    disabled: extractUrls(state.encoderIssue).length === 0,
                    onClick: () => {
                      copyText(extractUrls(state.encoderIssue ?? '').join('\n'), () =>
                        status('已复制发布页链接'),
                      );
                    },
                  }),
                ]),
              ])
            : null,
          state.failures.length > 0
            ? el(
                'details',
                { class: 'ladder__failures' },
                el('summary', {
                  class: 'ladder__summary',
                  text: `${state.failures.length} 项生成失败（展开）`,
                }),
                el(
                  'ul',
                  { class: 'ladder__failure-list' },
                  ...state.failures.map((line) =>
                    el('li', { class: 'ladder__failure', text: line }),
                  ),
                ),
              )
            : null,
          planned > 0 && ctx.round.referencePath !== null
            ? el('p', {
                class: 'ladder__note',
                text: `${planned} 份产物写进原图旁的 Pixel Arena 文件夹并纳入本轮`,
              })
            : null,
        );
      });
    };

    render();
    void ensure();
    return {
      update: () => {
        void ensure();
        render();
      },
      destroy: () => {
        disposed = true;
        fetchLadder.cancel();
      },
    };
  },
};
