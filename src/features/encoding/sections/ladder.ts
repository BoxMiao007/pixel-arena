// 检视器分区「编码阶梯」：三种互斥方式 + 一张阶梯矩阵 + 一个主按钮。
//
// 设计口径（决策 0042）：
// - 方式只有三种：单点（每个有损格式压基准这一档）、阶梯（围绕基准取 3 档）、
//   目标大小（逐格式探测逼近目标，命中点与邻近档一起生成）；不再有独立的单点开关。
// - 矩阵的 7 行（4 有损 + 3 无损）常驻显示，行首胶囊是唯一勾选控件；格子只读。
//   未勾选的行灰显而不是消失，随时能勾回来。
// - 预览与生成共用 buildLadderPreview 的 plan：界面上的项数就是实际生成项数。
// - 目标大小先「探测」再「生成」，探测结果显示实测字节与命中点；不再隐式探测。
// - 生成后只跑本次新产物，整轮重算留在「跑分」分区。

import { button, chip, emptyState, progressBar, segmented, sliderField, switchField } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { formatSize } from '../../../core/format';
import { errorText, copyText } from '../../../core/util';
import { isBusy } from '../../../core/store';
import type { BusyEntry } from '../../../core/store';
import type { Round } from '../../../core/model';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import {
  SIZE_SLIDER_STEPS,
  bytesFromSlider,
  sliderFromBytes,
  type LadderCell,
  type LadderMode,
  type LadderPreview,
} from '../logic/ladder';
import { busyProgressView } from '../logic/progress';
import {
  busyIdOf,
  ensureLadderCatalog,
  generateLadder,
  loadLadder,
  openSettingsPage,
  probeSize,
  recheckLadder,
  status,
} from '../actions';
import {
  ensureDefaultSelection,
  ladderStateFor,
  previewOf,
  setBaseline,
  setLadderMode,
  setRegenerateExisting,
  setTargetBytes,
  syncQualityKey,
  syncReference,
  syncSizeKey,
  toggleSelectionFormat,
} from '../session';
import { busyOf, liveRoundOf, mountSection, paintBody } from './common';

