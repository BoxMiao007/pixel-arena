// 一站式模式编码编排。
//
// T10 第一条竖切片：JPEG × MozJPEG。T11 补全默认编码阶梯（决策 0003）：
// 有损 JPEG/WebP/AVIF/JPEG-XL × 质量 60/75/90 + 无损对照组 PNG/无损 WebP/无损 JXL。
//
// 编码器分发方案（docs/decisions.md 0009）：权威参考编码器不随应用捆绑，首次使用时
// 按「编码器来源清单」（EncoderSource：编码器名 + 版本锁定的 URL + sha256）下载
// 压缩包工件（tar.gz；T16 起官方 Windows zip 亦同）→ sha256 校验（不符报中文错误且不落盘）→ 解包出可执行文件到
// <tools_dir>/<编码器名>/<版本>/<member> → 旁边写 <member>.sha256（解包后文件哈希）。
// 之后每次使用先验本地哈希，损坏/被改自动重下覆盖；哈希一致直接复用、不联网。
// libavif 工件一次下载解出 avifenc + avifdec 两个成员（avifdec 供产物解码用）。
//
// 编码链路：image crate 解码原图（与跑分同一套 decode_srgb 口径）→ 按编码器口味写
// 中间临时文件（cjpeg/cwebp/cjxl 吃 P6 PPM，avifenc 吃 PNG）→ 子进程编码 →
// 产物写到评测轮工作目录。AVIF/JXL 产物写完自检解码并旁路一份 PNG 代片供查看器显示
//（WebView 原生解不了这两种格式，见决策 0012）。
//
// CLI（T12）复用 encode_onestop / install_encoder_members，无需新逻辑。

use crate::error::CoreError;
use crate::metrics::decode_srgb;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageBuffer, Rgb};
use sha2::{Digest, Sha256};
use std::io::{Read, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// 每平台一份的编码器来源条目：编码器名、版本、下载地址、sha256、压缩包内可执行文件名。
#[derive(Debug, Clone)]
pub struct EncoderSource {
    /// 编码器名（安装目录名：tools/<编码器名>/<版本>/）。
    pub name: String,
    /// 编码器版本（安装目录名的一部分）。
    pub version: String,
    /// 压缩包（tar.gz 或 zip）工件下载地址。
    pub url: String,
    /// 工件 sha256（小写十六进制）。升级版本 = 换 URL + 换哈希，一起改。
    pub sha256: String,
    /// 工件内可执行文件的文件名（按文件名匹配，容忍包内多一层目录）。
    pub member: String,
}

/// 一站式支持的编码格式（与前端 src/onestop.ts 的格式清单一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnestopFormat {
    /// 有损 JPEG（MozJPEG cjpeg）。
    Jpeg,
    /// 有损 WebP（libwebp cwebp）。
    Webp,
    /// 有损 AVIF（libavif avifenc，libaom 后端）。
    Avif,
    /// 有损 JPEG XL（libjxl cjxl）。
    Jxl,
    /// 无损 PNG 对照组（进程内 image crate 编码，无外部二进制）。
    Png,
    /// 无损 WebP 对照组（cwebp -lossless，像素逐位一致）。
    WebpLossless,
    /// 无损 JPEG XL 对照组（cjxl -q 100，像素逐位一致）。
    JxlLossless,
}

impl OnestopFormat {
    /// 从 IPC/CLI 传入的格式标识解析；未知格式报中文错误。
    pub fn parse(value: &str) -> Result<Self, CoreError> {
        match value {
            "jpeg" => Ok(Self::Jpeg),
            "webp" => Ok(Self::Webp),
            "avif" => Ok(Self::Avif),
            "jxl" => Ok(Self::Jxl),
            "png" => Ok(Self::Png),
            "webp-lossless" => Ok(Self::WebpLossless),
            "jxl-lossless" => Ok(Self::JxlLossless),
            other => Err(CoreError::Encode {
                message: format!(
                    "不支持的编码格式：{other}（支持 jpeg / webp / avif / jxl / png / webp-lossless / jxl-lossless）"
                ),
            }),
        }
    }

    fn is_lossless(self) -> bool {
        matches!(self, Self::Png | Self::WebpLossless | Self::JxlLossless)
    }

