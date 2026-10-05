// 图片跑分指标：解码（统一 8-bit sRGB）+ PSNR + SSIM + MS-SSIM + Butteraugli + SSIMULACRA2。
// 指标实现的锚点是黄金基准测试（tests/golden_baseline.rs）；PSNR/SSIM 与 ffmpeg 交叉验证过、
// MS-SSIM 与 numpy 定义性参照逐位对齐（scripts/msssim_reference.py）、Butteraugli/SSIMULACRA2
// 与各自 crate 的 C++ 原版对照值对齐（对照表见 pixel-arena-shared/evidence/T04-交叉验证.md）。

use crate::error::CoreError;
use image::{DynamicImage, ImageBuffer, ImageReader, Rgb};
use ssimulacra2::{ColorPrimaries, TransferCharacteristic};
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
    /// MS-SSIM（Wang et al. 2003/2004 多尺度 SSIM）：最多 5 层 2x2 平均下采样，
    /// 权重 [0.0448, 0.2856, 0.3001, 0.2363, 0.1333]，负项按 0 截断，
    /// 三通道各自合成后再算术平均（与单尺度 SSIM 的口径一致）。
    /// 图最小边不足 176px 时按层数公式自动减层（取权重表前 m 项），见 `ms_ssim` 函数注释；
    /// 取值范围 [0, 1]，两图完全一致时为 1。
    pub ms_ssim: f64,
    /// Butteraugli 距离分（libjxl 口径，crate `butteraugli` 0.9 默认参数）：
    /// 越小越相似，0 = 完全一致，约 1.0 = 刚好可察觉（JND），> 2 = 明显可见差异。
    pub butteraugli: f64,
    /// SSIMULACRA2 分（crate `ssimulacra2` 0.5，sRGB 8-bit 输入口径）：
    /// 越大越相似，约 100 = 完全一致，0 附近 = 很差，负值 = 极差。
    pub ssimulacra2: f64,
}

/// 对一张原图与一张跑分图计算质量指标（PSNR / SSIM / MS-SSIM / Butteraugli / SSIMULACRA2）。
///
/// 两图统一按 8-bit sRGB 处理（忽略 ICC 配置；含 alpha 的图丢弃 alpha 通道，
/// 这是第一版的已知局限，见规格 Out of Scope「完整 ICC 色彩管理」）。
///
/// # 错误
/// - 文件无法读取或不是受支持的图片格式时返回 [`CoreError::Io`] / [`CoreError::Decode`]；
/// - 两图尺寸不一致时返回 [`CoreError::DimensionMismatch`]；
/// - 任一边长小于 11 像素时返回 [`CoreError::Metric`]（11x11 是 SSIM 系指标的最小窗口，
///   Butteraugli/SSIMULACRA2 各自的 8x8 下限被更严的 11x11 覆盖）。
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
    let (width, height) = reference.dimensions();
    if width < 11 || height < 11 {
        return Err(CoreError::Metric {
            message: format!(
                "图片尺寸 {width}x{height} 过小：SSIM 系指标至少需要 11x11 像素的窗口"
            ),
        });
    }

    Ok(ImageMetrics {
        psnr: psnr(&reference, &distorted),
        ssim: ssim(&reference, &distorted),
        ms_ssim: ms_ssim(&reference, &distorted),
        butteraugli: butteraugli_score(&reference, &distorted),
        ssimulacra2: ssimulacra2_score(&reference, &distorted)?,
    })
}

/// 解码图片并统一转为 8-bit sRGB（灰度复制到三通道，alpha 丢弃）。
///
/// 用内容嗅探（魔数）判断格式，扩展名只作提示：扩展名错误或缺失也能解码。
/// pub(crate)：encode 模块（一站式编码）复用同一套解码口径——喂给编码器的像素
/// 必须与跑分时解码的像素一致，避免两处解码行为漂移。
///
/// T11：AVIF/JPEG XL 是 image crate 不支持的产物格式，按魔数分派到 decode 模块
/// 的专用解码路径（决策 0012）；PNG/JPEG/WebP 仍走下方原路径（黄金基准守护数值不变）。
pub(crate) fn decode_srgb(path: &Path) -> Result<ImageBuffer<Rgb<u8>, Vec<u8>>, CoreError> {
    match crate::decode::sniff_special(path)? {
        Some(crate::decode::SpecialFormat::Jxl) => return crate::decode::decode_jxl(path),
        Some(crate::decode::SpecialFormat::Avif) => return crate::decode::decode_avif(path),
        None => {}
    }
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
    let (width, height) = reference.dimensions();
    let channel_count = 3;
    let mut channel_ssim_sum = 0.0_f64;
    for channel in 0..channel_count {
        let x: Vec<f64> = reference.pixels().map(|p| p[channel] as f64).collect();
        let y: Vec<f64> = distorted.pixels().map(|p| p[channel] as f64).collect();
        let (ssim, _) = ssim_and_cs_channel(&x, &y, width as usize, height as usize);
        channel_ssim_sum += ssim;
    }
    channel_ssim_sum / channel_count as f64
}

