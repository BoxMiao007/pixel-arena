// 行状态文案：结果表、粘贴到剪贴板的 CSV/Markdown 共用一份判定与措辞。
//
// 四段文案与核心库 report.rs 的 status_text 同口径（导出文件里的状态列也是这四段），
// 改文案会同时改变导出内容，属于破坏性变更——放这里是为了让界面与复制产物只有一个源。

import type { MetricValue } from '../../core/model';

export type RowStatus = 'fail' | 'running' | 'pending' | 'done';

export interface StatusSource {
  error: string | null;
  metrics: Record<string, MetricValue> | null;
}

/** 判定顺序与旧界面一致：失败 > 跑分中 > 待跑分 > 完成。 */
export function rowStatus(source: StatusSource, running: boolean): RowStatus {
  if (source.error !== null) return 'fail';
  if (running) return 'running';
  if (source.metrics === null) return 'pending';
  return 'done';
}

export function rowStatusText(status: RowStatus, error: string | null): string {
  switch (status) {
    case 'fail':
      return `失败：${error ?? '未知原因'}`;
    case 'running':
      return '跑分中…';
    case 'pending':
      return '待跑分';
    case 'done':
      return '完成';
  }
}