    /// 用户可读的显示名（进度文本、CLI 输出与中文错误提示共用此单一来源；
    /// 前端 src/onestop.ts 的同名映射跨语言无法复用，新增格式需两处同步）。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Webp => "WebP",
            Self::Avif => "AVIF",
            Self::Jxl => "JPEG XL",
            Self::Png => "PNG",
            Self::WebpLossless => "无损 WebP",
            Self::JxlLossless => "无损 JXL",
        }
    }
}

fn unsupported_platform(encoder: &str) -> CoreError {
    CoreError::Encode {
        message: format!(
            "{os}-{arch} 平台暂无分发的 {encoder} 编码器（同一套下载机制，清单条目由打包票补齐），请先用外部导入模式",
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
        ),
    }
}

/// 当前平台的 MozJPEG 来源清单。没有分发的平台返回中文错误（清单条目随打包票补齐）。
pub fn mozjpeg_source() -> Result<EncoderSource, CoreError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(EncoderSource {
            name: "mozjpeg".to_string(),
            version: "4.1.5".to_string(),
            // 工件由本机静态构建（无 SIMD，仅依赖 libc/libm），打包票（T16）把构建搬进 CI
            // 并上传到本项目 GitHub Release；上传前 URL 会 404，测试可用
            // PIXEL_ARENA_ENCODER_MIRROR=<目录URL> 覆盖下载主机（同名工件）。
            url: "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-linux-x86_64.tar.gz"
                .to_string(),
            sha256: "6c2795a90da52d2fe0361fc6580cf4be309bb873797acb967725fe8f98325dee".to_string(),
            member: "cjpeg".to_string(),
        }),
        ("windows", "x86_64") => Ok(EncoderSource {
            name: "mozjpeg".to_string(),
            version: "4.1.5".to_string(),
            // Windows 版与 Linux 版同源码（4.1.5）同配置（无 SIMD、全静态），在 Linux 上
            // 用 mingw-w64 交叉编译（仅依赖 KERNEL32/msvcrt 系统库），工件入库
            // assets/encoders/ 由 CI 原样上传 Release；哈希锚定打包时的工件（T16，决策 0014）。
            url: "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-windows-x86_64.tar.gz"
                .to_string(),
            sha256: "ded15725f25ff321de1cf56b5faa6a0bd6389111ed3a56faf72016aaa5b6713b".to_string(),
            member: "cjpeg.exe".to_string(),
        }),
        (_os, _arch) => Err(unsupported_platform("MozJPEG")),
    }
}

/// 当前平台的 libwebp（cwebp）来源清单：官方预编译静态二进制。
pub fn webp_source() -> Result<EncoderSource, CoreError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(EncoderSource {
            name: "libwebp".to_string(),
            version: "1.6.0".to_string(),
            // libwebp 官方发布的 linux x86-64 静态构建（GitHub Releases 不放工件，
            // 官方下载站在 storage.googleapis.com/downloads.webmproject.org）
            url: "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-linux-x86-64.tar.gz"
                .to_string(),
            sha256: "1c5ffab71efecefa0e3c23516c3a3a1dccb45cc310ae1095c6f14ae268e38067".to_string(),
            member: "cwebp".to_string(),
        }),
        ("windows", "x86_64") => Ok(EncoderSource {
            name: "libwebp".to_string(),
            version: "1.6.0".to_string(),
            // Windows 官方工件只有 zip（T16 起解包机制支持）；cwebp.exe 仅依赖系统 DLL
            //（导入表核对过），包内唯一 DLL（freeglut）只有 vwebp 预览用、与我们无关
            url: "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip"
                .to_string(),
            sha256: "48886f506b21f62e4661f0f4cbfca19800897c385128e8902542d29a950c93f1".to_string(),
            member: "cwebp.exe".to_string(),
        }),
        (_os, _arch) => Err(unsupported_platform("libwebp")),
    }
}

/// 当前平台的 libavif（avifenc + avifdec）来源清单：本机全静态自建（libaom 后端，无 SIMD）。
pub fn avif_source() -> Result<EncoderSource, CoreError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(EncoderSource {
            name: "libavif".to_string(),
            version: "1.4.2".to_string(),
            // 官方只发源码不发二进制：工件由本机用 libaom 3.13.1 + libpng 静态构建后打包
            //（仅依赖 libc/libm）。打包票（T16）把构建搬进 CI 并上传 GitHub Release。
            url: "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/libavif-v1.4.2-linux-x86_64.tar.gz"
                .to_string(),
            sha256: "629b790e08fc93d4e4ce122242662c7b777446517c997ebfc380ca3a28d5668e".to_string(),
            member: "avifenc".to_string(),
        }),
        (_os, _arch) => Err(unsupported_platform("libavif")),
    }
}

