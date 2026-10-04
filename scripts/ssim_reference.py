"""定义性 SSIM 参照实现（严格按 Wang et al. 2004 教科书公式），用于仲裁核心库与 ffmpeg 的分歧。

用法：uvx --with numpy --with scipy --with pillow python scripts/ssim_reference.py <原图> <跑分图>
"""
import sys

import numpy as np
from PIL import Image
from scipy.signal import convolve2d


def gaussian_kernel_2d(size: int = 11, sigma: float = 1.5) -> np.ndarray:
    ax = np.arange(size) - (size - 1) / 2.0
    kernel_1d = np.exp(-(ax**2) / (2.0 * sigma**2))
    kernel_1d /= kernel_1d.sum()
    return np.outer(kernel_1d, kernel_1d)


def ssim_channel(x: np.ndarray, y: np.ndarray) -> float:
    kernel = gaussian_kernel_2d()
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mu_x = convolve2d(x, kernel, mode="valid")
    mu_y = convolve2d(y, kernel, mode="valid")
    sigma_x2 = convolve2d(x * x, kernel, mode="valid") - mu_x**2
    sigma_y2 = convolve2d(y * y, kernel, mode="valid") - mu_y**2
    sigma_xy = convolve2d(x * y, kernel, mode="valid") - mu_x * mu_y
    ssim_map = ((2 * mu_x * mu_y + c1) * (2 * sigma_xy + c2)) / (
        (mu_x**2 + mu_y**2 + c1) * (sigma_x2 + sigma_y2 + c2)
    )
    return float(ssim_map.mean())


def main() -> None:
    reference = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float64)
    distorted = np.asarray(Image.open(sys.argv[2]).convert("RGB"), dtype=np.float64)
    scores = [
        ssim_channel(reference[:, :, c], distorted[:, :, c]) for c in range(3)
    ]
    print(f"per-channel: {scores[0]:.6f} {scores[1]:.6f} {scores[2]:.6f}")
    print(f"ssim(mean) = {sum(scores) / 3:.9f}")


if __name__ == "__main__":
    main()
