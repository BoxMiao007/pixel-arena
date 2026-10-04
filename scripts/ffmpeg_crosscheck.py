#!/usr/bin/env python3
"""ffmpeg / numpy 双参照交叉验证：核对核心库的 PSNR 与 SSIM。

对 tests/golden.toml 里的每个样例对，用三个来源计算指标并比对：
- 核心库：cargo run --example dump_metrics（被验证对象）
- ffmpeg：-filter_complex "...format=gbrp,psnr/ssim"（外部权威工具）
- numpy：scripts/ssim_reference.py（按 Wang et al. 2004 教科书公式的定义性参照）

容差依据（实测 2026-10-04，详见 pixel-arena-shared/evidence/T02-交叉验证.md）：
- PSNR 核心库 vs ffmpeg：1e-6 dB。两边约定相同（全平面合并 MSE；ffmpeg 的 average
  就是这个口径），像素差为整数、求和为精确值，唯一浮点环节是 log10，跨平台 libm
  差异在最后几位，1e-6 dB 已是宽裕上限。
- SSIM 核心库 vs numpy：1e-9。两边同公式同参数（11x11 高斯窗 sigma=1.5、valid 边界），
  实测逐位一致，1e-9 覆盖浮点求和顺序的抖动。
- SSIM 核心库 vs ffmpeg：0.08。ffmpeg 的 ssim 滤镜不是标准 SSIM：libavfilter/vf_ssim.c
  的 ssim_end1 按 8x8 均匀窗（稳定项按窗像素数缩放：C1=64·0.01²·255²、
  C2=64·63·0.03²·255²）、窗口沿 4 像素网格步进，与 Wang 2004 的 11x11 高斯窗是
  已知变体关系，实测差 0.002~0.08（含噪声或强阶跃的样例差更大）。此容差只验证
  「量级与方向一致，无实现错误」；正确性锚点由 numpy 参照的 1e-9 保证。

用法（在仓库根目录）：python3 scripts/ffmpeg_crosscheck.py
需要：ffmpeg、cargo、uvx（跑 numpy 参照，uv 缓存 numpy/scipy/pillow 后离线可用）。

判定范围：只对两侧都是 PNG（无损）的样例判 PASS/FAIL——所有工具拿到同一份像素，
差异只反映指标实现本身。JPEG/WebP 等有损样例对会经过各自解码器（核心库用纯 Rust
解码器，ffmpeg/libjpeg/libwebp 各自解码），解出的像素本就有解码器间差异（实测
PSNR 差 0.7~0.9 dB），跨工具比对会污染指标验证的容差；这些行打印数值供参考、
不判定，其正确性由黄金基准测试（tests/golden_baseline.rs）守护。
"""
from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_DIR = REPO_ROOT / "crates" / "pixel-arena-core"
DATA_DIR = CORE_DIR / "tests" / "data"

TOLERANCE_PSNR_FFMPEG = 1e-6
TOLERANCE_SSIM_NUMPY = 1e-9
TOLERANCE_SSIM_FFMPEG = 0.08


def is_lossless_pair(reference: Path, distorted: Path) -> bool:
    return reference.suffix.lower() == ".png" and distorted.suffix.lower() == ".png"


def run(command: list[str], cwd: Path) -> tuple[str, str]:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"命令失败 {' '.join(command)}：\n{result.stderr}")
    return result.stdout, result.stderr


def core_metrics(reference: Path, distorted: Path) -> tuple[float, float]:
    stdout, _ = run(
        ["cargo", "run", "-q", "--example", "dump_metrics", "--", str(reference), str(distorted)],
        CORE_DIR,
    )
    psnr = float(re.search(r"psnr=(\S+)", stdout).group(1))
    ssim = float(re.search(r"ssim=(\S+)", stdout).group(1))
    return psnr, ssim


def ffmpeg_metrics(reference: Path, distorted: Path) -> tuple[float, float]:
    """ffmpeg 的 PSNR average 即全平面合并 MSE 口径；SSIM All 即各平面均值。"""
    _, psnr_stderr = run(
        ["ffmpeg", "-hide_banner", "-i", str(reference), "-i", str(distorted),
         "-filter_complex", "[0]format=gbrp[a];[1]format=gbrp[b];[a][b]psnr",
         "-f", "null", "-"],
        REPO_ROOT,
    )
    _, ssim_stderr = run(
        ["ffmpeg", "-hide_banner", "-i", str(reference), "-i", str(distorted),
         "-filter_complex", "[0]format=gbrp[a];[1]format=gbrp[b];[a][b]ssim",
         "-f", "null", "-"],
        REPO_ROOT,
    )
    psnr_avg = float(re.search(r"PSNR .*?average:(\S+)", psnr_stderr).group(1))
    ssim_all = float(re.search(r"SSIM .*?All:(\S+)", ssim_stderr).group(1))
    return psnr_avg, ssim_all


def numpy_ssim(reference: Path, distorted: Path) -> float:
    stdout, _ = run(
        ["uvx", "--with", "numpy", "--with", "scipy", "--with", "pillow",
         "python", str(REPO_ROOT / "scripts" / "ssim_reference.py"),
         str(reference), str(distorted)],
        REPO_ROOT,
    )
    return float(re.search(r"ssim\(mean\) = (\S+)", stdout).group(1))


def main() -> int:
    baseline_path = CORE_DIR / "tests" / "golden.toml"
    baseline = tomllib.loads(baseline_path.read_text())
    rows = []
    failures = []
    for sample in baseline["samples"]:
        reference = DATA_DIR / sample["reference"]
        distorted = DATA_DIR / sample["distorted"]

        core_psnr, core_ssim = core_metrics(reference, distorted)
        ff_psnr, ff_ssim = ffmpeg_metrics(reference, distorted)
        ref_ssim = numpy_ssim(reference, distorted)

        psnr_diff = abs(core_psnr - ff_psnr)
        ssim_numpy_diff = abs(core_ssim - ref_ssim)
        ssim_ff_diff = abs(core_ssim - ff_ssim)
        judge = is_lossless_pair(reference, distorted)
        ok = (psnr_diff <= TOLERANCE_PSNR_FFMPEG
              and ssim_numpy_diff <= TOLERANCE_SSIM_NUMPY
              and ssim_ff_diff <= TOLERANCE_SSIM_FFMPEG)
        verdict = ("PASS" if ok else "FAIL") if judge else "SKIP（有损样例，解码器差异，不判定）"
        if judge and not ok:
            failures.append(sample["name"])
        rows.append((sample["name"], core_psnr, ff_psnr, psnr_diff,
                     core_ssim, ref_ssim, ff_ssim, ssim_numpy_diff, ssim_ff_diff, verdict))

    print("| 样例 | PSNR 核心 | PSNR ffmpeg | ΔPSNR | SSIM 核心 | SSIM numpy | SSIM ffmpeg | ΔSSIM(numpy) | ΔSSIM(ffmpeg) | 判定 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for name, cp, fp, dp, cs, ns, fs, dn, df, verdict in rows:
        print(f"| {name} | {cp:.6f} | {fp:.6f} | {dp:.2e} | {cs:.6f} | {ns:.6f} | {fs:.6f} | {dn:.2e} | {df:.4f} | {verdict} |")

    if failures:
        print(f"\n失败样例：{failures}")
        return 1
    print(f"\n全部通过：PSNR Δ≤{TOLERANCE_PSNR_FFMPEG:g} dB；SSIM Δ(numpy)≤{TOLERANCE_SSIM_NUMPY:g}；SSIM Δ(ffmpeg)≤{TOLERANCE_SSIM_FFMPEG:g}（已知变体）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
