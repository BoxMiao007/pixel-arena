// 小工具：取路径末端的文件名（Windows 反斜杠与 POSIX 斜杠都支持）。
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
