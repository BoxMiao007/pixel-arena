#!/usr/bin/env bash
# 再生视频跑分测试夹具（T14）。用 testsrc 生成三段秒级小视频：
#   video-ref-500k.mp4      原视频（基准，500 kbps）
#   video-dis-150k.mp4      跑分视频（低码率压缩，150 kbps）
#   video-small-160x120.mp4 分辨率不一致的跑分视频（练习错误路径）
#
# 用法：scripts/generate_video_fixtures.sh [输出目录]
# ffmpeg 取 PATH 上的，或用环境变量 PIXEL_ARENA_FFMPEG 指定（如应用数据目录 tools/ 下的静态构建）。
# 再生后指标数值会随编码器版本略有漂移，需要同步核对 tests 里的区间断言。
set -euo pipefail

FFMPEG="${PIXEL_ARENA_FFMPEG:-ffmpeg}"
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/crates/pixel-arena-core/tests/data/video}"
mkdir -p "$OUT"

"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i testsrc=size=320x240:rate=30:duration=3 \
  -c:v libx264 -preset veryfast -b:v 500k -pix_fmt yuv420p \
  "$OUT/video-ref-500k.mp4"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i testsrc=size=320x240:rate=30:duration=3 \
  -c:v libx264 -preset veryfast -b:v 150k -pix_fmt yuv420p \
  "$OUT/video-dis-150k.mp4"
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i testsrc=size=160x120:rate=30:duration=2 \
  -c:v libx264 -preset veryfast -b:v 200k -pix_fmt yuv420p \
  "$OUT/video-small-160x120.mp4"

ls -la "$OUT"
