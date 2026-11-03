// 检视器分区「原图」：一张基准图的选择 / 更换 / 拖入，以及本轮的跑分入口。
//
// 这里的动作只走 core/actions（对话框 + 最近目录 + 状态栏都在那边），本分区只决定
// 结构与拖放落区。原图缺失时给下一步动作而不是灰按钮。
// 「原图」与「跑分」是一个整体（换了基准图，下一步就是跑分），不再拆成两个分区。

import { button } from '../../../ui/primitives';
import { el } from '../../../ui/dom';
import { formatSize } from '../../../core/format';
import { formatLabelOrEmpty } from '../../../core/format-label';
import { fileName, truncateFileName } from '../../../core/util';
import { isBusy } from '../../../core/store';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import { dropOnReference, pickReference } from '../actions';
import { dropTarget, liveRoundOf, mountSection, paintBody } from './common';
import { mountScoreContent } from './score';

export const referenceSection: PanelSection = {
  id: 'reference',
  title: '原图',
  order: 10,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const { body } = mountSection(host, { id: 'reference', title: '原图' });
    // 原图卡片与跑分块同属一个分区：各自挂在稳定容器上分别重画，互不覆盖。
    const sourceHost = el('div', { class: 'reference__source' });
    const scoreHost = el('div', { class: 'reference__score' });
    body.append(sourceHost, scoreHost);
    const unregisterDrop = dropTarget(body, {
      id: 'encoding-reference',
      accept: 'image',
      hint: '松开：设为原图',
      onDrop: (paths) => void dropOnReference(ctx, paths),
      disabled: () => isBusy(),
    });

    const renderSource = (): void => {
      // 同轮内换图只走 update()：ctx 是挂载快照，必须重取活数据（见 common.ts）
      const round = liveRoundOf(ctx);
      const path = round.referencePath;
      const size = round.referenceSize;
      const formatLabel = path === null ? '' : formatLabelOrEmpty(path);
      paintBody(sourceHost, `reference:${path ?? ''}:${size ?? 0}`, () =>
        path === null
          ? el('div', { class: 'enc-empty' }, [
              el('span', { class: 'enc-empty__text', text: '还没有原图' }),
              button({
                label: '选择原图',
                variant: 'secondary',
                size: 'sm',
                onClick: () => void pickReference(ctx),
              }),
              el('span', { class: 'enc-empty__hint', text: '或把图片拖到这里' }),
            ])
          : el(
              'div',
              { class: 'source' },
              // 第一行：文件名（单行省略，title 给全路径）
              el('div', { class: 'source__head' }, [
                el('span', {
                  class: 'source__name',
                  text: truncateFileName(fileName(path)),
                  title: path,
                }),
              ]),
              // 第二行：大小与格式；右侧是唯一的动作（更换）
              el('div', { class: 'source__metas' }, [
                el('span', { class: 'source__meta-item', text: size === null ? '大小未知' : formatSize(size) }),
                formatLabel
                  ? el('span', { class: 'source__meta-item', text: formatLabel })
                  : null,
                el('span', { class: 'source__spacer' }),
                button({
                  label: '更换原图',
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => void pickReference(ctx),
                }),
              ]),
            ),
      );
    };

    const score = mountScoreContent(scoreHost, ctx);
    renderSource();
    return {
      update: () => {
        renderSource();
        score.update();
      },
      destroy: () => {
        unregisterDrop();
        score.destroy();
      },
    };
  },
};
