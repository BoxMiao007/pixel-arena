// 小工具：取路径末端的文件名（Windows 反斜杠与 POSIX 斜杠都支持）。
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 胶囊 / 结果表 / 状态栏统一的文件名显示上限（T18）。 */
export const FILE_NAME_MAX = 24;

/**
 * 文件名统一显示（T18）：超长时中间截断——保留开头与结尾主干、中间以「…」
 * 省略，扩展名原样保留；不超长原样返回。悬浮完整内容（全路径）由调用方以
 * title 提供，本函数只管可见文本。
 *
 * 扩展名定义：最后一个点之后（点在开头如 ".bashrc" 视为无扩展名）。
 * 扩展名本身长到连省略号都放不下时，退化为头部截断（结果永不超上限）。
 */
export function truncateFileName(name: string, maxLen: number = FILE_NAME_MAX): string {
  if (name.length <= maxLen) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  // 1 = 省略号「…」占的一格；剩余空间分给主干首尾
  const budget = maxLen - 1 - ext.length;
  if (budget < 2) {
    return `${name.slice(0, Math.max(1, maxLen - 1))}…`;
  }
  const headLen = Math.ceil(budget / 2);
  const tailLen = budget - headLen;
  return `${stem.slice(0, headLen)}…${stem.slice(-tailLen)}${ext}`;
}

/**
 * 版本号统一简化显示（v0.1.5 反馈）：从探测/锁定版本原文中取首个
 * 「数字.数字…」版本串并加 v 前缀，如「mozjpeg version 4.1.5 (build 20261005)」
 * →「v4.1.5」、「4.1.5」→「v4.1.5」。解析不出数字版本时原样返回（不造假格式，
 * 调用方将原文照显）；完整原文由调用方另行展示（设置页 #45 详文气泡）。
 * 纯数字串如「4」不算版本（必须含点），避免把 build 日期/退出码误当版本。
 */
export function versionLabel(raw: string): string {
  const match = raw.match(/\d+(?:\.\d+)+/);
  return match ? `v${match[0]}` : raw;
}

/**
 * 剪贴板写入（票 #58 从 advanced-ui 提取共享）：clipboard API 优先，不可用时
 * 走隐藏文本域兜底；写入完成后（成功才算）回调 done，由调用方负责用户反馈。
 */
export function copyText(text: string, done: () => void): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(), () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

/** 隐藏文本域复制兜底（clipboard API 不可用时）。 */
function fallbackCopy(text: string, done: () => void): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    done();
  } finally {
    textarea.remove();
  }
}
