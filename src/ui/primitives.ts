// 组件原语：按钮、胶囊、分段控制、表单字段、分区、空态、徽标、进度条。
//
// 所有原语都输出带语义的 DOM（button / label / role=switch / role=radiogroup），
// 键盘可达、焦点可见；样式类名由 styles/components.css 定义，本模块不写死颜色。
// 功能域只组合原语，不自己拼按钮与表单。

import { el, type Child } from './dom';
import { icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** 只显示图标（此时 label 用于可访问名，不出现在界面上）。 */
  iconOnly?: boolean;
  onClick?: (event: MouseEvent) => void;
}

/** 标准按钮。 */
export function button(options: ButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? 'secondary';
  const size = options.size ?? 'md';
  const node = el(
    'button',
    {
      class: `btn btn--${variant} btn--${size}`,
      title: options.title,
      attrs: {
        type: 'button',
        'aria-label': options.ariaLabel ?? (options.iconOnly ? options.label : null),
        disabled: options.disabled ?? false,
      },
      on: options.onClick ? { click: options.onClick } : undefined,
    },
    options.icon ? icon(options.icon) : null,
    options.iconOnly ? null : options.label ? el('span', { class: 'btn__label', text: options.label }) : null,
  );
  return node;
}

export type IconButtonVariant = 'quiet' | 'bordered' | 'primary' | 'danger';

export interface IconButtonOptions {
  label: string;
  icon: IconName;
  variant?: IconButtonVariant;
  size?: 'sm' | 'md';
  title?: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

/** 纯图标按钮：label 必填，落到 aria-label 与 tooltip（图标本身 aria-hidden）。 */
export function iconButton(options: IconButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? 'quiet';
  return el(
    'button',
    {
      class: `icon-btn icon-btn--${variant}${options.size === 'sm' ? ' icon-btn--sm' : ''}`,
      title: options.title ?? options.label,
      attrs: {
        type: 'button',
        'aria-label': options.label,
        disabled: options.disabled ?? false,
      },
      on: options.onClick ? { click: options.onClick } : undefined,
    },
    icon(options.icon),
  );
}

export interface ChipOptions {
  label: string;
  active?: boolean;
  title?: string;
  disabled?: boolean;
  /** 点击主体（可选）；无点击时为静态标签。 */
  onClick?: () => void;
  /** 附带「×」移除（可选）。 */
  onRemove?: () => void;
  /** 前置小图标。 */
  icon?: IconName;
}

/** 胶囊：可点选（aria-pressed）/ 可移除，或静态标签。 */
export function chip(options: ChipOptions): HTMLElement {
  const interactive = options.onClick !== undefined;
  const body = el(
    interactive ? 'button' : 'span',
    {
      class: 'chip__body',
      title: options.title,
      attrs: interactive
        ? {
            type: 'button',
            'aria-pressed': options.active === undefined ? null : String(options.active),
            disabled: options.disabled ?? false,
          }
        : undefined,
      on: interactive && options.onClick ? { click: options.onClick } : undefined,
    },
    options.icon ? icon(options.icon, 'icon chip__icon') : null,
    el('span', { class: 'chip__label', text: options.label }),
  );

  return el(
    'span',
    {
      class: `chip${options.active ? ' chip--active' : ''}${interactive ? ' chip--interactive' : ''}${options.disabled ? ' chip--disabled' : ''}`,
    },
    body,
    options.onRemove
      ? el(
          'button',
          {
            class: 'chip__remove',
            attrs: {
              type: 'button',
              'aria-label': `移除 ${options.label}`,
              title: `移除 ${options.label}`,
              disabled: options.disabled ?? false,
            },
            on: { click: options.onRemove },
          },
          icon('close', 'icon icon--12'),
        )
      : null,
  );
}

export interface SegmentedItem {
  id: string;
  label?: string;
  icon?: IconName;
  title?: string;
}

export interface SegmentedHandle {
  node: HTMLDivElement;
  /** 外部状态变化时同步选中态（不重建 DOM，避免丢焦点）。 */
  setValue: (id: string) => void;
}

/** 分段控制（互斥选择）：radiogroup 语义，方向键切换。 */
export function segmented(options: {
  items: readonly SegmentedItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}): SegmentedHandle {
  const buttons: HTMLButtonElement[] = [];
  const node = el('div', {
    class: `segmented segmented--${options.size ?? 'md'}`,
    attrs: { role: 'radiogroup', 'aria-label': options.ariaLabel },
  });

  const apply = (value: string): void => {
    for (const button of buttons) {
      const active = button.dataset.id === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
      button.tabIndex = active ? 0 : -1;
    }
  };

  options.items.forEach((item, index) => {
    const button = el(
      'button',
      {
        class: 'segmented__item',
        title: item.title,
        attrs: {
          type: 'button',
          role: 'radio',
          'aria-checked': String(item.id === options.value),
          tabindex: item.id === options.value ? '0' : '-1',
        },
        dataset: { id: item.id },
        on: {
          click: () => {
            apply(item.id);
            options.onChange(item.id);
          },
          keydown: (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = options.items[(index + delta + options.items.length) % options.items.length];
            apply(next.id);
            buttons.find((b) => b.dataset.id === next.id)?.focus();
            options.onChange(next.id);
          },
        },
      },
      item.icon ? icon(item.icon, 'icon') : null,
      item.label ? el('span', { class: 'segmented__label', text: item.label }) : null,
    );
    buttons.push(button);
    node.appendChild(button);
  });

  apply(options.value);
  return { node, setValue: apply };
}

/** 字段外壳：<label> 包住说明与控件（控件自带 id 时也可用 for 关联）。 */
export function field(options: {
  label: string;
  control: HTMLElement;
  hint?: string;
  error?: string;
}): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label', text: options.label }),
    options.control,
    options.hint ? el('span', { class: 'field__hint', text: options.hint }) : null,
    options.error ? el('span', { class: 'field__error', text: options.error }) : null,
  );
}

