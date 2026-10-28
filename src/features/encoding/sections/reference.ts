// 检视器分区「原图」：一张基准图的选择 / 更换 / 拖入。
//
// 这里的动作只走 core/actions（对话框 + 最近目录 + 状态栏都在那边），本分区只决定
// 结构与拖放落区。原图缺失时给下一步动作而不是灰按钮。

import { button } from '../../../ui/primitives';
import { formatSize } from '../../../core/format';
import { fileName, truncateFileName } from '../../../core/util';
import { isBusy } from '../../../core/store';
import type { MountedView, PanelSection, ViewCtx } from '../../../shell/registry';
import { dropOnReference, pickReference } from '../actions';
import { block, dropTarget, imageFormatLabel, mountSection, paintBody } from './common';

export const referenceSection: PanelSection = {
  id: 'reference',
  title: '原图',
  order: 10,
  kinds: ['image'],
  mount(host: HTMLElement, ctx: ViewCtx): MountedView {
    const { body } = mountSection(host, { id: 'reference', title: '原图' });
    const unregisterDrop = dropTarget(body, {
      id: 'encoding-reference',
      accept: 'image',
      hint: '松开：设为原图',
      onDrop: (paths) => void dropOnReference(ctx, paths),
      disabled: () => isBusy(),
    });

    const render = (): void => {
      const path = ctx.round.referencePath;
      const size = ctx.round.referenceSize;
      paintBody(body, `reference:${path ?? ''}:${size ?? 0}`, () =>
        path === null
          ? block('div', { class: 'enc-empty' }, [
              block('span', { class: 'enc-empty__text', text: '还没有原图' }),
              button({
                label: '选择原图',
                variant: 'secondary',
                size: 'sm',
                onClick: () => void pickReference(ctx),
              }),
              block('span', { class: 'enc-empty__hint', text: '或把图片拖到这里' }),
            ])
          : block(
              'div',
              { class: 'source' },
              // 第一行：文件名（单行省略，title 给全路径）
              block('div', { class: 'source__head' }, [
                block('span', {
                  class: 'source__name',
                  text: truncateFileName(fileName(path)),
                  title: path,
                }),
              ]),
              // 第二行：大小与格式；右侧是唯一的动作（更换）
              block('div', { class: 'source__metas' }, [
                block('span', { class: 'source__meta-item', text: size === null ? '大小未知' : formatSize(size) }),
                imageFormatLabel(path)
                  ? block('span', { class: 'source__meta-item', text: imageFormatLabel(path) })
                  : null,
                block('span', { class: 'source__spacer' }),
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

    render();
    return { update: render, destroy: () => unregisterDrop() };
  },
};