/// 当前平台的 libjxl（cjxl）来源清单：官方预编译静态构建。
pub fn jxl_source() -> Result<EncoderSource, CoreError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(EncoderSource {
            name: "libjxl".to_string(),
            version: "0.11.1".to_string(),
            // libjxl 官方 linux 静态构建；锁 0.11.1：之后的版本工件改为 .zip/.tar.lz，
            // 现有「下载 → 校验 → 解包」机制只认 .tar.gz（升级需先扩机制，见 T11 笔记）
            url: "https://github.com/libjxl/libjxl/releases/download/v0.11.1/jxl-linux-x86_64-static-v0.11.1.tar.gz"
                .to_string(),
            sha256: "7ba87d09f220568a7e84c2a62e9fa8be608443930dec10b2799271d4cf032293".to_string(),
            member: "cjxl".to_string(),
        }),
        ("windows", "x86_64") => Ok(EncoderSource {
            name: "libjxl".to_string(),
            version: "0.11.1".to_string(),
            // Windows 官方静态构建只有 zip（vcpkg /MT 产物，静态 CRT 无 VC redist 依赖；
            // 导入表核对过）。50MB 在下载上限内；macOS 官方无工件（暂无分发）。
            url: "https://github.com/libjxl/libjxl/releases/download/v0.11.1/jxl-x64-windows-static.zip"
                .to_string(),
            sha256: "8f53ebce91820c30c9fc9294f06380213c1e2e66b361718880580246b2be008e".to_string(),
            member: "cjxl.exe".to_string(),
        }),
        (_os, _arch) => Err(unsupported_platform("libjxl")),
    }
}

// ---------- 一站式入口 ----------

/// 一站式入口：按格式把原图编码为一份跑分产物。
///
/// - 有损格式（jpeg/webp/avif/jxl）：quality 必填 1–100，产物名 `<原图名>-q<质量>.<扩展名>`；
/// - 无损组（png/webp-lossless/jxl-lossless）：quality 必须为 None，
///   产物名 `<原图名>-png.png` / `<原图名>-webpll.webp` / `<原图名>-jxllossless.jxl`；
/// - 编码器需要时自动下载安装（tools_dir）；产物同名覆盖（重复触发幂等）；
/// - AVIF/JXL 产物写完自检可解码，并旁路一份 PNG 代片 `<产物>.png` 供查看器显示。
pub fn encode_onestop(
    source: impl AsRef<Path>,
    format: &str,
    quality: Option<u8>,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    let format = OnestopFormat::parse(format)?;
    // 无损组的像素必须逐位一致，质量参数无意义；有损组的质量在启动编码器前 fail-fast 校验
    if format.is_lossless() {
        if quality.is_some() {
            return Err(CoreError::Encode {
                message: format!("{} 为无损格式，不接受质量参数", format.display_name()),
            });
        }
    } else {
        validate_quality(quality.ok_or_else(|| CoreError::Encode {
            message: "有损格式需要质量参数（1–100）".to_string(),
        })?)?;
    }

    let source = source.as_ref();
    let output_dir = output_dir.as_ref();
    let tools_dir = tools_dir.as_ref();

    let product = match format {
        OnestopFormat::Jpeg => {
            let encoder = install_encoder(&mozjpeg_source()?, tools_dir)?;
            encode_jpeg_using(encoder, source, quality.expect("上方已校验"), output_dir)
        }
        OnestopFormat::Webp | OnestopFormat::WebpLossless => {
            let encoder = install_encoder(&webp_source()?, tools_dir)?;
            encode_webp_using(encoder, source, quality, output_dir)
        }
        OnestopFormat::Avif => {
            // libavif 工件一次下载解出 avifenc 与 avifdec（后者供产物解码/代片用）
            let installed = install_encoder_members(&avif_source()?, tools_dir, &["avifenc", "avifdec"])?;
            encode_avif_using(&installed[0], source, quality, output_dir)
        }
        OnestopFormat::Jxl | OnestopFormat::JxlLossless => {
            let encoder = install_encoder(&jxl_source()?, tools_dir)?;
            encode_jxl_using(encoder, source, quality, output_dir)
        }
        OnestopFormat::Png => encode_png_product(source, output_dir),
    }?;

    // AVIF/JXL 产物 WebView 原生解不了：自检解码 + 旁路 PNG 代片（决策 0012）。
    // 自检失败视同产物失败：不留不可跑分的产物。
    if matches!(format, OnestopFormat::Avif | OnestopFormat::Jxl | OnestopFormat::JxlLossless) {
        if let Err(err) = write_view_proxy(&product) {
            std::fs::remove_file(&product).ok();
            return Err(err);
        }
    }
    Ok(product)
}

