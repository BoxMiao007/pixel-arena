// 工作区数据模型：与核心库 workspace.rs 的 serde 输出（camelCase）一一对应。
// 前端不持有持久化逻辑、不自己算状态：所有改动经 IPC 落到核心库并立即写盘，
// 命令返回最新工作区整份状态，前端照着重渲染。
//
// 本文件只放「数据形状 + 纯派生函数」，可脱离 DOM 单测。

/** 指标值：有限数值，或 "inf" 哨兵（两图完全一致时 PSNR 的情形）。 */
export type MetricValue = number | 'inf';

/** 评测轮内容里的一张跑分图及其跑分结果。 */
export interface CandidateImage {
  path: string;
  fileSize: number;
  /** 相对原图的体积比（跑分图大小 / 原图大小）。未选原图前为 null。 */
  sizeRatio: number | null;
  /** 指标名 → 值；未跑分或跑分失败为 null。 */
  metrics: Record<string, MetricValue> | null;
  /** 编码参数文本（如「JPEG q75」「PNG 无损」）；外部导入为 null。 */
  encodingParams?: string | null;
  /** 备注（大小优先不可达标注），随评测轮持久化。 */
  note?: string | null;
  /** 跑分失败原因（中文，可直接展示）。 */
  error: string | null;
}

/** 评测轮内容里的一段跑分视频及其跑分结果（字段语义与图片一致）。 */
export interface CandidateVideo {
  path: string;
  fileSize: number;
  sizeRatio: number | null;
  metrics: Record<string, MetricValue> | null;
  encodingParams?: string | null;
  error: string | null;
  /** 本对跑分耗时（毫秒）。未跑分时为 null。 */
  elapsedMs?: number | null;
}

/** 评测轮：一次评测（一张原图/一段原视频 + 若干跑分图/跑分视频）。 */
export interface Round {
  id: string;
  name: string;
  referencePath: string | null;
  referenceSize: number | null;
  candidates: CandidateImage[];
  videoReferencePath?: string | null;
  videoCandidates?: CandidateVideo[];
  /** 轮级备注（高级创建确认后写入的配置摘要）。 */
  note?: string | null;
}

/** 跑分组类型：新建时选定、后端无修改入口。 */
export type GroupKind = 'image' | 'video';

export interface Group {
  id: string;
  name: string;
  kind: GroupKind;
  rounds: Round[];
  activeRoundId: string | null;
}

export interface Workspace {
  formatVersion: number;
  groups: Group[];
  activeGroupId: string | null;
}

/** 当前激活的跑分组；空工作区或激活 id 失效时为 null。 */
export function activeGroup(ws: Workspace | null): Group | null {
  if (!ws || !ws.activeGroupId) return null;
  return ws.groups.find((group) => group.id === ws.activeGroupId) ?? null;
}

/** 当前激活的评测轮（组 + 轮）。 */
export function activeRound(ws: Workspace | null): { group: Group; round: Round } | null {
  const group = activeGroup(ws);
  const round = group?.rounds.find((item) => item.id === group.activeRoundId);
  return group && round ? { group, round } : null;
}

/** 类型的界面文案。 */
export function groupKindLabel(kind: GroupKind): string {
  return kind === 'video' ? '视频跑分组' : '图片跑分组';
}

/** 轮内是否有值得确认后才销毁的内容（关闭组 / 删除轮前的确认依据）。 */
export function roundHasContent(round: Round): boolean {
  return (
    round.referencePath !== null ||
    round.candidates.length > 0 ||
    (round.videoReferencePath ?? null) !== null ||
    (round.videoCandidates?.length ?? 0) > 0
  );
}

/** 组内是否有任何内容（关闭有内容的组要确认）。 */
export function groupHasContent(group: Group): boolean {
  return group.rounds.some(roundHasContent);
}

/** 指标列由数据驱动：所有行出现过的指标键都会成为一列（新指标自动多列）。 */
export function metricKeys(candidates: readonly CandidateImage[]): string[] {
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.metrics) continue;
    for (const key of Object.keys(candidate.metrics)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** AVIF / JPEG XL 的查看代片判定（扩展名大小写不敏感）。 */
export function isProxyFormat(path: string): boolean {
  return /\.(avif|jxl)$/i.test(path);
}

/**
 * 查看器实际加载的路径：AVIF / JPEG XL 在 WebView 里解不了，核心库会把产物
 * 另存为同名 `.png` 代片。代片只影响显示，跑分与结果表始终用产物本身。
 * 人工导入的 AVIF/JXL 没有代片，加载会失败——调用方据此给明确的中文说明。
 */
export function proxyPathFor(path: string): string {
  return isProxyFormat(path) ? `${path}.png` : path;
}