export interface TextFieldHandle {
  node: HTMLElement;
  input: HTMLInputElement;
  setValue: (value: string) => void;
}

/** 单行输入：Enter 或失焦提交，Esc 放弃（恢复上一次提交值）。 */
export function textField(options: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  type?: 'text' | 'number';
  mono?: boolean;
  hint?: string;
}): TextFieldHandle {
  let committed = options.value;
  const input = el('input', {
    class: `input${options.mono ? ' input--mono' : ''}`,
    attrs: {
      type: options.type ?? 'text',
      value: options.value,
      placeholder: options.placeholder ?? '',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  }) as HTMLInputElement;
  input.value = options.value;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      committed = input.value;
      options.onCommit(input.value);
      input.blur();
    } else if (event.key === 'Escape') {
      input.value = committed;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    if (input.value === committed) return;
    committed = input.value;
    options.onCommit(input.value);
  });
  return {
    node: field({ label: options.label, control: input, hint: options.hint }),
    input,
    setValue: (value) => {
      input.value = value;
      committed = value;
    },
  };
}

export interface SliderFieldHandle {
  node: HTMLElement;
  input: HTMLInputElement;
  setValue: (value: number) => void;
}

/** 拉杆 + 数值显示（拖动只更新显示，不重建 DOM）。 */
export function sliderField(options: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onInput: (value: number) => void;
  format?: (value: number) => string;
}): SliderFieldHandle {
  const output = el('span', { class: 'field__value', text: (options.format ?? String)(options.value) });
  const input = el('input', {
    class: 'slider',
    attrs: {
      type: 'range',
      min: String(options.min),
      max: String(options.max),
      step: String(options.step ?? 1),
      value: String(options.value),
      'aria-label': options.label,
    },
  }) as HTMLInputElement;
  const sync = (): void => {
    output.textContent = (options.format ?? String)(Number(input.value));
  };
  input.addEventListener('input', () => {
    sync();
    options.onInput(Number(input.value));
  });
  return {
    node: el(
      'div',
      { class: 'field field--inline' },
      el(
        'span',
        { class: 'field__row' },
        el('span', { class: 'field__label', text: options.label }),
        output,
      ),
      input,
    ),
    input,
    setValue: (value) => {
      input.value = String(value);
      sync();
    },
  };
}

export interface SwitchHandle {
  node: HTMLElement;
  button: HTMLButtonElement;
  setChecked: (checked: boolean) => void;
}

/** 开关（role=switch），用于布尔设置。 */
export function switchField(options: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}): SwitchHandle {
  const button = el(
    'button',
    {
      class: 'switch',
      attrs: {
        type: 'button',
        role: 'switch',
        'aria-checked': String(options.checked),
        'aria-label': options.label,
      },
      on: {
        click: () => {
          const next = button.getAttribute('aria-checked') !== 'true';
          setChecked(next);
          options.onChange(next);
        },
      },
    },
    el('span', { class: 'switch__track' }, el('span', { class: 'switch__thumb' })),
  );
  const setChecked = (checked: boolean): void => {
    button.setAttribute('aria-checked', String(checked));
    button.classList.toggle('is-on', checked);
  };
  setChecked(options.checked);
  return {
    node: el(
      'div',
      { class: 'field field--switch' },
      el(
        'div',
        { class: 'field__row field__row--switch' },
        el('span', { class: 'field__label', text: options.label }),
        button,
      ),
      options.hint ? el('span', { class: 'field__hint', text: options.hint }) : null,
    ),
    button,
    setChecked,
  };
}

/** 原生下拉（短固定列表）：Windows 深色主题下也保持可读。 */
export function selectField(options: {
  label: string;
  value: string;
  choices: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}): HTMLElement {
  const select = el(
    'select',
    {
      class: 'select',
      attrs: { 'aria-label': options.label },
      on: {
        change: () => options.onChange(select.value),
      },
    },
    ...options.choices.map((choice) =>
      el('option', {
        text: choice.label,
        attrs: { value: choice.value, selected: choice.value === options.value },
      }),
    ),
  ) as HTMLSelectElement;
  select.value = options.value;
  return field({ label: options.label, control: select });
}