/// 为 AVIF/JXL 产物写查看器代片：把产物解码回 8-bit sRGB（走与跑分同一套解码分派），
/// 编码为无损 PNG 写到 `<产物>.png`。WebView 不支持这两种格式，查看器经代片显示。
pub fn write_view_proxy(product: impl AsRef<Path>) -> Result<PathBuf, CoreError> {
    let product = product.as_ref();
    let decoded = decode_srgb(product)?;

    let name = product
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| CoreError::Encode {
            message: format!("产物路径无法确定文件名：{}", product.display()),
        })?;
    let proxy = product.with_file_name(format!("{name}.png"));
    let proxy_tmp = product.with_file_name(format!("{name}.png.tmp"));
    encode_png_file(&decoded, &proxy_tmp)?;
    std::fs::rename(&proxy_tmp, &proxy).map_err(|err| {
        std::fs::remove_file(&proxy_tmp).ok();
        CoreError::Encode {
            message: format!("无法保存查看器代片 {}：{err}", proxy.display()),
        }
    })?;
    Ok(proxy)
}

// ---------- 各格式编码（*_using 为可注入缝，测试用） ----------

/// 一站式有损 JPEG：确保 MozJPEG 就位（需要时自动下载校验），再把原图编码为指定质量。
///
/// 产物写到 `output_dir/<原图名>-q<quality>.jpg`（评测轮工作目录），同名覆盖（幂等）。
pub fn encode_jpeg(
    source: impl AsRef<Path>,
    quality: u8,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    validate_quality(quality)?;
    let encoder = install_encoder(&mozjpeg_source()?, tools_dir)?;
    encode_jpeg_using(encoder, source, quality, output_dir)
}

