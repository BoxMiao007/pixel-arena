#!/usr/bin/env bash
# 捆绑编码器准备（T29-4，决策 0014 修订）：按平台下载锁定工件 → sha256 校验 →
# 解出成员可执行文件到 src-tauri/resources/encoders/，供 tauri 打包捆绑进三端
# 安装包。Linux 与 macOS 共用本脚本；Windows 走 bundle-encoders.ps1。
#
# URL 与 sha256 必须与 crates/pixel-arena-core/src/encode.rs 的来源清单同步修改
#（升级版本 = 两边一起改）。本地已有同名工件（如仓库 assets/encoders/ 或此前
# 下载缓存）时直接复用，不重复下载。

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$repo_root/src-tauri/resources/encoders"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

os="$(uname -s)" # Linux / Darwin
mkdir -p "$dest"

# fetch <url> <sha256> <输出文件名>：本地缓存（assets/encoders/ 或工作目录）优先
fetch() {
  local url="$1" sha256="$2" out="$3"
  for candidate in "$repo_root/assets/encoders/$out" "$work/$out"; do
    if [[ -f "$candidate" ]]; then
      echo "使用本地工件 $candidate"
      cp "$candidate" "$work/$out"
      break
    fi
  done
  if [[ ! -f "$work/$out" ]]; then
    echo "下载 $url"
    curl -fL --retry 3 --retry-delay 2 -o "$work/$out" "$url"
  fi
  echo "$sha256  $work/$out" | sha256sum -c -
}

# extract <工件路径> <成员名>…：解包整个工件后按文件名查找成员（容忍包内多一层目录，
# 与核心库 extract_archive_members 同一口径），复制到捆绑目录并补执行权限
extract() {
  local archive="$1"; shift
  local stage="$work/stage"
  rm -rf "$stage"; mkdir -p "$stage"
  case "$archive" in
    *.zip) unzip -q "$archive" -d "$stage" ;;
    *.tar.gz|*.tgz) tar -xzf "$archive" -C "$stage" ;;
    *) echo "不支持的工件格式: $archive"; exit 1 ;;
  esac
  local member found
  for member in "$@"; do
    found="$(find "$stage" -type f -name "$member" | head -n1)"
    if [[ -z "$found" ]]; then
      echo "工件内未找到成员 ${member}（${archive}）" >&2
      exit 1
    fi
    cp "$found" "$dest/$member"
    chmod 755 "$dest/$member"
    # ${member} 必须带花括号：macOS 自带 bash 3.2 非 UTF-8 aware，
    # $member 后紧跟全角括号会把高位字节并进变量名报 unbound、捆绑半途而废
    echo "捆绑成员 ${member}（来自 $(basename "$archive")）"
  done
}

