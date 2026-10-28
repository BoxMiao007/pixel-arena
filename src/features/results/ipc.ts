// 结果域的两个 IPC 命令收口（BD-rate 汇总 / 报告导出）。
//
// 参数与返回形状来自核心库的 serde 输出，不由前端拼装；命令名与后端注册表一致，
// 这里改名字就等于改协议，禁止。

import { invoke } from '@tauri-apps/api/core';

/** 单个格式的 BD-rate 行（与 bdrate::BdrateEntry 的 camelCase 输出一一对应）。 */
export interface BdrateEntry {
  /** 格式显示名：JPEG / WebP / AVIF / JPEG XL / PNG / 其他扩展名大写。 */
  format: string;
  /** BD-rate（%）；null = 不可算（参照行 / 样本不足 / 非单调等），原因在 note。 */
  bdRatePercent: number | null;
  /** 参与拟合的有效点数（跑分成功且 PSNR 有限）。 */
  pointCount: number;
  /** 中文说明：参照格式 / 样本不足 / 无损格式 / 拟合失败原因。 */
  note: string | null;
}

/** 一轮评测的 BD-rate 汇总（与 bdrate::BdrateSummary 一一对应）。 */
export interface BdrateSummary {
  /** 参照格式显示名；null = 没有任何格式点数足够，无法确定参照。 */
  referenceFormat: string | null;
  /** 汇总级中文说明（整体不可算时的原因）。 */
  note: string | null;
  entries: BdrateEntry[];
}

/** 计算本轮的 BD-rate 汇总；失败时 reject 中文原因。 */
export function roundBdrate(groupId: string, roundId: string): Promise<BdrateSummary> {
  return invoke<BdrateSummary>('round_bdrate', { groupId, roundId });
}

export interface RoundExportArgs {
  groupId: string;
  roundId: string;
  kind: 'csv' | 'html';
  /** 保存对话框返回的绝对路径。 */
  path: string;
  /** 只作展示的生成时间（前端按 zh-CN 24 小时制生成）。 */
  generatedAt: string;
}

/** 让后端序列化并写盘，返回实际写入的路径；失败时 reject 中文原因。 */
export function roundExport(args: RoundExportArgs): Promise<string> {
  return invoke<string>('round_export', {
    groupId: args.groupId,
    roundId: args.roundId,
    kind: args.kind,
    path: args.path,
    generatedAt: args.generatedAt,
  });
}