/// 用指定的编码器可执行文件把原图编码为 JPEG（`encode_jpeg` 的可注入缝，测试用）。
pub fn encode_jpeg_using(
    encoder: impl AsRef<Path>,
    source: impl AsRef<Path>,
    quality: u8,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    validate_quality(quality)?;
    let encoder = encoder.as_ref();
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();

    // 与跑分完全相同的解码口径：同一张原图，喂给编码器的像素 = 算指标时看到的像素
    let decoded = decode_srgb(source)?;

    let stem = file_stem(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    // 先写临时名再重命名：编码中途失败不会留下半截 .jpg 被当成产物
    let product = output_dir.join(format!("{stem}-q{quality}.jpg"));
    let product_tmp = output_dir.join(format!("{stem}-q{quality}.jpg.tmp"));

    let ppm = write_ppm_temp(&decoded)?;
    let mut command = Command::new(encoder);
    command
        .arg("-quality")
        .arg(quality.to_string())
        .arg("-outfile")
        .arg(&product_tmp)
        .arg(ppm.path());

    let result = run_subprocess(encoder, command, "MozJPEG cjpeg", &product_tmp);
    finish_product(result, &product_tmp, &product)
}

/// 用 cwebp 把原图编码为 WebP：Some(质量) 有损（`-q`），None 无损（`-lossless`）。
/// cwebp 吃 P6 PPM，输入与跑分同一套解码口径；产物名 `-q<质量>.webp` / `-webpll.webp`。
pub fn encode_webp_using(
    encoder: impl AsRef<Path>,
    source: impl AsRef<Path>,
    quality: Option<u8>,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    if let Some(q) = quality {
        validate_quality(q)?;
    }
    let encoder = encoder.as_ref();
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();

    let decoded = decode_srgb(source)?;
    let stem = file_stem(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    let suffix = match quality {
        Some(q) => format!("q{q}"),
        None => "webpll".to_string(),
    };
    let product = output_dir.join(format!("{stem}-{suffix}.webp"));
    let product_tmp = output_dir.join(format!("{stem}-{suffix}.webp.tmp"));

    let mut command = Command::new(encoder);
    command.arg("-quiet");
    match quality {
        Some(q) => command.arg("-q").arg(q.to_string()),
        None => command.arg("-lossless"),
    };
    let ppm = write_ppm_temp(&decoded)?;
    command.arg(ppm.path()).arg("-o").arg(&product_tmp);

    let result = run_subprocess(encoder, command, "libwebp cwebp", &product_tmp);
    finish_product(result, &product_tmp, &product)
}

/// 用 avifenc 把原图编码为 AVIF：Some(质量) 有损（`-q`），None 无损（`--lossless`）。
/// avifenc 只吃 PNG 等容器（不吃 PPM），输入写 PNG 临时文件；产物名 `-q<质量>.avif`。
pub fn encode_avif_using(
    encoder: impl AsRef<Path>,
    source: impl AsRef<Path>,
    quality: Option<u8>,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    if let Some(q) = quality {
        validate_quality(q)?;
    }
    let encoder = encoder.as_ref();
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();

    let decoded = decode_srgb(source)?;
    let stem = file_stem(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    let name = match quality {
        Some(q) => format!("{stem}-q{q}.avif"),
        None => format!("{stem}-aviflossless.avif"),
    };
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));

    let mut command = Command::new(encoder);
    match quality {
        Some(q) => command.arg("-q").arg(q.to_string()),
        None => command.arg("--lossless"),
    };
    let png = write_png_temp(&decoded)?;
    command.arg(png.path()).arg(&product_tmp);

    let result = run_subprocess(encoder, command, "libavif avifenc", &product_tmp);
    finish_product(result, &product_tmp, &product)
}

/// 用 cjxl 把原图编码为 JPEG XL：Some(质量) 有损（`-q <质量>`），None 无损（`-q 100`，
/// cjxl 的 100 = 数学无损）。cjxl 吃 PNM 家族，输入写 PPM；产物名 `-q<质量>.jxl` /
/// `-jxllossless.jxl`。
pub fn encode_jxl_using(
    encoder: impl AsRef<Path>,
    source: impl AsRef<Path>,
    quality: Option<u8>,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    if let Some(q) = quality {
        validate_quality(q)?;
    }
    let encoder = encoder.as_ref();
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();

    let decoded = decode_srgb(source)?;
    let stem = file_stem(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    let (suffix, quality_arg) = match quality {
        Some(q) => (format!("q{q}"), q.to_string()),
        None => ("jxllossless".to_string(), "100".to_string()),
    };
    let product = output_dir.join(format!("{stem}-{suffix}.jxl"));
    let product_tmp = output_dir.join(format!("{stem}-{suffix}.jxl.tmp"));

    let ppm = write_ppm_temp(&decoded)?;
    let command = {
        let mut command = Command::new(encoder);
        command
            .arg("--quiet")
            .arg(ppm.path())
            .arg(&product_tmp)
            .arg("-q")
            .arg(quality_arg);
        command
    };

    let result = run_subprocess(encoder, command, "libjxl cjxl", &product_tmp);
    finish_product(result, &product_tmp, &product)
}

/// 无损 PNG 对照组：进程内 image crate 编码，无外部二进制。产物名 `<原图名>-png.png`。
fn encode_png_product(
    source: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();
    let decoded = decode_srgb(source)?;
    let stem = file_stem(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;
    let product = output_dir.join(format!("{stem}-png.png"));
    let product_tmp = output_dir.join(format!("{stem}-png.png.tmp"));
    let result = encode_png_file(&decoded, &product_tmp);
    finish_product(result, &product_tmp, &product)
}

/// 把 8-bit sRGB 像素编码为 PNG 文件（产物与代片共用）。
fn encode_png_file(decoded: &ImageBuffer<Rgb<u8>, Vec<u8>>, dest: &Path) -> Result<(), CoreError> {
    PngEncoder::new(std::fs::File::create(dest).map_err(|err| CoreError::Encode {
        message: format!("无法创建 PNG 文件 {}：{err}", dest.display()),
    })?)
    .write_image(
        decoded.as_raw(),
        decoded.width(),
        decoded.height(),
        ExtendedColorType::Rgb8,
    )
    .map_err(|err| CoreError::Encode {
        message: format!("无法写入 PNG 文件 {}：{err}", dest.display()),
    })
}

/// 原图文件名去扩展名（产物命名用）。
fn file_stem(source: &Path) -> Result<String, CoreError> {
    source
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .ok_or_else(|| CoreError::Encode {
            message: format!("原图路径无法确定文件名：{}", source.display()),
        })
}

/// 把解码像素包成 P6 PPM 临时文件（cjpeg/cwebp/cjxl 的输入）。
/// 不走 stdin 管道：要同时读子进程的 stderr，大输出下双管道互塞会死锁，临时文件最稳。
fn write_ppm_temp(decoded: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<tempfile::NamedTempFile, CoreError> {
    let (width, height) = decoded.dimensions();
    let ppm = tempfile::NamedTempFile::new().map_err(|err| CoreError::Encode {
        message: format!("无法创建 PPM 临时文件：{err}"),
    })?;
    {
        let mut writer = BufWriter::new(ppm.as_file());
        writer
            .write_all(format!("P6\n{width} {height}\n255\n").as_bytes())
            .and_then(|_| writer.write_all(decoded.as_raw()))
            .map_err(|err| CoreError::Encode {
                message: format!("无法写入 PPM 临时文件：{err}"),
            })?;
        writer.flush().map_err(|err| CoreError::Encode {
            message: format!("无法写入 PPM 临时文件：{err}"),
        })?;
    }
    Ok(ppm)
}

/// 把解码像素包成 PNG 临时文件（avifenc 只吃 PNG，不吃 PPM）。
fn write_png_temp(decoded: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<tempfile::NamedTempFile, CoreError> {
    let png = tempfile::Builder::new()
        .suffix(".png")
        .tempfile()
        .map_err(|err| CoreError::Encode {
            message: format!("无法创建 PNG 临时文件：{err}"),
        })?;
    encode_png_file(decoded, png.path())?;
    Ok(png)
}

/// 跑编码子进程并统一检查退出码与产物存在性。
fn run_subprocess(
    encoder: &Path,
    mut command: Command,
    label: &str,
    product_tmp: &Path,
) -> Result<(), CoreError> {
    let output = command.output().map_err(|err| CoreError::Encode {
        message: format!("无法启动编码器 {}：{err}", encoder.display()),
    })?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "信号中断".to_string());
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if stderr.is_empty() { "（无错误输出）".to_string() } else { stderr };
        return Err(CoreError::Encode {
            message: format!("{label} 退出码 {code}：{stderr}"),
        });
    }
    if !product_tmp.exists() {
        return Err(CoreError::Encode {
            message: format!("编码器正常退出但没有生成产物文件：{}", product_tmp.display()),
        });
    }
    Ok(())
}

/// 编码成功：临时产物改名落位（同名覆盖幂等）；失败：清理半截临时文件。
fn finish_product(
    result: Result<(), CoreError>,
    product_tmp: &Path,
    product: &Path,
) -> Result<PathBuf, CoreError> {
    match result {
        Ok(()) => {
            std::fs::rename(product_tmp, product).map_err(|err| CoreError::Encode {
                message: format!("无法保存编码产物 {}：{err}", product.display()),
            })?;
            Ok(product.to_path_buf())
        }
        Err(err) => {
            std::fs::remove_file(product_tmp).ok(); // 清理可能的半截临时文件
            Err(err)
        }
    }
}

fn validate_quality(quality: u8) -> Result<(), CoreError> {
    if quality == 0 || quality > 100 {
        return Err(CoreError::Encode {
            message: format!("质量 {quality} 无效，有效范围 1–100"),
        });
    }
    Ok(())
}

// ---------- 编码器安装（下载 → sha256 → 解包 → 复用） ----------

/// 确保来源清单指向的编码器已安装在 `<tools_dir>/<编码器名>/<版本>/<member>` 并返回其路径。
///
/// - 本地已有且与安装时写下的 `<member>.sha256` 吻合 → 直接复用（不联网）；
/// - 本地没有、或文件与安装时哈希不符（损坏/被改）→ 重新下载、校验、解包覆盖；
/// - 下载内容与登记 sha256 不符 → 报错且不落盘（杜绝损坏或被篡改的编码器进入执行）。
///
/// 两处哈希职责不同：来源清单的 sha256 锚定「下载的压缩包工件」；
/// 安装目录里的 `<member>.sha256` 锚定「解包后的可执行文件」，供下次启动免下载校验。
pub fn install_encoder(
    encode_source: &EncoderSource,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    let member = encode_source.member.clone();
    Ok(install_encoder_members(encode_source, tools_dir, &[member.as_str()])?.remove(0))
}

/// [`install_encoder`] 的多成员版：libavif 工件一次下载校验，同时解出 avifenc 与 avifdec。
/// 任一成员缺失或校验失败都不落盘（整体失败，不留半套安装）。
pub fn install_encoder_members(
    encode_source: &EncoderSource,
    tools_dir: impl AsRef<Path>,
    members: &[&str],
) -> Result<Vec<PathBuf>, CoreError> {
    let tools_dir = tools_dir.as_ref();
    let dest_dir = tools_dir.join(&encode_source.name).join(&encode_source.version);

    // 复用检查：全部成员就位且哈希吻合 → 不联网
    let mut reused = Vec::with_capacity(members.len());
    let mut all_valid = true;
    for member in members {
        let dest = dest_dir.join(member);
        let sidecar = dest_dir.join(format!("{member}.sha256"));
        let valid = dest.is_file()
            && sidecar.is_file()
            && sha256_file(&dest)? == std::fs::read_to_string(&sidecar).unwrap_or_default().trim();
        if !valid {
            all_valid = false;
            break;
        }
        reused.push(dest);
    }
    if all_valid {
        return Ok(reused);
    }

    std::fs::create_dir_all(&dest_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建编码器目录 {}：{err}", dest_dir.display()),
    })?;

    let url = resolve_url(&encode_source.url);
    let archive = download(&url)?;
    let actual = format!("{:x}", Sha256::digest(&archive));
    if !actual.eq_ignore_ascii_case(&encode_source.sha256) {
        return Err(CoreError::Encode {
            message: format!(
                "下载的编码器 sha256 校验失败（登记 {}，实际 {actual}），已拒绝安装。来源：{url}",
                &encode_source.sha256
            ),
        });
    }

    // 先解到暂存目录再整体搬入：缺成员/半截失败不留下一套坏安装
    let staging = tempfile::tempdir().map_err(|err| CoreError::Encode {
        message: format!("无法创建编码器暂存目录：{err}"),
    })?;
    extract_archive_members(&archive, members, staging.path())?;
    for member in members {
        let staged = staging.path().join(member);
        let dest = dest_dir.join(member);
        std::fs::rename(&staged, &dest).map_err(|err| CoreError::Encode {
            message: format!("无法安装编码器 {}：{err}", dest.display()),
        })?;
        // 记下解包后文件的哈希，作为后续启动免下载校验的锚点
        std::fs::write(dest_dir.join(format!("{member}.sha256")), sha256_file(&dest)?).map_err(
            |err| CoreError::Encode {
                message: format!("无法写入编码器校验文件 {}：{err}", dest.display()),
            },
        )?;
    }
    Ok(members.iter().map(|member| dest_dir.join(member)).collect())
}

/// 下载地址解析：PIXEL_ARENA_ENCODER_MIRROR 环境变量可把下载主机换成镜像目录
/// （拼上原工件文件名），用于离线/内网环境与本票的分发机制测试。
fn resolve_url(url: &str) -> String {
    match std::env::var("PIXEL_ARENA_ENCODER_MIRROR") {
        Ok(mirror) if !mirror.trim().is_empty() => {
            let file = url.rsplit('/').next().unwrap_or(url);
            format!("{}/{}", mirror.trim_end_matches('/'), file)
        }
        _ => url.to_string(),
    }
}

fn download(url: &str) -> Result<Vec<u8>, CoreError> {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(300));
    // 优先复用系统代理（HTTPS_PROXY 等），网络受限环境不配置就走直连
    let proxy_env = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()));
    if let Some(proxy) = proxy_env {
        match ureq::Proxy::new(&proxy) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(_) => return Err(CoreError::Encode {
                message: format!("代理地址无效（{proxy}），无法下载编码器"),
            }),
        }
    }
    let response = builder
        .build()
        .get(url)
        .call()
        .map_err(|err| {
            // ureq 的 Status 错误文本自带完整 URL，与外层重复；只留状态码与简短原因
            let reason = match &err {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                other => other.to_string(),
            };
            CoreError::Encode {
                message: format!("下载编码器失败（{url}）：{reason}"),
            }
        })?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(64 * 1024 * 1024) // 防御：工件上限 64MB，超出即异常
        .read_to_end(&mut bytes)
        .map_err(|err| CoreError::Encode {
            message: format!("下载编码器中断（{url}）：{err}"),
        })?;
    Ok(bytes)
}