if [[ "$os" == "Linux" ]]; then
  # ---------- Linux x86_64：mozjpeg / libwebp / libavif / libjxl ----------
  # MozJPEG：锁定工件在 Release encoders-v1。若上游资产缺失（404）则按
  # macos-artifact.yml 同一配置（无 SIMD、静态）从源码构建——捆绑文件不做哈希
  # 锚定（运行期只查存在性），构建产物直接入捆绑目录。
  mozjpeg_url="https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-linux-x86_64.tar.gz"
  mozjpeg_sha="6c2795a90da52d2fe0361fc6580cf4be309bb873797acb967725fe8f98325dee"
  if fetch "$mozjpeg_url" "$mozjpeg_sha" "mozjpeg-v4.1.5-linux-x86_64.tar.gz" 2>/dev/null; then
    extract "$work/mozjpeg-v4.1.5-linux-x86_64.tar.gz" cjpeg
  else
    echo "MozJPEG 锁定工件不可得（encoders-v1 缺 linux 资产），从源码构建 cjpeg…"
    curl -sL -o "$work/mozjpeg-src.tar.gz" https://github.com/mozilla/mozjpeg/archive/refs/tags/v4.1.5.tar.gz
    tar -xzf "$work/mozjpeg-src.tar.gz" -C "$work"
    # 全静态（ENABLE_STATIC=1 + ENABLE_SHARED=0，mozjpeg 是 libjpeg-turbo 分支，
    # BUILD_SHARED_LIBS 管不住它；否则 cjpeg 动态链 libjpeg.so）。静态构建的目标
    # 与产物名是 cjpeg-static；PNG 缺省启用且链接静态 libpng/libz。其余与
    # macos-artifact.yml 同配置（无 SIMD）
    cmake -S "$work/mozjpeg-4.1.5" -B "$work/mozjpeg-build" -G Ninja \
      -DWITH_SIMD=0 -DENABLE_STATIC=1 -DENABLE_SHARED=0 \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release
    cmake --build "$work/mozjpeg-build" --target cjpeg-static
    cp "$work/mozjpeg-build/cjpeg-static" "$dest/cjpeg"
    chmod 755 "$dest/cjpeg"
    echo "捆绑成员 cjpeg（源码构建）"
  fi

  fetch "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-linux-x86-64.tar.gz" \
    "1c5ffab71efecefa0e3c23516c3a3a1dccb45cc310ae1095c6f14ae268e38067" "libwebp-1.6.0-linux-x86-64.tar.gz"
  extract "$work/libwebp-1.6.0-linux-x86-64.tar.gz" cwebp

  fetch "https://github.com/AOMediaCodec/libavif/releases/download/v1.4.2/linux-artifacts.zip" \
    "faf58a670ffbfdc0e3559e6d37592cff277c447dd39453f1cd1d7d7f5a20b8ef" "libavif-linux-artifacts.zip"
  extract "$work/libavif-linux-artifacts.zip" avifenc avifdec

  fetch "https://github.com/libjxl/libjxl/releases/download/v0.11.1/jxl-linux-x86_64-static-v0.11.1.tar.gz" \
    "7ba87d09f220568a7e84c2a62e9fa8be608443930dec10b2799271d4cf032293" "jxl-linux-x86_64-static-v0.11.1.tar.gz"
  extract "$work/jxl-linux-x86_64-static-v0.11.1.tar.gz" cjxl
elif [[ "$os" == "Darwin" ]]; then
  # ---------- macOS arm64：MozJPEG / libwebp / libjxl 锁定工件在 Release
  # encoders-v1（仓库 assets/encoders/ 有同名缓存时本地复用）；libavif 直连官方
  # Release ----------
  fetch "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-macos-arm64.tar.gz" \
    "bf8cceff4444716868c3b45acb3937a1e317219be376fafdd7e686093ed088d3" "mozjpeg-v4.1.5-macos-arm64.tar.gz"
  extract "$work/mozjpeg-v4.1.5-macos-arm64.tar.gz" cjpeg

  fetch "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/libwebp-1.6.0-macos-arm64.tar.gz" \
    "2ad04ce464327245f0a49dda0ccaf7791e438a2f3331f7f9bbab892c0df7789c" "libwebp-1.6.0-macos-arm64.tar.gz"
  extract "$work/libwebp-1.6.0-macos-arm64.tar.gz" cwebp

  fetch "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/libjxl-v0.11.1-macos-arm64.tar.gz" \
    "2b53e626b2747c50841712672b3f9391238f47d3babcd2cc333e3567eb0f62a8" "libjxl-v0.11.1-macos-arm64.tar.gz"
  extract "$work/libjxl-v0.11.1-macos-arm64.tar.gz" cjxl

  fetch "https://github.com/AOMediaCodec/libavif/releases/download/v1.4.2/macOS-artifacts.zip" \
    "41f9a3db7b7697aa4f9c83d5e07a1b2e00f28f23676d3f27698eef766689a6b6" "libavif-macOS-artifacts.zip"
  extract "$work/libavif-macOS-artifacts.zip" avifenc avifdec
else
  echo "不支持的平台: ${os}（Linux/macOS 用本脚本，Windows 用 bundle-encoders.ps1）" >&2
  exit 1
fi

echo "---- 捆绑目录内容 ----"
ls -la "$dest"

# 自检：五个成员必须齐备，缺一个就让打包失败（不靠产物验证步骤兜底）
for m in cjpeg cwebp avifenc avifdec cjxl; do
  if [[ ! -x "$dest/$m" ]]; then
    echo "捆绑自检失败：缺成员 $m" >&2
    exit 1
  fi
done
echo "捆绑自检通过：五成员齐备"
