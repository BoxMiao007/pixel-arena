// 图片跑分指标：解码（统一 8-bit sRGB）+ PSNR + SSIM。
// 指标实现的锚点是黄金基准测试（tests/golden_baseline.rs），并与 ffmpeg 交叉验证过
//（对照表见 pixel-arena-shared/evidence/T02-交叉验证.md）。

use crate::error::CoreError;
use image::{DynamicImage, ImageBuffer, ImageReader, Rgb};
use std::io::BufReader;
use std::path::Path;

/// 一轮图片跑分的质量指标：跑分图相对原图。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageMetrics {
    /// PSNR（dB）。按全通道合并 MSE 计算；两图逐像素完全一致时为 [`f64::INFINITY`]。
    pub psnr: f64,
    /// SSIM（Wang et al. 2004，11x11 高斯窗 sigma=1.5，K1=0.01，K2=0.03）。
    /// 取 sRGB 三个通道各自 SSIM 的算术平均，理论范围约 [-1, 1]。
    pub ssim: f64,
}

/// 对一张原图与一张跑分图计算质量指标（PSNR / SSIM）。
///
/// 两图统一按 8-bit sRGB 处理（忽略 ICC 配置；含 alpha 的图丢弃 alpha 通道，
/// 这是第一版的已知局限，见规格 Out of Scope「完整 ICC 色彩管理」）。
///
/// # 错误
/// - 文件无法读取或不是受支持的图片格式时返回 [`CoreError::Io`] / [`CoreError::Decode`]；
/// - 两图尺寸不一致时返回 [`CoreError::DimensionMismatch`]。
pub fn score_images(
    reference: impl AsRef<Path>,
    distorted: impl AsRef<Path>,
) -> Result<ImageMetrics, CoreError> {
    let reference = reference.as_ref();
    let distorted = distorted.as_ref();

    let reference = decode_srgb(reference)?;
    let distorted = decode_srgb(distorted)?;

    if reference.dimensions() != distorted.dimensions() {
        return Err(CoreError::DimensionMismatch {
            reference: reference.dimensions(),
            distorted: distorted.dimensions(),
        });
    }

    Ok(ImageMetrics {
        psnr: psnr(&reference, &distorted),
        ssim: ssim(&reference, &distorted),
    })
}

/// 解码图片并统一转为 8-bit sRGB（灰度复制到三通道，alpha 丢弃）。
///
/// 用内容嗅探（魔数）判断格式，扩展名只作提示：扩展名错误或缺失也能解码。
fn decode_srgb(path: &Path) -> Result<ImageBuffer<Rgb<u8>, Vec<u8>>, CoreError> {
    let file = std::fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|source| CoreError::Decode {
            path: path.to_path_buf(),
            message: source.to_string(),
        })?;
    let decoded: DynamicImage = reader.decode().map_err(|message| CoreError::Decode {
        path: path.to_path_buf(),
        message: message.to_string(),
    })?;
    Ok(decoded.to_rgb8())
}

/// PSNR = 10·log10(255² / MSE)，MSE 按全部像素 × 3 通道合并计算（池化约定）。
/// 完全一致（MSE = 0）时 PSNR 为无穷大。
fn psnr(
    reference: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    distorted: &ImageBuffer<Rgb<u8>, Vec<u8>>,
) -> f64 {
    let max_value = 255.0_f64;
    let mut squared_error_sum = 0.0_f64;
    for (ref_pixel, dis_pixel) in reference.pixels().zip(distorted.pixels()) {
        for channel in 0..3 {
            let diff = ref_pixel[channel] as f64 - dis_pixel[channel] as f64;
            squared_error_sum += diff * diff;
        }
    }
    let mse = squared_error_sum / (reference.pixels().count() * 3) as f64;
    if mse == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (max_value * max_value / mse).log10()
}