/// 从压缩包里按文件名解出全部成员到 dest（暂存目录），缺任一成员即报错。
/// 按 magic number 分流：`PK\x03\x04` 走 zip（T16：Windows 的 libwebp/libjxl 官方
/// 工件只有 zip 格式），其余走 tar.gz（决策 0009 原始格式）。公共导出供应用壳的
/// ffmpeg 安装（ffmpeg_setup.rs）复用同一套「解包 + 权限」逻辑。
pub fn extract_archive_members(
    archive: &[u8],
    members: &[&str],
    dest: &Path,
) -> Result<(), CoreError> {
    if archive.starts_with(b"PK\x03\x04") {
        extract_members_zip(archive, members, dest)
    } else {
        extract_members_tar_gz(archive, members, dest)
    }
}

/// tar.gz 版解包（原 extract_members，行为不变）。
fn extract_members_tar_gz(archive: &[u8], members: &[&str], dest: &Path) -> Result<(), CoreError> {
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let mut found = vec![false; members.len()];
    for entry in tar.entries().map_err(|err| CoreError::Encode {
        message: format!("编码器压缩包无法读取：{err}"),
    })? {
        let mut entry = entry.map_err(|err| CoreError::Encode {
            message: format!("编码器压缩包无法读取：{err}"),
        })?;
        let name = entry.path().map_err(|err| CoreError::Encode {
            message: format!("编码器压缩包无法读取：{err}"),
        })?;
        // 按文件名匹配（清单只登记 member 文件名），容忍包内带一层版本目录
        let Some(index) = members
            .iter()
            .position(|member| name.file_name().map(|n| n == *member).unwrap_or(false))
        else {
            continue;
        };
        let entry_dest = dest.join(members[index]);
        entry.unpack(&entry_dest).map_err(|err| CoreError::Encode {
            message: format!("无法解出编码器 {}：{err}", entry_dest.display()),
        })?;
        mark_executable(&entry_dest);
        found[index] = true;
    }
    report_missing(members, &found)
}