export interface SectionHandle {
  node: HTMLElement;
  body: HTMLDivElement;
  setTitle: (title: string) => void;
}

/** 分区：标题 + 可选折叠 + 可选操作区。折叠态由调用方决定并持久化。 */
export function section(options: {
  id?: string;
  title: string;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  actions?: HTMLElement | null;
  className?: string;
}, ...children: Child[]): SectionHandle {
  const body = el('div', { class: 'section__body' }, ...children);
  const titleNode = el('h3', { class: 'section__title', text: options.title });
  const chevron = icon('chevronDown', 'icon section__chevron');
  const head = el('div', { class: 'section__head' });
  const toggle = options.collapsible
    ? el(
        'button',
        {
          class: 'section__toggle',
          attrs: {
            type: 'button',
            'aria-expanded': String(options.open ?? true),
          },
          on: {
            click: () => {
              const open = !body.hidden ? false : true;
              applyOpen(open);
              options.onToggle?.(open);
            },
          },
        },
        chevron,
        titleNode,
      )
    : el('div', { class: 'section__heading' }, titleNode);

  const applyOpen = (open: boolean): void => {
    body.hidden = !open;
    head.querySelector('.section__toggle')?.setAttribute('aria-expanded', String(open));
    head.classList.toggle('is-collapsed', !open);
  };

  head.append(toggle);
  if (options.actions) head.append(el('div', { class: 'section__actions' }, options.actions));
  const node = el(
    'section',
    {
      class: `section${options.className ? ` ${options.className}` : ''}`,
      attrs: options.id ? { 'data-section': options.id } : undefined,
    },
    head,
    body,
  );
  applyOpen(options.collapsible ? (options.open ?? true) : true);

  return { node, body, setTitle: (title) => (titleNode.textContent = title) };
}

/** 空态：一句说明 + 最多两个动作，不写营销文案。 */
export function emptyState(options: {
  title: string;
  hint?: string;
  actions?: HTMLElement[];
  icon?: IconName;
  className?: string;
}): HTMLElement {
  return el(
    'div',
    { class: `empty${options.className ? ` ${options.className}` : ''}` },
    options.icon ? el('div', { class: 'empty__icon' }, icon(options.icon, 'icon icon--24')) : null,
    el('p', { class: 'empty__title', text: options.title }),
    options.hint ? el('p', { class: 'empty__hint', text: options.hint }) : null,
    options.actions && options.actions.length > 0
      ? el('div', { class: 'empty__actions' }, ...options.actions)
      : null,
  );
}

export type BadgeKind = 'neutral' | 'accent' | 'ok' | 'danger' | 'info';

/** 小徽标：状态、来源、参数口径。 */
export function badge(text: string, kind: BadgeKind = 'neutral', title?: string): HTMLElement {
  return el('span', { class: `badge badge--${kind}`, text, title });
}

export interface ProgressHandle {
  node: HTMLElement;
  set: (value: number, max: number, label?: string) => void;
  /** 不确定进度（总量未知）：去掉百分比，只保留文案与循环条。 */
  setIndeterminate: (label: string) => void;
}

/** 进度条：真实进度，带文本值（不伪造百分比）。 */
export function progressBar(options: { label?: string } = {}): ProgressHandle {
  const text = el('span', { class: 'progress__label', text: options.label ?? '' });
  const fill = el('span', { class: 'progress__fill' });
  const track = el('div', {
    class: 'progress__track',
    attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
  }, fill);
  const node = el('div', { class: 'progress' }, text, track);
  return {
    node,
    set: (value, max, label) => {
      const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
      fill.style.setProperty('width', `${ratio * 100}%`);
      track.setAttribute('aria-valuenow', String(value));
      track.setAttribute('aria-valuemax', String(max));
      track.classList.remove('is-indeterminate');
      text.textContent = label ?? `${value}/${max}`;
    },
    setIndeterminate: (label) => {
      track.removeAttribute('aria-valuenow');
      track.classList.add('is-indeterminate');
      fill.style.setProperty('width', '100%');
      text.textContent = label;
    },
  };
}

/** 工具条容器：一行控件，窄窗口自动换行。 */
export function toolbar(...children: Child[]): HTMLElement {
  return el('div', { class: 'toolbar' }, ...children);
}

/** 加载指示（不确定进度用）。 */
export function spinner(label = '加载中…'): HTMLElement {
  return el(
    'span',
    { class: 'spinner', attrs: { role: 'status', 'aria-label': label } },
    el('span', { class: 'spinner__dot' }),
    el('span', { class: 'spinner__dot' }),
    el('span', { class: 'spinner__dot' }),
  );
}

/** 键值行（检视器里展示路径、大小、参数等元信息）。 */
export function metaRow(label: string, value: string, options: { title?: string; mono?: boolean } = {}): HTMLElement {
  return el(
    'div',
    { class: 'meta-row' },
    el('span', { class: 'meta-row__label', text: label }),
    el('span', {
      class: `meta-row__value${options.mono ? ' meta-row__value--mono' : ''}`,
      text: value,
      title: options.title ?? value,
    }),
  );
}