/// SSIM 参数与公式来自 Wang et al. 2004《Image quality assessment: from error
/// visibility to structural similarity》，11x11 高斯窗 sigma=1.5，均值只统计
/// 窗口完整覆盖的像素（valid 模式，论文原始做法）。
/// 注：ffmpeg 的 ssim 滤镜是另一种口径（8x8 均匀窗、稳定项按窗像素数缩放、
/// 窗口沿 4 像素网格步进，见 libavfilter/vf_ssim.c 的 ssim_end1），数值存在
/// 已知的系统性差异，交叉验证时的容差依据见 scripts/ffmpeg_crosscheck.py 头注。
fn ssim(
    reference: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    distorted: &ImageBuffer<Rgb<u8>, Vec<u8>>,
) -> f64 {
    const K1: f64 = 0.01;
    const K2: f64 = 0.03;
    const MAX_VALUE: f64 = 255.0;
    const WINDOW_RADIUS: usize = 5;
    const SIGMA: f64 = 1.5;
    let c1 = (K1 * MAX_VALUE) * (K1 * MAX_VALUE);
    let c2 = (K2 * MAX_VALUE) * (K2 * MAX_VALUE);

    let (width, height) = reference.dimensions();
    let channel_count = 3;
    let mut channel_ssim_sum = 0.0_f64;
    for channel in 0..channel_count {
        let x: Vec<f64> = reference.pixels().map(|p| p[channel] as f64).collect();
        let y: Vec<f64> = distorted.pixels().map(|p| p[channel] as f64).collect();

        let mu_x = gaussian_blur_valid(&x, width as usize, height as usize, WINDOW_RADIUS, SIGMA);
        let mu_y = gaussian_blur_valid(&y, width as usize, height as usize, WINDOW_RADIUS, SIGMA);
        let m_xx = gaussian_blur_valid(
            &multiply(&x, &x),
            width as usize,
            height as usize,
            WINDOW_RADIUS,
            SIGMA,
        );
        let m_yy = gaussian_blur_valid(
            &multiply(&y, &y),
            width as usize,
            height as usize,
            WINDOW_RADIUS,
            SIGMA,
        );
        let m_xy = gaussian_blur_valid(
            &multiply(&x, &y),
            width as usize,
            height as usize,
            WINDOW_RADIUS,
            SIGMA,
        );

        // 逐像素 SSIM 图的均值；均值域只含窗口完整覆盖的像素（valid）。
        let mut ssim_map_sum = 0.0_f64;
        for i in 0..mu_x.len() {
            let mu_x = mu_x[i];
            let mu_y = mu_y[i];
            let sigma_x = m_xx[i] - mu_x * mu_x;
            let sigma_y = m_yy[i] - mu_y * mu_y;
            let sigma_xy = m_xy[i] - mu_x * mu_y;
            let numerator = (2.0 * mu_x * mu_y + c1) * (2.0 * sigma_xy + c2);
            let denominator = (mu_x * mu_x + mu_y * mu_y + c1) * (sigma_x + sigma_y + c2);
            ssim_map_sum += numerator / denominator;
        }
        channel_ssim_sum += ssim_map_sum / mu_x.len() as f64;
    }
    channel_ssim_sum / channel_count as f64
}

fn multiply(a: &[f64], b: &[f64]) -> Vec<f64> {
    a.iter().zip(b).map(|(a, b)| a * b).collect()
}

/// 可分离高斯模糊，valid 模式：只输出窗口完整覆盖的位置，
/// 输出尺寸为 (width-2*radius) x (height-2*radius)，行优先。
fn gaussian_blur_valid(
    plane: &[f64],
    width: usize,
    height: usize,
    radius: usize,
    sigma: f64,
) -> Vec<f64> {
    let kernel = gaussian_kernel(radius, sigma);
    let horizontal = convolve_axis_valid(plane, width, height, &kernel, true);
    convolve_axis_valid(&horizontal, width - 2 * radius, height, &kernel, false)
}

/// 归一化的 1D 高斯核，长度 2*radius+1。
fn gaussian_kernel(radius: usize, sigma: f64) -> Vec<f64> {
    let mut kernel: Vec<f64> = (0..=2 * radius)
        .map(|i| {
            let offset = i as f64 - radius as f64;
            (-(offset * offset) / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = kernel.iter().sum();
    for weight in &mut kernel {
        *weight /= sum;
    }
    kernel
}

/// 沿单一轴做一维 valid 卷积：horizontal=true 时沿 x 轴（输出宽 width-2*radius），
/// 否则沿 y 轴（输出高 height-2*radius）；窗口越界的位置不产出。
fn convolve_axis_valid(
    plane: &[f64],
    width: usize,
    height: usize,
    kernel: &[f64],
    horizontal: bool,
) -> Vec<f64> {
    let radius = kernel.len() / 2;
    let (out_width, out_height) = if horizontal {
        (width - 2 * radius, height)
    } else {
        (width, height - 2 * radius)
    };
    let mut output = vec![0.0_f64; out_width * out_height];
    for y in 0..out_height {
        for x in 0..out_width {
            let mut sum = 0.0_f64;
            for (k, weight) in kernel.iter().enumerate() {
                // 输出位置 (x, y) 对应窗口中心 (x + radius, y + radius)，
                // 窗口第 k 个采样点即中心加偏移；valid 模式下窗口完整落在图内。
                let (sx, sy) = if horizontal { (x + k, y) } else { (x, y + k) };
                sum += weight * plane[sy * width + sx];
            }
            output[y * out_width + x] = sum;
        }
    }
    output
}