const UNIT_BYTES = { KB: 1024, MB: 1024 * 1024 } as const;

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

    const repaint = (): void => {
      if (!disposed) render();
    };

    /** 同步原图标识与两条缓存轴（渲染与入口动作共用同一套失效规则）。 */
    const syncAll = (): void => {
      const round = liveRoundOf(ctx);
      syncReference(state, round);
      syncQualityKey(state);
      syncSizeKey(state);
    };

    /** 目录就绪后补默认勾选、按需取点；失败留在分区里给重试。 */
    const ensure = async (): Promise<void> => {
      try {
        await ensureLadderCatalog();
      } catch (err) {
        state.ladderError = `加载编码器目录失败：${errorText(err)}`;
        repaint();
        return;
      }
      ensureDefaultSelection(state);
      syncAll();
      if (
        state.mode !== 'size' &&
        state.ladder === null &&
        !state.ladderLoading &&
        state.ladderError === null
      ) {
        await loadLadder(state);
      }
      repaint();
    };

    /** 目标大小的精确输入值：真值永远是字节，单位只影响显示。 */
    const targetInUnit = (): string => {
      const value = state.targetBytes / UNIT_BYTES[state.unit];
      if (Number.isInteger(value)) return String(value);
      return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    };

    /** 单点 / 阶梯的主参数：基准质量。拖动只改读数，松手才取点。 */
    const qualityParam = (): HTMLElement => {
      const slider = sliderField({
        label: '基准质量',
        min: 0,
        max: 100,
        step: 1,
        value: state.baseline,
        onInput: (value) => setBaseline(state, value),
      });
      slider.input.addEventListener('change', () => {
        syncQualityKey(state);
        void ensure();
        repaint();
      });
      return el('div', { class: 'ladder__primary' }, [
        slider.node,
        el('p', {
          class: 'ladder__hint',
          text: '各格式按自身质量范围映射（JPEG XL 上限 95）',
        }),
      ]);
    };

    /** 目标大小的主参数：对数滑杆粗调 + 精确输入 + KB/MB。 */
    const sizeParam = (): HTMLElement => {
      const input = el('input', {
        class: 'input ladder__size',
        attrs: {
          type: 'number',
          min: '0',
          step: 'any',
          'aria-label': '目标大小（精确值）',
        },
      }) as HTMLInputElement;
      const unit = el('select', {
        class: 'select ladder__unit',
        attrs: { 'aria-label': '目标大小单位' },
      }) as HTMLSelectElement;
      for (const name of ['KB', 'MB'] as const) {
        unit.append(el('option', { text: name, attrs: { value: name } }));
      }
      unit.value = state.unit;
      const error = el('span', { class: 'field__error' });
      error.hidden = true;

      const slider = sliderField({
        label: '目标大小',
        min: 0,
        max: SIZE_SLIDER_STEPS,
        step: 1,
        value: sliderFromBytes(state.targetBytes),
        format: (position) => `≈ ${formatSize(bytesFromSlider(position))}`,
        onInput: (position) => {
          setTargetBytes(state, bytesFromSlider(position));
          input.value = targetInUnit();
        },
      });
      input.value = targetInUnit();

      input.addEventListener('change', () => {
        const raw = Number(input.value);
        const bytes = Math.round(raw * UNIT_BYTES[state.unit]);
        if (!Number.isFinite(bytes) || bytes < 1) {
          error.textContent = '请输入大于 0 的数值';
          error.hidden = false;
          input.value = targetInUnit();
          return;
        }
        error.hidden = true;
        setTargetBytes(state, bytes);
        slider.setValue(sliderFromBytes(state.targetBytes));
        input.value = targetInUnit();
        repaint();
      });
      unit.addEventListener('change', () => {
        state.unit = unit.value === 'MB' ? 'MB' : 'KB';
        input.value = targetInUnit();
        slider.setValue(sliderFromBytes(state.targetBytes));
        repaint();
      });
      slider.input.addEventListener('change', () => {
        // 松手：目标已在 onInput 落状态并清探测结果，这里只重画清单
        repaint();
      });

      return el('div', { class: 'ladder__primary' }, [
        slider.node,
        el('div', { class: 'ladder__size-field' }, [
          el('div', { class: 'ladder__size-row' }, [
            el('span', { class: 'field__label', text: '精确值' }),
            input,
            unit,
          ]),
          error,
        ]),
      ]);
    };

    const cellNode = (cell: LadderCell): HTMLElement => {
      const existingClass =
        cell.existing === 'scored'
          ? ' ladder__cell--existing'
          : cell.existing === 'unscored'
            ? ' ladder__cell--rescore'
            : '';
      const existingNote =
        cell.existing === 'scored'
          ? '；本轮已有，将跳过'
          : cell.existing === 'unscored'
            ? '；本轮已有，将补跑分'
            : '';
      return el(
        'span',
        {
          class: `ladder__cell${cell.hit ? ' ladder__cell--hit' : ''}${
            cell.bytes === null ? '' : ' ladder__cell--sized'
          }${existingClass}`,
          title: `${cell.title}${existingNote}`,
        },
        el('span', { class: 'ladder__cell-q', text: cell.text }),
        cell.bytes === null
          ? null
          : el('span', { class: 'ladder__cell-bytes', text: formatSize(cell.bytes) }),
      );
    };

    /** 阶梯矩阵：7 行常驻，行首胶囊是唯一勾选控件。 */
    const buildMatrix = (preview: LadderPreview, busy: boolean): HTMLElement => {
      if (preview.rows.length === 0) {
        return emptyState({
          title: '编码器目录还没就绪',
          hint: state.ladderError ?? '正在加载编码器目录…',
          actions: [
            button({
              label: '重试',
              variant: 'secondary',
              size: 'sm',
              disabled: busy,
              onClick: () => {
                state.ladderError = null;
                void ensure();
              },
            }),
          ],
          className: 'ladder__empty',
        });
      }

      const matrix = el('div', {
        class: 'ladder__matrix',
        attrs: { role: 'group', 'aria-label': '编码格式与档位' },
      });
      let losslessTitle = false;
      for (const row of preview.rows) {
        if (row.lossless && !losslessTitle) {
          losslessTitle = true;
          matrix.append(
            el('p', { class: 'ladder__group-title', text: '无损对照（默认不选）' }),
          );
        }
        const cells = el('div', { class: 'ladder__cells' });
        if (row.error !== null) {
          cells.append(el('span', { class: 'ladder__cell ladder__cell--error', text: '探测失败' }));
        } else if (row.pending) {
          cells.append(el('span', { class: 'ladder__cell ladder__cell--muted', text: '待探测' }));
        } else if (row.cells.length === 0) {
          const text = !row.selected
            ? '—'
            : state.ladderLoading
              ? '取点中…'
              : state.ladderError !== null
                ? '取点失败'
                : '—';
          cells.append(el('span', { class: 'ladder__cell ladder__cell--muted', text }));
        } else {
          for (const cell of row.cells) cells.append(cellNode(cell));
        }

        matrix.append(
          el(
            'div',
            {
              class: `ladder__row${row.selected ? '' : ' is-off'}${
                row.lossless ? ' is-lossless' : ''
              }`,
            },
            chip({
              label: row.label,
              active: row.selected,
              disabled: busy,
              title: row.selected ? `取消 ${row.label}` : `选择 ${row.label}`,
              onClick: () => {
                toggleSelectionFormat(state, row.lossless ? 'lossless' : 'lossy', row.format);
                repaint();
              },
            }),
            cells,
          ),
        );
        if (row.note !== null) {
          matrix.append(el('p', { class: 'ladder__row-note', text: row.note }));
        }
        if (row.error !== null) {
          matrix.append(
            el('p', { class: 'ladder__row-note ladder__row-note--error', text: row.error }),
          );
        }
      }
      return matrix;
    };

    /** 按钮上方的一行事实：下一步是什么、将生成几项。 */
    const hintOf = (round: Round, preview: LadderPreview): string => {
      if (round.referencePath === null) return '先选择原图';
      if (state.ladderError !== null) return state.ladderError;
      if (preview.rows.length === 0) return '正在加载编码器目录…';
      if (state.mode !== 'size' && state.ladder === null) return '正在取点…';
      if (state.mode === 'size') {
        if (preview.failedFormats.length > 0) {
          return `${preview.failedFormats.length} 个格式探测失败：可重试或取消勾选`;
        }
        if (preview.pendingFormats.length > 0) {
          return `先探测 ${preview.pendingFormats.length} 个格式的目标大小（探测会真实编码若干次）`;
        }
      }
      if (preview.count === 0) return '先勾选至少一个格式';
      if (state.regenerateExisting) return `将重新生成 ${preview.count} 项`;
      if (preview.newCount === 0 && preview.rescoreCount > 0) {
        return `${preview.existingCount} 项本轮已有；其中 ${preview.rescoreCount} 项将补跑分`;
      }
      if (preview.newCount === 0 && preview.existingCount > 0) {
        return `${preview.existingCount} 项本轮已有，无需再生成`;
      }
      const parts = [`将生成 ${preview.newCount} 项`];
      if (preview.skipCount > 0) parts.push(`${preview.skipCount} 项已有跳过`);
      if (preview.rescoreCount > 0) parts.push(`${preview.rescoreCount} 项补跑分`);
      return parts.join('；');
    };

    const actionsView = (round: Round, preview: LadderPreview, busy: boolean): HTMLElement => {
      const selectedLossy = state.selection.lossyFormats.length;
      const needProbe =
        state.mode === 'size' &&
        (preview.pendingFormats.length > 0 || preview.failedFormats.length > 0);
      const hasWork = preview.newCount > 0 || preview.rescoreCount > 0;
      const probeDisabled = busy || round.referencePath === null || selectedLossy === 0;
      const generateDisabled =
        busy ||
        round.referencePath === null ||
        !hasWork ||
        preview.pendingFormats.length > 0 ||
        preview.failedFormats.length > 0 ||
        state.ladderError !== null;

      const probeHint =
        round.referencePath === null
          ? '先选择原图'
          : selectedLossy === 0
            ? '先勾选至少一个有损格式'
            : '对勾选格式逐个逼近目标大小（探测会真实编码若干次）';
      const generateHint =
        round.referencePath === null
          ? '先选择原图'
          : preview.pendingFormats.length > 0
            ? '先探测目标大小'
            : preview.failedFormats.length > 0
              ? '先重试探测或取消失败格式'
              : !hasWork
                ? '本轮已有全部档位且都已跑分；要重新压一遍请打开「重新生成已有档位」'
                : preview.newCount === 0
                  ? `补跑分 ${preview.rescoreCount} 项（复用已有产物）`
                  : preview.rescoreCount > 0
                    ? `生成 ${preview.newCount} 项并跑分，另有 ${preview.rescoreCount} 项补跑分`
                    : `生成 ${preview.newCount} 项并跑分`;
      const generateLabel =
        preview.newCount === 0 && preview.rescoreCount > 0
          ? `补跑分 ${preview.rescoreCount} 项`
          : '生成并跑分';

      const primary = needProbe
        ? button({
            label: preview.failedFormats.length > 0 ? '重试探测' : '探测目标大小',
            variant: 'primary',
            disabled: probeDisabled,
            title: probeHint,
            onClick: () => void probeSize(ctx, state).then(repaint),
          })
        : button({
            label: generateLabel,
            variant: 'primary',
            disabled: generateDisabled,
            title: generateHint,
            onClick: () => void generateLadder(ctx, state).then(repaint),
          });

      const secondary =
        state.mode === 'size' && !needProbe && Object.keys(state.sizeOutcomes).length > 0
          ? button({
              label: '重新探测',
              variant: 'secondary',
              disabled: busy,
              title: '清空当前探测结果，按目标大小重新逼近',
              onClick: () => void probeSize(ctx, state, { force: true }).then(repaint),
            })
          : state.mode !== 'size' && state.ladderError !== null
            ? button({
                label: '重试取点',
                variant: 'secondary',
                disabled: busy,
                onClick: () => {
                  state.ladderError = null;
                  void ensure();
                },
              })
            : null;

      return el('div', { class: 'ladder__actions' }, [primary, secondary]);
    };

    const issueCard = (busy: boolean): HTMLElement | null => {
      if (state.encoderIssue === null) return null;
      const urls = extractUrls(state.encoderIssue);
      return el('div', { class: 'ladder__issue' }, [
        el('p', { class: 'ladder__issue-text', text: state.encoderIssue.split('\n')[0] }),
        el('div', { class: 'ladder__issue-actions' }, [
          button({
            label: '打开设置',
            variant: 'secondary',
            size: 'sm',
            onClick: () => void openSettingsPage(),
          }),
          button({
            label: '复制发布页链接',
            variant: 'quiet',
            size: 'sm',
            disabled: urls.length === 0,
            onClick: () => copyText(urls.join('\n'), () => status('已复制发布页链接')),
          }),
          button({
            label: '重新检测',
            variant: 'quiet',
            size: 'sm',
            disabled: busy,
            onClick: () => void recheckLadder(ctx, state).then(repaint),
          }),
        ]),
      ]);
    };

    const failuresView = (): HTMLElement | null => {
      if (state.failures.length === 0) return null;
      return el(
        'details',
        { class: 'ladder__failures' },
        el('summary', {
          class: 'ladder__summary',
          text: `${state.failures.length} 项生成失败（展开）`,
        }),
        el(
          'ul',
          { class: 'ladder__failure-list' },
          ...state.failures.map((line) => el('li', { class: 'ladder__failure', text: line })),
        ),
      );
    };

    const progressView = (entry: BusyEntry | undefined): HTMLElement | null => {
      if (!entry) return null;
      const progress = progressBar({ label: '生成进度' });
      const view = busyProgressView(entry);
      if (view.kind === 'determinate') progress.set(view.completed, view.total, view.label);
      else progress.setIndeterminate(view.label);
      return el('div', { class: 'ladder__progress' }, [
        progress.node,
        el('p', { class: 'ladder__hint', text: '生成与跑分进行中，完成前无法中止' }),
      ]);
    };

    const signatureOf = (
      busy: boolean,
      round: Round,
      preview: LadderPreview,
      ladderBusy: BusyEntry | undefined,
    ): string => {
      const busySig = ladderBusy
        ? `${ladderBusy.detail}|${ladderBusy.completed ?? ''}|${ladderBusy.total ?? ''}`
        : '';
      const sizeSig = Object.entries(state.sizeOutcomes)
        .map(
          ([format, outcome]) =>
            `${format}:${outcome.points
              .map((point) => `${point.quality}-${point.bytes}`)
              .join('_')}:${outcome.hitQuality}:${outcome.note ?? ''}`,
        )
        .join(',');
      const sizeErrSig = Object.entries(state.sizeErrors)
        .map(([format, error]) => `${format}:${error}`)
        .join(',');
      return [
        'ladder',
        ctx.round.id,
        state.mode,
        state.baseline,
        state.targetBytes,
        state.unit,
        state.selection.lossyFormats.join(','),
        state.selection.losslessFormats.join(','),
        state.ladder === null ? 'noladder' : 'ladder',
        state.ladderLoading ? 'loading' : '',
        state.ladderError ?? '',
        state.sizeKey,
        sizeSig,
        sizeErrSig,
        preview.count,
        preview.newCount,
        preview.skipCount,
        preview.rescoreCount,
        preview.pendingFormats.join(','),
        preview.failedFormats.join(','),
        preview.existingCount,
        state.regenerateExisting ? 'regen' : '',
        busySig,
        state.failures.join('|'),
        state.encoderIssue ?? '',
        busy ? 'busy' : 'idle',
        round.referencePath ?? '',
        round.candidates.length,
      ].join('|');
    };

    const render = (): void => {
      const busy = isBusy();
      const round = liveRoundOf(ctx);
      syncAll();
      const preview = previewOf(state, round.candidates);
      const ladderBusy = busyOf(busyIdOf('ladder', ctx.round.id));
      paintBody(body, signatureOf(busy, round, preview, ladderBusy), () => {
        const modeControl = segmented({
          items: [
            { id: 'single', label: '单点', title: '每个格式只压基准这一档' },
            { id: 'ladder', label: '阶梯', title: '每个格式在基准上下各取一档（共 3 档）' },
            {
              id: 'size',
              label: '目标大小',
              title: '每个格式自动逼近目标大小，命中点与邻近档一起生成',
            },
          ],
          value: state.mode,
          ariaLabel: '编码方式',
          size: 'sm',
          onChange: (id) => {
            setLadderMode(state, id as LadderMode);
            syncQualityKey(state);
            void ensure();
            repaint();
          },
        });

        const matrix = buildMatrix(preview, busy);
        const regenerateSwitch = switchField({
          label: '重新生成已有档位',
          checked: state.regenerateExisting,
          hint: '默认跳过本轮已跑分的同档位',
          onChange: (checked) => {
            setRegenerateExisting(state, checked);
            repaint();
          },
        });

        return el('div', { class: 'ladder' }, [
          el(
            'fieldset',
            { class: 'ladder__fieldset', attrs: { disabled: busy ? true : null } },
            el('div', { class: 'ladder__controls' }, [
              modeControl.node,
              state.mode === 'size' ? sizeParam() : qualityParam(),
            ]),
            matrix,
            regenerateSwitch.node,
          ),
          el('p', { class: 'ladder__hint', text: hintOf(round, preview) }),
          actionsView(round, preview, busy),
          progressView(ladderBusy),
          issueCard(busy),
          failuresView(),
          round.referencePath !== null && preview.count > 0
            ? el('p', {
                class: 'ladder__note',
                text:
                  preview.existingCount > 0 && !state.regenerateExisting
                    ? '产物写进原图旁的 Pixel Arena 文件夹并纳入本轮；只跑本次新生成的产物。已存在的档位默认跳过，要重新生成请打开「重新生成已有档位」。'
                    : '产物写进原图旁的 Pixel Arena 文件夹并纳入本轮；只跑本次新生成的产物',
              })
            : null,
        ]);
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
      },
    };
  },
};
