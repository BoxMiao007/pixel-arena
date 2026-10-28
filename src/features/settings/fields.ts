// 设置面板的表单部件：字段级保存、路径字段、就地错误。
//
// 三条约定（对应 Phase A 的问题 P3/P5/P9）：
// - 提交只发「本次要改的字段」，走 core/settings-save 的串行队列（前后端整份覆盖的坑由它兜住）；
// - 保存失败时保留用户输入，把后端中文原因写在控件旁，并标 aria-invalid；
// - 输入框不用 <label> 包按钮（label 内除被标注控件外不能再有可标注元素），
//   带按钮的路径字段自建 .field 结构并以 for/id 关联。

import { open } from '@tauri-apps/plugin-dialog';
import { getState } from '../../core/store';
import { saveSettingsPatch, type SettingsPatch } from '../../core/settings-save';
import { el } from '../../ui/dom';
import { button, selectField, switchField } from '../../ui/primitives';

/** core/settings-save 保存失败时写状态栏的前缀（失败只报状态栏，不抛错）。 */
const SAVE_ERROR_PREFIX = '保存设置失败：';

/**
 * 提交一个字段级补丁：成功返回 null，失败返回可直接展示的中文原因。
 * 失败原因从状态栏读回——core/settings-save 的失败语义就是「只写状态栏、不改内存」，
 * 这里把那条文案摘出来给控件就地显示（前缀是这两个模块之间的约定）。
 */
export async function attemptSave(patch: SettingsPatch): Promise<string | null> {
  const before = getState().status.text;
  const saved = await saveSettingsPatch(patch);
  if (saved) return null;
  const after = getState().status;
  if (after.isError && after.text !== before && after.text.startsWith(SAVE_ERROR_PREFIX)) {
    return after.text.slice(SAVE_ERROR_PREFIX.length);
  }
  return '保存失败，请再试一次';
}

/** 找（或补上）字段里的错误行；错误行常驻但默认隐藏，避免每次出错都改结构。 */
function errorLineOf(node: HTMLElement): HTMLElement {
  const existing = node.querySelector<HTMLElement>('.field__error');
  if (existing) return existing;
  const line = el('span', { class: 'field__error', attrs: { 'aria-live': 'polite' } });
  line.hidden = true;
  node.appendChild(line);
  return line;
}

/** 在字段上显示/清除错误：错误文案 + 控件的 aria-invalid 与 aria-describedby。 */
export function showFieldError(node: HTMLElement, message: string | null): void {
  const line = errorLineOf(node);
  line.textContent = message ?? '';
  line.hidden = message === null;
  if (!line.id) line.id = `field-error-${Math.random().toString(36).slice(2, 9)}`;

  const control = node.querySelector<HTMLElement>('input, select');
  if (!control) return;
  if (message === null) {
    control.removeAttribute('aria-invalid');
    if (control.getAttribute('aria-describedby') === line.id) {
      control.removeAttribute('aria-describedby');
    }
  } else {
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', line.id);
  }
}

// ---------- 路径字段（文本 + 浏览… + 清空） ----------

export interface PathFieldOptions {
  id: string;
  label: string;
  value: string | null;
  placeholder: string;
  /** 空值时的悬停说明（参数口径），有值时悬停显示完整路径。 */
  docTitle?: string;
  browseTitle: string;
  kind: 'file' | 'directory';
  hint?: string;
  /** 行尾附加按钮（如「官方发布页」）。 */
  extra?: HTMLElement | null;
  /** 提交（null = 清空）；返回错误文案表示保存失败。 */
  onCommit: (value: string | null) => Promise<string | null>;
}

export interface PathFieldHandle {
  node: HTMLElement;
  input: HTMLInputElement;
  /** 用外部（已保存）的值覆盖显示；与当前提交值相同则不动，避免冲掉错误提示。 */
  sync: (value: string | null) => void;
}

