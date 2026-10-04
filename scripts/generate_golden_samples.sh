#!/usr/bin/env bash
# 生成黄金基准样例图（crates/pixel-arena-core/tests/data/）。
# 这些样例是全项目指标正确性的锚点：核心库测试与 ffmpeg 交叉验证脚本用同一批文件。
# 已入库的样例就是最终事实；本脚本只在需要重造样例时使用（需要 ImageMagick 与网络）。
#
# 用法：scripts/generate_golden_samples.sh [源照片路径]
# 不传源照片时会从 picsum.photos 下载一张固定图（id/1025，Unsplash License，可自由使用）。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
data_dir="$repo_root/crates/pixel-arena-core/tests/data"
mkdir -p "$data_dir"

# 照片样例：外部照片转 8-bit PNG（-strip 去掉元数据，保证文件内容只含像素）。
photo_src="${1:-/tmp/pixel-arena-photo-src.jpg}"
if [ ! -f "$photo_src" ]; then
    curl -sL --max-time 60 "https://picsum.photos/id/1025/256/256" -o "$photo_src"
fi
magick "$photo_src" -strip -depth 8 "$data_dir/photo-ref.png"

# 照片跑分图 1：轻微模糊 + 固定种子高斯噪声，模拟一次有损压缩的整体退化。
magick "$data_dir/photo-ref.png" -blur 0x0.6 -seed 7 +noise Gaussian -depth 8 "$data_dir/photo-dis.png"
# 照片跑分图 2/3：直接有损编码，覆盖 JPEG 与 WebP 解码路径。
magick "$data_dir/photo-ref.png" -quality 85 -depth 8 "$data_dir/photo-dis.jpg"
magick "$data_dir/photo-ref.png" -quality 80 -define webp:method=6 "$data_dir/photo-dis.webp"

# 纯色：零方差场景锚点。原图与跑分图只差一点亮度，SSIM 接近 1，PSNR 有限。
magick -size 128x128 xc:"gray(128)" -depth 8 "$data_dir/solid-ref.png"
magick -size 128x128 xc:"gray(132)" -depth 8 "$data_dir/solid-dis.png"

# 渐变：平滑区域锚点。跑分图用 posterize 做带状量化（确定性，不用随机数）。
magick -size 128x128 gradient:"gray(0)"-"gray(255)" -rotate 90 -depth 8 "$data_dir/gradient-ref.png"
magick "$data_dir/gradient-ref.png" -posterize 22 -depth 8 "$data_dir/gradient-dis.png"

# 噪声：两个独立种子生成的均匀噪声场，零相关，SSIM 接近 0 的下界锚点。
# 输出用 PNG24: 强制 8-bit RGB——否则 PNG 编码器会把噪声优化成 1-bit 二值图。
magick -size 128x128 xc:"gray(50%)" -seed 42 +noise Random PNG24:"$data_dir/noise-ref.png"
magick -size 128x128 xc:"gray(50%)" -seed 99 +noise Random PNG24:"$data_dir/noise-dis.png"

echo "生成完成，校验位深与尺寸："
identify -format "%f %wx%h depth=%z\n" "$data_dir"/*.png "$data_dir"/*.jpg "$data_dir"/*.webp