/// 单尺度单通道的 (SSIM 均值, CS 均值)。SSIM 是亮度+对比度+结构三项之积的窗均值，
/// CS 是去掉亮度项的后两项之积（MS-SSIM 中间层只需要 CS）。
/// 参数与公式来自 Wang et al. 2004《Image quality assessment: from error
/// visibility to structural similarity》，11x11 高斯窗 sigma=1.5，均值只统计
/// 窗口完整覆盖的像素（valid 模式，论文原始做法）。
/// 注：ffmpeg 的 ssim 滤镜是另一种口径（8x8 均匀窗、稳定项按窗像素数缩放、
/// 窗口沿 4 像素网格步进，见 libavfilter/vf_ssim.c 的 ssim_end1），数值存在
/// 已知的系统性差异，交叉验证时的容差依据见 scripts/ffmpeg_crosscheck.py 头注。
fn ssim_and_cs_channel(x: &[f64], y: &[f64], width: usize, height: usize) -> (f64, f64) {
    const K1: f64 = 0.01;
    const K2: f64 = 0.03;
    const MAX_VALUE: f64 = 255.0;
    const WINDOW_RADIUS: usize = 5;
    const SIGMA: f64 = 1.5;
    let c1 = (K1 * MAX_VALUE) * (K1 * MAX_VALUE);
    let c2 = (K2 * MAX_VALUE) * (K2 * MAX_VALUE);

    let mu_x = gaussian_blur_valid(x, width, height, WINDOW_RADIUS, SIGMA);
    let mu_y = gaussian_blur_valid(y, width, height, WINDOW_RADIUS, SIGMA);
    let m_xx = gaussian_blur_valid(&multiply(x, x), width, height, WINDOW_RADIUS, SIGMA);
    let m_yy = gaussian_blur_valid(&multiply(y, y), width, height, WINDOW_RADIUS, SIGMA);
    let m_xy = gaussian_blur_valid(&multiply(x, y), width, height, WINDOW_RADIUS, SIGMA);

    // 逐像素 SSIM / CS 图的均值；均值域只含窗口完整覆盖的像素（valid）。
    let mut ssim_map_sum = 0.0_f64;
    let mut cs_map_sum = 0.0_f64;
    for i in 0..mu_x.len() {
        let mu_x = mu_x[i];
        let mu_y = mu_y[i];
        let sigma_x = m_xx[i] - mu_x * mu_x;
        let sigma_y = m_yy[i] - mu_y * mu_y;
        let sigma_xy = m_xy[i] - mu_x * mu_y;
        let cs = (2.0 * sigma_xy + c2) / (sigma_x + sigma_y + c2);
        let luminance = (2.0 * mu_x * mu_y + c1) / (mu_x * mu_x + mu_y * mu_y + c1);
        ssim_map_sum += luminance * cs;
        cs_map_sum += cs;
    }
    let count = mu_x.len() as f64;
    (ssim_map_sum / count, cs_map_sum / count)
}

/// MS-SSIM（Wang et al. 2003《Multi-scale structural similarity for image quality
/// assessment》；权重取自 TIP 2004 期刊版的心理测量拟合值）：
/// - 最多 5 层，每层先用 2x2 平均滤波下采样（不重叠块取均值，奇数边丢弃末行/列），
///   再在原分辨率层计算；
/// - 第 1..m-1 层取 CS 项均值，第 m 层取完整 SSIM 均值，总分 = Π 项^权重；
/// - 三通道各自合成 MS-SSIM 后取算术平均（与单尺度 SSIM 的三通道平均口径一致）；
/// - 层数 m = min(5, 1 + floor(log2(最小边/11)))：图太小时从粗到细截断（缺的是更粗的层），
///   用权重表前 m 项、不归一化——这是本项目对小图的明确约定，参照实现见
///   scripts/msssim_reference.py（两侧逐位对齐）；
/// - 负的 CS / SSIM 项按 0 截断再取幂，避免负数的分数次幂产生 NaN（与 TensorFlow 同策略）。
fn ms_ssim(
    reference: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    distorted: &ImageBuffer<Rgb<u8>, Vec<u8>>,
) -> f64 {
    const MAX_SCALES: usize = 5;
    const WINDOW: usize = 11; // 与单尺度 SSIM 的 11x11 窗一致
    const WEIGHTS: [f64; MAX_SCALES] = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
    const CHANNEL_COUNT: usize = 3;

    let (width, height) = reference.dimensions();
    let min_side = width.min(height) as f64;
    // score_images 已把最小边 < 11 的图拦为错误，这里 log2 恒非负。
    let scale_count = (((min_side / WINDOW as f64).log2().floor()) as usize + 1).min(MAX_SCALES);

    let mut channel_sum = 0.0_f64;
    for channel in 0..CHANNEL_COUNT {
        let mut x_plane: Vec<f64> = reference.pixels().map(|p| p[channel] as f64).collect();
        let mut y_plane: Vec<f64> = distorted.pixels().map(|p| p[channel] as f64).collect();
        let mut plane_width = width as usize;
        let mut plane_height = height as usize;

        // 每层记录 (项, 权重下标)；中间层是 CS 均值，最深层是完整 SSIM 均值。
        let mut channel_result = 1.0_f64;
        for level in 0..scale_count {
            let (ssim, cs) =
                ssim_and_cs_channel(&x_plane, &y_plane, plane_width, plane_height);
            let term = if level == scale_count - 1 { ssim } else { cs };
            channel_result *= term.max(0.0).powf(WEIGHTS[level]);
            if level < scale_count - 1 {
                let (down_x, _, _) = downsample_2x2(&x_plane, plane_width, plane_height);
                let (down_y, _, _) = downsample_2x2(&y_plane, plane_width, plane_height);
                x_plane = down_x;
                y_plane = down_y;
                plane_width /= 2;
                plane_height /= 2;
            }
        }
        channel_sum += channel_result;
    }
    channel_sum / CHANNEL_COUNT as f64
}

