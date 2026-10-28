// 结果域的 IPC 命令收口（报告导出）。
//
// 参数与返回形状来自核心库的 serde 输出，不由前端拼装；命令名与后端注册表一致，
// 这里改名字就等于改协议，禁止。

import { invoke } from '@tauri-apps/api/core';

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
