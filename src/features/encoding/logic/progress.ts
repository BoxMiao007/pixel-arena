// 长任务进度的展示口径：只认 busy 条目里的结构化 completed/total。
//
// detail 只放人类可读文案（如「正在生成 AVIF q75」），不拼 N/M；从 detail 反解
// 进度会在文案换成纯标签时静默退化成不确定态，且各入口的写法难以保持一致。
// 两边都有限且 total > 0 才算确定进度，其余一律按不确定进度展示。

export interface BusyProgressSource {
  /** 展示用动词（如「正在自动编码」）。 */
  label: string;
  /** 人类可读的当前动作；空串时回退到 label。 */
  detail: string;
  completed?: number;
  total?: number;
}

export type BusyProgressView =
  | { kind: 'determinate'; completed: number; total: number; label: string }
  | { kind: 'indeterminate'; label: string };

/** 把忙状态条目归一成进度条可直接消费的视图（纯函数，不碰 DOM / store）。 */
export function busyProgressView(entry: BusyProgressSource): BusyProgressView {
  const label = entry.detail || entry.label;
  const { completed, total } = entry;
  if (
    completed !== undefined &&
    total !== undefined &&
    Number.isFinite(completed) &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return { kind: 'determinate', completed, total, label };
  }
  return { kind: 'indeterminate', label };
}
