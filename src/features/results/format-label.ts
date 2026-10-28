// 文件路径 → 格式显示名，按扩展名映射。
//
// 口径与核心库 bdrate::format_label 一致（BD-rate 汇总里的「格式」列就是这么来的）：
// 结果表新增的「格式」列与 BD-rate 页签的格式列必须逐字相同，否则同一张图在两个
// 视图里会显示成两种格式。

const EXTENSION_LABELS: Record<string, string> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  jxl: 'JPEG XL',
  png: 'PNG',
};

/** 取扩展名（最后一个点之后，大小写不敏感；无扩展名或点在开头返回空串）。 */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 格式显示名：已知扩展名走固定表；未知扩展名按 ASCII 大写；无扩展名为「未知格式」。
 * 不做 MIME 探测——这是纯展示映射，与后端按扩展名分组的口径保持一致。
 */
export function formatLabelForPath(path: string): string {
  const ext = extensionOf(path);
  if (ext === '') return '未知格式';
  const known = EXTENSION_LABELS[ext];
  if (known) return known;
  return ext.replace(/[a-z]/g, (char) => char.toUpperCase());
}
