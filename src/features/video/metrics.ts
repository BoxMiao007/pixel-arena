// 视频指标列序与排序取值（纯函数，无 DOM）。
//
// 指标键来自核心库落库的存储键（VMAF / PSNR / SSIM），本模块只管「怎么排、怎么取值」。
// 从旧 src/video.ts 复制并保留原有偏好序：VMAF 是视频主指标，排最前。

import type { CandidateVideo } from '../../core/model';
import { fileName } from '../../core/util';

/** 指标列顺序偏好：VMAF 排最前，其余按首现顺序跟在后面（数据驱动，新指标自动多列）。 */
export function videoMetricKeys(candidates: readonly CandidateVideo[]): string[] {
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.metrics) continue;
    for (const key of Object.keys(candidate.metrics)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const preferred = ['VMAF', 'PSNR', 'SSIM'].filter((key) => keys.includes(key));
  return [...preferred, ...keys.filter((key) => !preferred.includes(key))];
}

/** 排序取值：缺值（未跑分/失败/无耗时）返回 null，排序时沉底。 */
export function videoSortableValue(
  candidate: CandidateVideo,
  key: string,
): number | string | null {
  if (key === 'name') return fileName(candidate.path);
  if (key === 'fileSize') return candidate.fileSize;
  if (key === 'sizeRatio') return candidate.sizeRatio;
  if (key === 'elapsedMs') return candidate.elapsedMs ?? null;
  const metric = candidate.metrics?.[key];
  if (metric === undefined) return null;
  return metric === 'inf' ? Number.POSITIVE_INFINITY : metric;
}

/** 首点排序方向：文件大小/耗时越小越好，指标与体积比默认降序（大的在前）。 */
export function firstClickDir(key: string): 1 | -1 {
  return key === 'fileSize' || key === 'elapsedMs' || key === 'name' ? 1 : -1;
}