/// 2x2 平均下采样：不重叠块取均值，奇数尺寸丢弃末行/末列（Wang 2003 的下采样约定）。
fn downsample_2x2(plane: &[f64], width: usize, height: usize) -> (Vec<f64>, usize, usize) {
    let out_width = width / 2;
    let out_height = height / 2;
    let mut output = vec![0.0_f64; out_width * out_height];
    for y in 0..out_height {
        for x in 0..out_width {
            let sum = plane[(2 * y) * width + 2 * x]
                + plane[(2 * y) * width + 2 * x + 1]
                + plane[(2 * y + 1) * width + 2 * x]
                + plane[(2 * y + 1) * width + 2 * x + 1];
            output[y * out_width + x] = sum / 4.0;
        }
    }
    (output, out_width, out_height)
}

/// Butteraugli 距离分：crate `butteraugli`（libjxl C++ 原版的纯 Rust 移植，自带
/// C++ 对照回归测试）默认参数、8-bit sRGB 直接输入。返回 distmap 分数：
/// 0 = 完全一致，约 1.0 = 刚好可察觉（JND），越大差异越明显。
fn butteraugli_score(
    reference: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    distorted: &ImageBuffer<Rgb<u8>, Vec<u8>>,
) -> f64 {
    let to_pixels =
        |img: &ImageBuffer<Rgb<u8>, Vec<u8>>| -> Vec<rgb::RGB8> {
            img.pixels()
                .map(|p| rgb::RGB8::new(p[0], p[1], p[2]))
                .collect()
        };
    let (width, height) = reference.dimensions();
    let reference = imgref::Img::new(to_pixels(reference), width as usize, height as usize);
    let distorted = imgref::Img::new(to_pixels(distorted), width as usize, height as usize);
    let result = butteraugli::butteraugli(
        reference.as_ref(),
        distorted.as_ref(),
        &butteraugli::ButteraugliParams::default(),
    )
    // 尺寸已在 score_images 前置校验（>= 11x11，高于 butteraugli 的 8x8 下限），
    // 剩余失败路径只有内存分配异常，按不可达处理。
    .expect("butteraugli 计算不应失败：尺寸已前置校验");
    result.score as f64
}

/// SSIMULACRA2 分：crate `ssimulacra2`（rust-av 维护的移植）。8-bit sRGB 输入
/// 归一到 [0,1] 后按 sRGB 传递函数 / BT.709 基色声明（与该 crate 官方二进制
/// ssimulacra2_rs 的静态图路径完全一致），由库内部转线性 RGB 与 XYB。
/// 返回分数：约 100 = 完全一致，越大越好，可为负。
fn ssimulacra2_score(
    reference: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    distorted: &ImageBuffer<Rgb<u8>, Vec<u8>>,
) -> Result<f64, CoreError> {
    let to_rgb32f =
        |img: &ImageBuffer<Rgb<u8>, Vec<u8>>| -> Vec<[f32; 3]> {
            img.pixels()
                .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
                .collect()
        };
    let width = reference.width() as usize;
    let height = reference.height() as usize;
    // Rgb::new 只在数据长度 != 宽x高时失败，此处长度由构造保证。
    let to_rgb = |img: &ImageBuffer<Rgb<u8>, Vec<u8>>| {
        ssimulacra2::Rgb::new(
            to_rgb32f(img),
            width,
            height,
            TransferCharacteristic::SRGB,
            ColorPrimaries::BT709,
        )
        .expect("RGB 数据长度由像素缓冲构造保证，Rgb::new 不应失败")
    };
    let score = ssimulacra2::compute_frame_ssimulacra2(to_rgb(reference), to_rgb(distorted))
        .map_err(|error| CoreError::Metric {
            message: format!("SSIMULACRA2 计算失败：{error}"),
        })?;
    Ok(score)
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