/// zip 版解包。官方 Windows zip 用 `\` 作路径分隔（如 jxl 工件），文件名匹配同时
/// 容忍两种分隔符；目录条目跳过。
fn extract_members_zip(archive: &[u8], members: &[&str], dest: &Path) -> Result<(), CoreError> {
    let reader = std::io::Cursor::new(archive);
    let mut zip = zip::ZipArchive::new(reader).map_err(|err| CoreError::Encode {
        message: format!("编码器压缩包无法读取：{err}"),
    })?;
    let mut found = vec![false; members.len()];
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|err| CoreError::Encode {
            message: format!("编码器压缩包无法读取：{err}"),
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let file_name = name.rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let Some(member_index) = members
            .iter()
            .position(|member| *member == file_name)
        else {
            continue;
        };
        let entry_dest = dest.join(members[member_index]);
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|err| CoreError::Encode {
            message: format!("无法解出编码器 {}：{err}", entry_dest.display()),
        })?;
        std::fs::write(&entry_dest, &content).map_err(|err| CoreError::Encode {
            message: format!("无法解出编码器 {}：{err}", entry_dest.display()),
        })?;
        mark_executable(&entry_dest);
        found[member_index] = true;
    }
    report_missing(members, &found)
}

/// Unix 上补执行权限（tar 一般已保留；zip 官方 Windows 工件没有 Unix 权限位）。
fn mark_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(path).map(|m| m.permissions()) {
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// 任一成员没解出来 → 中文报错点名缺的成员。
fn report_missing(members: &[&str], found: &[bool]) -> Result<(), CoreError> {
    if let Some(missing) = members
        .iter()
        .zip(found)
        .find_map(|(member, ok)| (!ok).then_some(*member))
    {
        return Err(CoreError::Encode {
            message: format!("编码器压缩包里找不到 {missing}，工件与来源清单不符"),
        });
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, CoreError> {
    let mut file = std::fs::File::open(path).map_err(|err| CoreError::Encode {
        message: format!("无法读取已安装的编码器 {}：{err}", path.display()),
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| CoreError::Encode {
            message: format!("无法读取已安装的编码器 {}：{err}", path.display()),
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 显示名是 CLI 进度文本与结果表「编码参数」列的单一来源，文本改动会直接
    /// 变更 CLI 输出，这里钉死（与前端 onestop.ts 的映射需人工同步）。
    #[test]
    fn display_name_pins_cli_visible_texts() {
        let cases = [
            ("jpeg", "JPEG"),
            ("webp", "WebP"),
            ("avif", "AVIF"),
            ("jxl", "JPEG XL"),
            ("png", "PNG"),
            ("webp-lossless", "无损 WebP"),
            ("jxl-lossless", "无损 JXL"),
        ];
        for (raw, expected) in cases {
            assert_eq!(OnestopFormat::parse(raw).unwrap().display_name(), expected);
        }
    }
}
