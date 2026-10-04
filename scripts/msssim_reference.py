"""定义性 MS-SSIM 参照实现（严格按 Wang et al. 2003/2004 多尺度公式），用于仲裁核心库自研 MS-SSIM。

用法：uvx --with numpy --with scipy --with pillow python scripts/msssim_reference.py <原图> <跑分图>

定义要点（与 scripts/ssim_reference.py 的单尺度 SSIM 同源）：
- 11x11 高斯窗 sigma=1.5，valid 模式，C1=(0.01*255)^2，C2=(0.03*255)^2；
- 每层先用 2x2 平均滤波（不重叠块取均值）下采样，共最多 5 层；
- 第 1..m-1 层取对比度-结构项 CS 的均值，第 m 层取完整 SSIM 的均值；
- 总分为 (CS_1)^w1 * ... * (CS_{m-1})^{w_{m-1}} * (SSIM_m)^{w_m}，
  权重 w = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333]（TIP 2004 论文值）；
- 层数 m = min(5, 1 + floor(log2(min边长/11)))：图太小撑不起 5 层时从粗到细截断，
  用前 m 个权重（第 m 项用完整 SSIM），不归一化（与核心库约定一致）；
- 负的 CS / SSIM 项按 0 截断再取幂，避免负数的分数次幂产生 NaN。
"""
import math
import sys

import numpy as np
from PIL import Image
from scipy.signal import convolve2d

WEIGHTS = (0.0448, 0.2856, 0.3001, 0.2363, 0.1333)
WINDOW = 11
MAX_SCALES = 5


def gaussian_kernel_2d(size: int = WINDOW, sigma: float = 1.5) -> np.ndarray:
    ax = np.arange(size) - (size - 1) / 2.0
    kernel_1d = np.exp(-(ax**2) / (2.0 * sigma**2))
    kernel_1d /= kernel_1d.sum()
    return np.outer(kernel_1d, kernel_1d)


def ssim_and_cs(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """返回该层的 (mean SSIM, mean CS)。"""
    kernel = gaussian_kernel_2d()
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mu_x = convolve2d(x, kernel, mode="valid")
    mu_y = convolve2d(y, kernel, mode="valid")
    sigma_x2 = convolve2d(x * x, kernel, mode="valid") - mu_x**2
    sigma_y2 = convolve2d(y * y, kernel, mode="valid") - mu_y**2
    sigma_xy = convolve2d(x * y, kernel, mode="valid") - mu_x * mu_y
    cs_map = (2 * sigma_xy + c2) / (sigma_x2 + sigma_y2 + c2)
    ssim_map = ((2 * mu_x * mu_y + c1) / (mu_x**2 + mu_y**2 + c1)) * cs_map
    return float(ssim_map.mean()), float(cs_map.mean())


def downsample(plane: np.ndarray) -> np.ndarray:
    """2x2 平均滤波下采样：不重叠块取均值，奇数尺寸丢弃末行/末列。"""
    h = plane.shape[0] - (plane.shape[0] % 2)
    w = plane.shape[1] - (plane.shape[1] % 2)
    plane = plane[:h, :w]
    return (
        plane[0::2, 0::2] + plane[1::2, 0::2] + plane[0::2, 1::2] + plane[1::2, 1::2]
    ) / 4.0


def ms_ssim_channel(x: np.ndarray, y: np.ndarray) -> float:
    min_side = min(x.shape[0], x.shape[1])
    scales = min(MAX_SCALES, 1 + int(math.floor(math.log2(min_side / WINDOW))))
    cs_values = []
    for level in range(scales):
        ssim, cs = ssim_and_cs(x, y)
        cs_values.append(cs)
        if level < scales - 1:
            x, y = downsample(x), downsample(y)
    result = 1.0
    for level, weight in enumerate(WEIGHTS[:scales]):
        if level < scales - 1:
            term = max(cs_values[level], 0.0)
        else:
            term = max(ssim, 0.0)
        result *= term**weight
    return result


def main() -> None:
    reference = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float64)
    distorted = np.asarray(Image.open(sys.argv[2]).convert("RGB"), dtype=np.float64)
    scores = [
        ms_ssim_channel(reference[:, :, c], distorted[:, :, c]) for c in range(3)
    ]
    print(f"per-channel: {scores[0]:.6f} {scores[1]:.6f} {scores[2]:.6f}")
    print(f"ms_ssim(mean) = {sum(scores) / 3:.9f}")


if __name__ == "__main__":
    main()