/** 路径类字段：Enter 或失焦提交，Esc 放弃本次编辑。 */
export function pathField(options: PathFieldOptions): PathFieldHandle {
  let committed = options.value ?? '';

  const input = el('input', {
    class: 'input input--mono',
    attrs: {
      id: options.id,
      type: 'text',
      placeholder: options.placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  input.value = committed;
  input.title = committed === '' ? (options.docTitle ?? '') : committed;

  // 同一个值的重复提交合并成一次（Enter 后紧跟 blur 会触发两次），
  // 失败过的值也不再因为失焦而反复打 IPC——错误留在原地等用户改。
  let inFlight: string | null = null;
  let lastFailure: { value: string; error: string } | null = null;

  const commit = async (next: string | null): Promise<void> => {
    const normalized = next === null ? '' : next.trim();
    if (normalized === committed) {
      lastFailure = null;
      showFieldError(fieldNode, null);
      return;
    }
    if (lastFailure !== null && lastFailure.value === normalized) {
      showFieldError(fieldNode, lastFailure.error);
      return;
    }
    if (inFlight === normalized) return;
    inFlight = normalized;
    const error = await options.onCommit(normalized === '' ? null : normalized);
    inFlight = null;
    if (error === null) {
      committed = normalized;
      lastFailure = null;
      input.value = normalized;
      input.title = normalized === '' ? (options.docTitle ?? '') : normalized;
      showFieldError(fieldNode, null);
    } else {
      lastFailure = { value: normalized, error };
      // 保留用户输入：他填的路径对不对，改一改就能再试
      showFieldError(fieldNode, error);
    }
  };

  input.addEventListener('keydown', (event) => {
    // 中文输入法组字期间的 Enter/Esc 属于选词，不进提交路径
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(input.value);
      input.blur();
    } else if (event.key === 'Escape') {
      input.value = committed;
      lastFailure = null;
      showFieldError(fieldNode, null);
      input.blur();
    }
  });
  input.addEventListener('blur', () => void commit(input.value));

  const browse = button({
    label: '浏览…',
    size: 'sm',
    onClick: () => {
      void (async () => {
        const selected = await open({
          title: options.browseTitle,
          directory: options.kind === 'directory',
          multiple: false,
        });
        if (typeof selected !== 'string') return;
        input.value = selected;
        await commit(selected);
      })();
    },
  });

  const clear = button({
    label: '清空',
    size: 'sm',
    variant: 'quiet',
    title: '清空该项',
    onClick: () => {
      input.value = '';
      void commit(null);
    },
  });

  const row = el('div', { class: 'settings__path-row' }, input, browse, clear, options.extra ?? null);
  const fieldNode = el(
    'div',
    { class: 'field' },
    el('label', { class: 'field__label', text: options.label, attrs: { for: options.id } }),
    row,
    options.hint ? el('span', { class: 'field__hint', text: options.hint }) : null,
  );

  return {
    node: fieldNode,
    input,
    sync: (value) => {
      const text = value ?? '';
      if (text === committed) return;
      committed = text;
      lastFailure = null;
      input.value = text;
      input.title = text === '' ? (options.docTitle ?? '') : text;
      showFieldError(fieldNode, null);
    },
  };
}

// ---------- 下拉（复用 selectField，补错误行） ----------

export interface SelectHandle {
  node: HTMLElement;
  select: HTMLSelectElement;
  setHint: (text: string) => void;
}

/**
 * 下拉字段：提交失败时把显示值退回上一次生效值并就地报错（调用方负责值本身的副作用，
 * 例如主题预览的 applyTheme 由调用方在 onCommit 里预演与回滚）。
 */
export function selectWithError(options: {
  label: string;
  value: string;
  choices: readonly { value: string; label: string }[];
  hint?: string;
  onCommit: (value: string, previous: string) => Promise<string | null>;
}): SelectHandle {
  let committed = options.value;
  const node = selectField({
    label: options.label,
    value: options.value,
    choices: options.choices,
    onChange: (value) => {
      void (async () => {
        const error = await options.onCommit(value, committed);
        const select = node.querySelector('select');
        if (error === null) {
          committed = value;
          showFieldError(node, null);
        } else {
          if (select) select.value = committed;
          showFieldError(node, error);
        }
      })();
    },
  });

  let hintNode: HTMLElement | null = null;
  if (options.hint !== undefined) {
    hintNode = el('span', { class: 'field__hint', text: options.hint });
    node.insertBefore(hintNode, errorLineOf(node));
  }
  errorLineOf(node);

  const select = node.querySelector('select') as HTMLSelectElement;
  return {
    node,
    select,
    setHint: (text) => {
      if (hintNode) hintNode.textContent = text;
    },
  };
}

// ---------- 开关（复用 switchField，补错误行） ----------

export interface ToggleHandle {
  node: HTMLElement;
  switch: HTMLButtonElement;
  /** 外部（已保存）值覆盖显示，不触发 onCommit。 */
  setChecked: (checked: boolean) => void;
}

export function switchWithError(options: {
  label: string;
  checked: boolean;
  hint?: string;
  onCommit: (checked: boolean) => Promise<string | null>;
}): ToggleHandle {
  const handle = switchField({
    label: options.label,
    checked: options.checked,
    hint: options.hint,
    onChange: (checked) => {
      void (async () => {
        const error = await options.onCommit(checked);
        if (error === null) {
          showFieldError(handle.node, null);
        } else {
          handle.setChecked(!checked);
          showFieldError(handle.node, error);
        }
      })();
    },
  });
  errorLineOf(handle.node);
  return { node: handle.node, switch: handle.button, setChecked: handle.setChecked };
}
