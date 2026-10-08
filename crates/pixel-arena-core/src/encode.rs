// 一站式模式编码编排。
//
// T10 第一条竖切片：JPEG × MozJPEG。T11 补全默认编码阶梯（决策 0003）：
// 有损 JPEG/WebP/AVIF/JPEG-XL × 质量 60/75/90 + 无损对照组 PNG/无损 WebP/无损 JXL。
//
// 编码器分发方案（docs/decisions.md 0009 → 0014/T29-4 修订 → 0025 定稿）：权威参考
// 编码器随安装包捆绑（CI 打包前由 scripts/bundle-encoders.* 解到资源目录 encoders/，
// 应用壳把捆绑文件折进 EncoderOverrides；捆绑缺失报错并指引官方发布页），不在运行期
// 下载。核心库侧的「内置」落位为 <tools_dir>/<编码器名>/<版本>/<member>（旧版本
// 自动下载时代的既有安装继续可用）；两处都没有 → 中文报错含官方发布页 URL（单一
// 数据源：EncoderSource.release_page）与「设置页指定外部路径」指引。
// libavif 的 avifdec（产物代片解码）不在此解析：解码侧走 PIXEL_ARENA_AVIFDEC
// 环境变量注入的既有机制，由应用壳/CLI 负责。
//
// 编码链路：image crate 解码原图（与跑分同一套 decode_srgb 口径）→ 按编码器口味写
// 中间临时文件（cjpeg/cwebp/cjxl 吃 P6 PPM，avifenc 吃 PNG）→ 子进程编码 →
// 产物按 T29-1 命名新格式落盘（crates/pixel-arena-core/src/naming.rs：格式、冲突
// 去重与输出目录的单一来源）。AVIF/JXL 产物写完自检解码并旁路一份 PNG 代片供查看器
// 显示（WebView 原生解不了这两种格式，见决策 0012）。
//
// CLI（T12）复用 encode_onestop，无需新逻辑。

use crate::error::CoreError;
use crate::metrics::decode_srgb;
use crate::naming::{product_file_name, unique_file_name, ConflictPolicy, QualitySegment};
use crate::process::apply_no_window;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageBuffer, Rgb};
use std::io::{Read, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 每平台一份的编码器来源条目：编码器名、版本、捆绑/内置落位的可执行文件名、
/// 官方发布页 URL（单一数据源：核心库缺失报错、设置页跳转链接与「关于」库链接
/// 共用）。运行期下载已移除（决策 0025），不再携带下载 URL 与 sha256。
#[derive(Debug, Clone)]
pub struct EncoderSource {
    /// 编码器名（内置落位目录名：tools/<编码器名>/<版本>/）。
    pub name: String,
    /// 编码器版本（内置落位目录名的一部分；设置页版本行与「关于」同源展示）。
    pub version: String,
    /// 可执行文件名（捆绑目录与 tools/ 落位同名；Windows 带 .exe）。
    pub member: String,
    /// 该编码器项目的官方发布页（https）。缺失时的报错指引与设置页链接用它。
    pub release_page: String,
    /// 开源许可证（「关于」页库清单展示，单一数据源）。各库按其锁定版本仓库的
    /// LICENSE 原文核实（2026-10）：MozJPEG 是 libjpeg-turbo 系三重 BSD 风格
    /// （BSD-3-Clause + IJG + zlib）；libwebp / libjxl 为 BSD-3-Clause；
    /// libavif 主协议为 BSD-2-Clause。
    pub license: String,
}

/// 编码器可执行文件路径覆盖（T23 设置中心）：某项为 Some 时一站式编码跳过内置
/// 自动安装、直接用该路径。GUI 从设置文件构造；CLI 用默认值（全空，行为不变）。
/// avifdec（AVIF 产物代片解码）不在此列：解码侧定位走 PIXEL_ARENA_AVIFDEC
/// 环境变量注入的既有机制，由 GUI 壳负责。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EncoderOverrides {
    /// MozJPEG cjpeg（JPEG 有损）。
    pub cjpeg: Option<PathBuf>,
    /// libwebp cwebp（WebP 有损/无损）。
    pub cwebp: Option<PathBuf>,
    /// libavif avifenc（AVIF 有损/无损）。
    pub avifenc: Option<PathBuf>,
    /// libjxl cjxl（JPEG XL 有损/无损）。
    pub cjxl: Option<PathBuf>,
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

    /// 规范格式字符串（parse 的逆映射）：CLI 结果表的 format 列与核心库取点
    /// 返回的 LadderItem.format 都用它，是 IPC/CLI 传入值的单一来源。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
            Self::Avif => "avif",
            Self::Jxl => "jxl",
            Self::Png => "png",
            Self::WebpLossless => "webp-lossless",
            Self::JxlLossless => "jxl-lossless",
        }
    }

    fn is_lossless(self) -> bool {
        matches!(self, Self::Png | Self::WebpLossless | Self::JxlLossless)
    }

    /// 大小优先入口的 fail-fast：无损对照组大小固定、不参与目标大小搜索。
    /// 中文文案的单一来源——核心库探测缝（[`probe_onestop_size`]）与应用壳的
    /// 前置校验（onestop_size_search_impl）共用，保证两处提示一字不差。
    pub fn require_lossy(self) -> Result<(), CoreError> {
        if self.is_lossless() {
            Err(CoreError::Encode {
                message: format!("{} 为无损格式，不参与目标大小搜索", self.display_name()),
            })
        } else {
            Ok(())
        }
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

    /// 一站式产物的编码参数文本（结果表「编码参数」列）：有损为「JPEG q75」式，
    /// 无损组为「PNG 无损」式（外部导入的跑分图无此文本——参数用户自备，工具不知晓）。
    pub fn encoding_params_text(self, quality: Option<u8>) -> String {
        match (self, quality) {
            (format, Some(q)) => format!("{} q{q}", format.display_name()),
            (Self::Png, None) => "PNG 无损".to_string(),
            (Self::WebpLossless, None) => "WebP 无损".to_string(),
            (Self::JxlLossless, None) => "JPEG XL 无损".to_string(),
            // 无损格式不会带质量参数（encode_onestop 已 fail-fast），兜底走显示名
            (format, None) => format.display_name().to_string(),
        }
    }

    /// 产物名里的编码器小写短名（需求 9 裁定：无空格短名，JPEG XL → `jpegxl`）。
    /// 有损与无损对照组同名（无损靠质量段 `lossless` 区分）。
    pub fn encoder_short_name(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Webp | Self::WebpLossless => "webp",
            Self::Avif => "avif",
            Self::Jxl | Self::JxlLossless => "jpegxl",
            Self::Png => "png",
        }
    }

    /// 产物扩展名（与 display_name/短名同源，命名与编码分派不再各写一份）。
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Webp | Self::WebpLossless => "webp",
            Self::Avif => "avif",
            Self::Jxl | Self::JxlLossless => "jxl",
            Self::Png => "png",
        }
    }
}

fn unsupported_platform(encoder: &str) -> CoreError {
    CoreError::Encode {
        message: format!(
            "{os}-{arch} 平台暂无分发的 {encoder} 编码器（清单条目由打包票补齐），请先用外部导入模式",
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
        ),
    }
}

/// 当前平台的 MozJPEG 来源清单。没有分发的平台返回中文错误（清单条目随打包票补齐）。
pub fn mozjpeg_source() -> Result<EncoderSource, CoreError> {
    let release_page = "https://github.com/mozilla/mozjpeg/releases".to_string();
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") | ("windows", "x86_64") | ("darwin", "aarch64") => Ok(EncoderSource {
            name: "mozjpeg".to_string(),
            // 三端工件同源码（4.1.5）同配置（无 SIMD、静态），由 CI 打包脚本
            // bundle-encoders.* 取自 encoders-v1 Release 解进安装包资源目录（决策 0014）。
            version: "4.1.5".to_string(),
            member: if cfg!(windows) { "cjpeg.exe" } else { "cjpeg" }.to_string(),
            license: "BSD-3-Clause（另含 IJG、zlib 条款）".to_string(),
            release_page,
        }),
        (_os, _arch) => Err(unsupported_platform("MozJPEG")),
    }
}

/// 当前平台的 libwebp（cwebp）来源清单：官方预编译静态二进制。
pub fn webp_source() -> Result<EncoderSource, CoreError> {
    let release_page = "https://github.com/webmproject/libwebp/releases".to_string();
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") | ("windows", "x86_64") | ("darwin", "aarch64") => Ok(EncoderSource {
            name: "libwebp".to_string(),
            // macOS 无官方工件（2026-10-07 核实），由 CI macos runner 原生构建；
            // 三端一起由 bundle-encoders.* 打进安装包资源目录（决策 0014）。
            version: "1.6.0".to_string(),
            member: if cfg!(windows) { "cwebp.exe" } else { "cwebp" }.to_string(),
            license: "BSD-3-Clause".to_string(),
            release_page,
        }),
        (_os, _arch) => Err(unsupported_platform("libwebp")),
    }
}

/// 当前平台的 libavif（avifenc + avifdec）来源清单：三端官方 v1.4.2 Release 工件（T28）。
pub fn avif_source() -> Result<EncoderSource, CoreError> {
    let release_page = "https://github.com/AOMediaCodec/libavif/releases".to_string();
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") | ("windows", "x86_64") | ("darwin", "aarch64") => Ok(EncoderSource {
            name: "libavif".to_string(),
            // 官方 v1.4.2 Release 附带预编译工件（libaom 3.14.1 静态链接），
            // 由 bundle-encoders.* 打进安装包资源目录；avifdec 与 avifenc 同包
            //（产物代片解码用，经 PIXEL_ARENA_AVIFDEC 注入解码链）。
            version: "1.4.2".to_string(),
            member: if cfg!(windows) { "avifenc.exe" } else { "avifenc" }.to_string(),
            license: "BSD-2-Clause".to_string(),
            release_page,
        }),
        (_os, _arch) => Err(unsupported_platform("libavif")),
    }
}

/// 当前平台的 libjxl（cjxl）来源清单：官方预编译静态构建。
pub fn jxl_source() -> Result<EncoderSource, CoreError> {
    let release_page = "https://github.com/libjxl/libjxl/releases".to_string();
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") | ("windows", "x86_64") | ("darwin", "aarch64") => Ok(EncoderSource {
            name: "libjxl".to_string(),
            // 锁 0.11.1：之后的版本官方工件改为 .zip/.tar.l 格式（见 T11 笔记）；
            // macOS 无官方工件，由 CI macos runner 原生构建，随安装包捆绑（决策 0014）。
            version: "0.11.1".to_string(),
            member: if cfg!(windows) { "cjxl.exe" } else { "cjxl" }.to_string(),
            license: "BSD-3-Clause".to_string(),
            release_page,
        }),
        (_os, _arch) => Err(unsupported_platform("libjxl")),
    }
}

// ---------- 一站式入口 ----------

/// 一站式质量参数的前置校验（encode_onestop 与 onestop_product_name 共用，
/// 两处口径一字不差）：无损组不接受质量参数，有损组必填 1–100。
fn validate_onestop_quality(format: OnestopFormat, quality: Option<u8>) -> Result<(), CoreError> {
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
    Ok(())
}

/// 一站式产物的目标文件名（T30 询问策略用）：与正式编码同一套命名来源
///（OnestopFormat 短名/扩展名 + [`product_file_name`]），GUI 在写入前据此探测
/// 同名冲突、弹窗让用户拍板。只算名字，不碰编码器、不联网。
pub fn onestop_product_name(
    source: impl AsRef<Path>,
    format: &str,
    quality: Option<u8>,
) -> Result<String, CoreError> {
    let format = OnestopFormat::parse(format)?;
    validate_onestop_quality(format, quality)?;
    let segment = match quality {
        Some(q) => QualitySegment::Lossy(q),
        None if format == OnestopFormat::Png => QualitySegment::None,
        None => QualitySegment::Lossless,
    };
    let stem = file_stem(source.as_ref())?;
    product_file_name(&stem, format.encoder_short_name(), segment, &[], format.extension())
}

/// 一站式入口：按格式把原图编码为一份跑分产物。
///
/// - 有损格式（jpeg/webp/avif/jxl）：quality 必填 1–100，产物名
///   `<原图名>_<编码器小写>_q<质量>.<扩展名>`；
/// - 无损组（png/webp-lossless/jxl-lossless）：quality 必须为 None，产物名
///   `<原图名>_png.png` / `<原图名>_webp_lossless.webp` / `<原图名>_jpegxl_lossless.jxl`；
/// - 编码器按「设置覆盖 > 内置落位」解析，缺失报中文错误并指引官方发布页（决策 0025）；
///   同名冲突按 `conflict` 处理（D9 +
///   T30）：AutoAppend 自动追加 `_1/_2` 不覆盖，Overwrite 用确切名落位覆盖
///  （编码先进产物目录下的暂存子目录完成——暂存内必然无冲突，成功后一次 rename
///   覆盖已有文件；中途失败暂存目录整体丢弃，已有文件不受影响）；
/// - AVIF/JXL 产物写完自检可解码，并旁路一份 PNG 代片 `<产物>.png` 供查看器显示。
pub fn encode_onestop(
    source: impl AsRef<Path>,
    format: &str,
    quality: Option<u8>,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
    overrides: &EncoderOverrides,
    conflict: ConflictPolicy,
) -> Result<PathBuf, CoreError> {
    let format = OnestopFormat::parse(format)?;
    // 无损组的像素必须逐位一致，质量参数无意义；有损组的质量在启动编码器前 fail-fast 校验
    validate_onestop_quality(format, quality)?;

    let source = source.as_ref();
    let output_dir = output_dir.as_ref();
    let tools_dir = tools_dir.as_ref();

    // T30 覆盖模式：编码在暂存子目录里做（encode_*_using 的 unique_file_name 在
    // 空目录里原样返回确切名），成功后 rename 进产物目录覆盖已有同名文件。
    // tempdir_in 保证暂存与最终落位同一文件系统（rename 原子生效）。
    let scratch = match conflict {
        ConflictPolicy::AutoAppend => None,
        ConflictPolicy::Overwrite => {
            std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
                message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
            })?;
            Some(tempfile::tempdir_in(output_dir).map_err(|err| CoreError::Encode {
                message: format!("无法创建编码暂存目录（覆盖模式）：{err}"),
            })?)
        }
    };
    let encode_dir: &Path = scratch.as_ref().map(|dir| dir.path()).unwrap_or(output_dir);

    // 编码器解析与探测共用一份「格式 → 编码器」分派（resolve_onestop_encoder），
    // 保证设置中心覆盖同时作用于正式产物与大小优先探测
    let product = match format {
        OnestopFormat::Png => encode_png_product(source, encode_dir),
        _ => {
            let encoder = resolve_onestop_encoder(format, tools_dir, overrides)?
                .expect("无损 PNG 已在上方分支处理");
            match format {
                OnestopFormat::Jpeg => {
                    encode_jpeg_using(encoder, source, quality.expect("上方已校验"), encode_dir)
                }
                OnestopFormat::Webp | OnestopFormat::WebpLossless => {
                    encode_webp_using(encoder, source, quality, encode_dir)
                }
                OnestopFormat::Avif => encode_avif_using(&encoder, source, quality, encode_dir),
                OnestopFormat::Jxl | OnestopFormat::JxlLossless => {
                    encode_jxl_using(encoder, source, quality, encode_dir)
                }
                OnestopFormat::Png => unreachable!("外层分支已处理"),
            }
        }
    }?;

    // 覆盖模式落位：暂存产物 rename 到确切目标名（三端 rename 均替换已有文件；
    // 大小写仅差异的名字在 Linux 上会并存，见 ADR 0023 口径说明）
    let product = match scratch {
        None => product,
        Some(_) => {
            let dest = output_dir.join(product.file_name().expect("暂存产物必有文件名"));
            std::fs::rename(&product, &dest).map_err(|err| CoreError::Encode {
                message: format!("无法覆盖保存产物 {}：{err}", dest.display()),
            })?;
            dest
        }
    };

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

/// 按格式解析一站式编码所用的编码器可执行文件：设置中心覆盖优先（应用壳已把安装包
/// 捆绑文件折进覆盖），缺省回落核心库内置落位 `<tools_dir>/<名>/<版本>/<member>`。
/// [`encode_onestop`]（正式产物）与 [`probe_onestop_size`]（大小优先探测）共用同一份
/// 「格式 → 编码器」分派，保证「搜出的大小」与「真实产物」出自同一个编码器（探测旁路
/// 设置中心覆盖曾是缺陷：搜索结果与最终产物可能不一致）。
/// 无损 PNG 为进程内编码、无外部二进制，返回 `None`（两个调用方各自处理）。
pub(crate) fn resolve_onestop_encoder(
    format: OnestopFormat,
    tools_dir: &Path,
    overrides: &EncoderOverrides,
) -> Result<Option<PathBuf>, CoreError> {
    let (over, source): (Option<&Path>, EncoderSource) = match format {
        OnestopFormat::Jpeg => (overrides.cjpeg.as_deref(), mozjpeg_source()?),
        OnestopFormat::Webp | OnestopFormat::WebpLossless => {
            (overrides.cwebp.as_deref(), webp_source()?)
        }
        // libavif 的 avifdec（产物代片解码）不在此解析：解码侧走 PIXEL_ARENA_AVIFDEC
        // 环境变量注入的既有机制，编码侧只需 avifenc。
        OnestopFormat::Avif => (overrides.avifenc.as_deref(), avif_source()?),
        OnestopFormat::Jxl | OnestopFormat::JxlLossless => {
            (overrides.cjxl.as_deref(), jxl_source()?)
        }
        OnestopFormat::Png => return Ok(None),
    };
    resolve_encoder(over, &source, tools_dir).map(Some)
}

/// 大小优先搜索的探测缝（T21）：把原图按格式 + 质量编码到 scratch_dir，返回产物字节数。
///
/// 探测只关心大小，不走 encode_onestop 的代片旁路（探测产物即弃；正式产物仍走
/// encode_onestop 保留「产物可解码」自检）。编码器解析与 encode_onestop 共用
/// [`resolve_onestop_encoder`]：设置中心的编码器路径覆盖同样作用于探测，保证
/// 大小优先搜出的质量点在正式生成时由同一编码器复现。搜索逻辑见 ladder::size_search
///（纯函数，本函数是其「质量 → 实际大小」回调的现成实现）。
pub fn probe_onestop_size(
    source: impl AsRef<Path>,
    format: OnestopFormat,
    quality: u8,
    scratch_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
    overrides: &EncoderOverrides,
) -> Result<u64, CoreError> {
    let source = source.as_ref();
    let scratch_dir = scratch_dir.as_ref();
    let tools_dir = tools_dir.as_ref();
    // 无损对照组不参与搜索：文案单一来源见 OnestopFormat::require_lossy
    format.require_lossy()?;
    let encoder = resolve_onestop_encoder(format, tools_dir, overrides)?
        .expect("无损格式已被 require_lossy 拒绝");
    let product = match format {
        OnestopFormat::Jpeg => encode_jpeg_using(encoder, source, quality, scratch_dir)?,
        OnestopFormat::Webp => encode_webp_using(encoder, source, Some(quality), scratch_dir)?,
        OnestopFormat::Avif => encode_avif_using(&encoder, source, Some(quality), scratch_dir)?,
        OnestopFormat::Jxl => encode_jxl_using(encoder, source, Some(quality), scratch_dir)?,
        _ => unreachable!("无损格式已被 require_lossy 拒绝"),
    };
    std::fs::metadata(&product)
        .map(|metadata| metadata.len())
        .map_err(|err| CoreError::Encode {
            message: format!("无法读取探测产物 {}：{err}", product.display()),
        })
}

// ---------- 各格式编码（*_using 为可注入缝，测试用） ----------

/// 一站式有损 JPEG：确保 MozJPEG 就位（设置覆盖 > 内置落位，缺失报错指引发布页），
/// 再把原图编码为指定质量。
///
/// 产物写到 `output_dir/<原图名>-q<quality>.jpg`（评测轮工作目录），同名覆盖（幂等）。
pub fn encode_jpeg(
    source: impl AsRef<Path>,
    quality: u8,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    validate_quality(quality)?;
    let encoder = resolve_encoder(None, &mozjpeg_source()?, tools_dir.as_ref())?;
    encode_jpeg_using(encoder, source, quality, output_dir)
}

/// 用指定的编码器可执行文件把原图编码为 JPEG（`encode_jpeg` 的可注入缝，测试用）。
///
/// 产物名新格式（T29-1，决策 D6–D9）：`<原图名>_jpeg_q<quality>.jpg`，同名冲突
/// 自动追加 `_1/_2` 不覆盖。
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
    let name = unique_file_name(
        output_dir,
        &product_file_name(&stem, "jpeg", QualitySegment::Lossy(quality), &[], "jpg")?,
    )?;
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));

    let ppm = write_ppm_temp(&decoded)?;
    let mut command = Command::new(encoder);
    apply_no_window(&mut command);
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
/// cwebp 吃 P6 PPM，输入与跑分同一套解码口径；产物名 `<原图名>_webp_q<质量>.webp`
/// / `<原图名>_webp_lossless.webp`（T29-1 命名新格式，冲突自动 `_1/_2`）。
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

    let segment = match quality {
        Some(q) => QualitySegment::Lossy(q),
        None => QualitySegment::Lossless,
    };
    let name = unique_file_name(
        output_dir,
        &product_file_name(&stem, "webp", segment, &[], "webp")?,
    )?;
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));

    let mut command = Command::new(encoder);
    apply_no_window(&mut command);
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
/// avifenc 只吃 PNG 等容器（不吃 PPM），输入写 PNG 临时文件；产物名
/// `<原图名>_avif_q<质量>.avif` / `<原图名>_avif_lossless.avif`（T29-1 命名新格式）。
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

    let segment = match quality {
        Some(q) => QualitySegment::Lossy(q),
        None => QualitySegment::Lossless,
    };
    let name = unique_file_name(
        output_dir,
        &product_file_name(&stem, "avif", segment, &[], "avif")?,
    )?;
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));

    let mut command = Command::new(encoder);
    apply_no_window(&mut command);
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
/// cjxl 的 100 = 数学无损）。cjxl 吃 PNM 家族，输入写 PPM；产物名
/// `<原图名>_jpegxl_q<质量>.jxl` / `<原图名>_jpegxl_lossless.jxl`（T29-1 命名新格式）。
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

    let (segment, quality_arg) = match quality {
        Some(q) => (QualitySegment::Lossy(q), q.to_string()),
        None => (QualitySegment::Lossless, "100".to_string()),
    };
    let name = unique_file_name(
        output_dir,
        &product_file_name(&stem, "jpegxl", segment, &[], "jxl")?,
    )?;
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));

    let ppm = write_ppm_temp(&decoded)?;
    let command = {
        let mut command = Command::new(encoder);
        apply_no_window(&mut command);
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

/// 无损 PNG 对照组：进程内 image crate 编码，无外部二进制。
/// 产物名 `<原图名>_png.png`（T29-1 命名新格式，PNG 无质量段，冲突自动 `_1/_2`）。
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
    let name = unique_file_name(
        output_dir,
        &product_file_name(&stem, "png", QualitySegment::None, &[], "png")?,
    )?;
    let product = output_dir.join(&name);
    let product_tmp = output_dir.join(format!("{name}.tmp"));
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
pub(crate) fn file_stem(source: &Path) -> Result<String, CoreError> {
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
pub(crate) fn write_ppm_temp(decoded: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<tempfile::NamedTempFile, CoreError> {
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
pub(crate) fn write_png_temp(decoded: &ImageBuffer<Rgb<u8>, Vec<u8>>) -> Result<tempfile::NamedTempFile, CoreError> {
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
pub(crate) fn run_subprocess(
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
pub(crate) fn finish_product(
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

// ---------- 编码器路径覆盖（T23 设置中心） ----------

/// 解析一次编码所用的编码器可执行文件：设置中心覆盖优先，其次内置落位
/// `<tools_dir>/<名>/<版本>/<member>`（应用壳把安装包捆绑文件折进覆盖后，内置落位
/// 只兜旧版本自动下载时代的既有安装；两处都没有 → 中文报错含官方发布页 URL 与
/// 「设置页指定外部路径」指引，决策 0025）。覆盖路径必须指向已存在的文件——假路径
/// 在启动编码器前 fail-fast，报错点名工具、路径与处理办法，用户能直接定位到设置中心去改。
fn resolve_encoder(
    over: Option<&Path>,
    source: &EncoderSource,
    tools_dir: &Path,
) -> Result<PathBuf, CoreError> {
    if let Some(path) = over {
        if !path.is_file() {
            return Err(CoreError::Encode {
                message: format!(
                    "编码器 {} 使用了设置中心指定的自定义路径，但该文件不存在：{}。\
                     请在设置中心更正或清空该路径（清空后恢复内置编码器）",
                    source.member,
                    path.display()
                ),
            });
        }
        return Ok(path.to_path_buf());
    }
    let builtin = tools_dir
        .join(&source.name)
        .join(&source.version)
        .join(&source.member);
    if builtin.is_file() {
        return Ok(builtin);
    }
    Err(CoreError::Encode {
        message: format!(
            "编码器 {member} 的内置文件缺失（可能被安全软件移除，或旧版本安装包未捆绑，运行期不再自动下载）：\
             请从官方发布页下载安装后重试：{page}；或在设置页指定该编码器的外部路径",
            member = source.member,
            page = source.release_page,
        ),
    })
}

// ---------- 压缩包解包（应用壳 ffmpeg 应用内安装复用；编码器运行期下载已移除） ----------

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

    #[test]
    fn encoding_params_text_covers_lossy_and_lossless() {
        assert_eq!(
            OnestopFormat::parse("jpeg").unwrap().encoding_params_text(Some(75)),
            "JPEG q75"
        );
        assert_eq!(
            OnestopFormat::parse("jxl").unwrap().encoding_params_text(Some(60)),
            "JPEG XL q60"
        );
        assert_eq!(
            OnestopFormat::parse("png").unwrap().encoding_params_text(None),
            "PNG 无损"
        );
        assert_eq!(
            OnestopFormat::parse("webp-lossless").unwrap().encoding_params_text(None),
            "WebP 无损"
        );
        assert_eq!(
            OnestopFormat::parse("jxl-lossless").unwrap().encoding_params_text(None),
            "JPEG XL 无损"
        );
    }

    // ---------- 编码器路径解析（T23 覆盖 + T32 缺失指引发布页）----------

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)
    }

    /// 在临时目录按内置落位规则预置一个编码器文件，返回（目录, 文件路径）。
    fn preseed_builtin(source: &EncoderSource) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join(&source.name)
            .join(&source.version)
            .join(&source.member);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"stub").unwrap();
        (dir, path)
    }

    #[test]
    fn resolve_encoder_without_override_uses_builtin_install() {
        let source = mozjpeg_source().unwrap();
        let (dir, path) = preseed_builtin(&source);
        let resolved = resolve_encoder(None, &source, dir.path()).expect("内置落位存在应被采用");
        assert_eq!(resolved, path);
    }

    #[test]
    fn resolve_encoder_with_existing_override_uses_it() {
        let source = mozjpeg_source().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("my-cjpeg");
        std::fs::write(&custom, b"stub").unwrap();
        let resolved =
            resolve_encoder(Some(&custom), &source, dir.path()).expect("存在的覆盖路径应被采用");
        assert_eq!(resolved, custom);
    }

    #[test]
    fn resolve_encoder_with_missing_override_reports_locatable_error() {
        let fake = Path::new("/不存在/fake-cjpeg");
        let source = mozjpeg_source().unwrap();
        let message = resolve_encoder(Some(fake), &source, Path::new("/tmp"))
            .err()
            .expect("假覆盖路径应报错")
            .to_string();
        assert!(message.contains("cjpeg"), "错误应点名编码器: {message}");
        assert!(
            message.contains("/不存在/fake-cjpeg"),
            "错误应包含自定义路径本身: {message}"
        );
        assert!(message.contains("设置"), "错误应提示去设置中心处理: {message}");
    }

    #[test]
    fn missing_builtin_encoder_error_directs_to_release_page_and_override() {
        // 决策 0025：运行期不再自动下载——内置缺失的报错必须中文、含官方发布页 URL
        //（单一数据源 release_page）与「设置页指定外部路径」指引，且不落任何文件
        let source = mozjpeg_source().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let message = resolve_encoder(None, &source, tools.path())
            .err()
            .expect("内置缺失应报错")
            .to_string();
        assert!(message.contains(&source.release_page), "报错应含官方发布页 URL: {message}");
        assert!(message.contains("设置页"), "报错应指引设置页指定外部路径: {message}");
        assert!(message.contains("内置文件缺失"), "报错应说明缺失原因: {message}");
        assert!(
            !tools.path().join(&source.name).exists(),
            "缺失报错不得创建安装目录"
        );
    }

    #[test]
    fn encoder_sources_pin_official_release_pages() {
        // 发布页 URL 的单一数据源钉死（票面 #41 指定的四个官方地址）：
        // 核心库报错、设置页跳转链接与「关于」库链接都从这里读
        let cases = [
            (mozjpeg_source().unwrap(), "https://github.com/mozilla/mozjpeg/releases"),
            (webp_source().unwrap(), "https://github.com/webmproject/libwebp/releases"),
            (avif_source().unwrap(), "https://github.com/AOMediaCodec/libavif/releases"),
            (jxl_source().unwrap(), "https://github.com/libjxl/libjxl/releases"),
        ];
        for (source, page) in cases {
            assert_eq!(source.release_page, page, "{} 的发布页应单一来源", source.name);
            assert!(source.release_page.starts_with("https://"));
        }
    }

    #[test]
    fn encoder_sources_pin_licenses() {
        // 开源协议文本的单一数据源钉死（按各库锁定版本仓库的 LICENSE 原文核实，
        // 2026-10）：「关于」页库清单从这里读。合规信息不许悄悄漂移，改协议
        // 必须连同核实依据一起改。
        let cases = [
            (mozjpeg_source().unwrap(), "BSD-3-Clause（另含 IJG、zlib 条款）"),
            (webp_source().unwrap(), "BSD-3-Clause"),
            (avif_source().unwrap(), "BSD-2-Clause"),
            (jxl_source().unwrap(), "BSD-3-Clause"),
        ];
        for (source, license) in cases {
            assert_eq!(source.license, license, "{} 的协议文本应单一来源", source.name);
        }
    }

    #[cfg(unix)]
    #[test]
    fn onestop_jpeg_uses_overridden_encoder_without_installing_builtin() {
        // 覆盖生效的端到端：自定义桩 cjpeg 被真正执行；tools_dir 为空目录，全程不联网
        let dir = std::env::temp_dir().join(format!("pixel-arena-t23-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("my-cjpeg.sh");
        std::fs::write(&stub, "#!/bin/sh\necho FAKEOVERRIDE > \"$4\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out_dir = dir.join("out");
        let product = encode_onestop(
            fixture("photo-ref.png"),
            "jpeg",
            Some(75),
            &out_dir,
            dir.join("tools"),
            &EncoderOverrides {
                cjpeg: Some(stub),
                ..Default::default()
            },
            ConflictPolicy::AutoAppend,
        )
        .expect("覆盖的编码器应被使用");
        assert_eq!(std::fs::read(&product).unwrap(), b"FAKEOVERRIDE\n");
        assert!(
            !dir.join("tools/mozjpeg").exists(),
            "覆盖生效时内置编码器不应被安装"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn onestop_product_name_matches_actual_encode_product() {
        // 询问策略（T30）的预检名字必须与正式编码落地的名字一字不差：桩 cjpeg 端到端
        // 比对 onestop_product_name 与 encode_onestop 的产物文件名
        let dir = std::env::temp_dir().join(format!("pixel-arena-t30-name-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("my-cjpeg.sh");
        std::fs::write(&stub, "#!/bin/sh\necho FAKEOVERRIDE > \"$4\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out_dir = dir.join("out");
        let expected = onestop_product_name(fixture("photo-ref.png"), "jpeg", Some(75))
            .expect("预检名字应可计算");
        let product = encode_onestop(
            fixture("photo-ref.png"),
            "jpeg",
            Some(75),
            &out_dir,
            dir.join("tools"),
            &EncoderOverrides {
                cjpeg: Some(stub),
                ..Default::default()
            },
            ConflictPolicy::AutoAppend,
        )
        .expect("编码应成功");
        assert_eq!(
            product.file_name().and_then(|n| n.to_str()),
            Some(expected.as_str()),
            "预检名字应与实际产物名一致"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn onestop_overwrite_replaces_existing_product() {
        // 覆盖模式（T30）：同名文件已存在时按确切名落位覆盖，不追加 _1；且原有
        // 内容确实被新产物替换
        let dir = std::env::temp_dir().join(format!("pixel-arena-t30-ov-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("my-cjpeg.sh");
        std::fs::write(&stub, "#!/bin/sh\necho NEWPRODUCT > \"$4\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let expected = onestop_product_name(fixture("photo-ref.png"), "jpeg", Some(75)).unwrap();
        std::fs::write(out_dir.join(&expected), b"OLDPRODUCT").unwrap();

        let product = encode_onestop(
            fixture("photo-ref.png"),
            "jpeg",
            Some(75),
            &out_dir,
            dir.join("tools"),
            &EncoderOverrides {
                cjpeg: Some(stub),
                ..Default::default()
            },
            ConflictPolicy::Overwrite,
        )
        .expect("覆盖编码应成功");
        assert_eq!(product, out_dir.join(&expected), "覆盖模式应使用确切名");
        assert_eq!(
            std::fs::read(&product).unwrap(),
            b"NEWPRODUCT\n",
            "已有同名文件应被新产物覆盖"
        );
        // 不得留下追加序号的副本或暂存残留
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1, "产物目录应只有覆盖后的产物");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn onestop_jpeg_with_missing_override_fails_before_installing_builtin() {
        // 假覆盖路径在编码入口 fail-fast，错误可定位；不触发内置编码器下载
        let message = encode_onestop(
            fixture("photo-ref.png"),
            "jpeg",
            Some(75),
            std::env::temp_dir(),
            std::env::temp_dir(),
            &EncoderOverrides {
                cjpeg: Some(PathBuf::from("/不存在/fake-cjpeg")),
                ..Default::default()
            },
            ConflictPolicy::AutoAppend,
        )
        .err()
        .expect("假覆盖路径应报错")
        .to_string();
        assert!(message.contains("fake-cjpeg"), "错误应包含自定义路径: {message}");
        assert!(message.contains("设置中心"), "错误应指向设置中心: {message}");
    }

    #[cfg(unix)]
    #[test]
    fn probe_onestop_size_uses_overridden_encoder() {
        // 大小优先探测同样吃设置中心覆盖：桩 cjpeg 被真正执行（产物大小 = 桩输出字节数），
        // tools_dir 为空目录全程不联网——探测若绕过覆盖会去安装内置编码器而失败
        let dir = std::env::temp_dir().join(format!("pixel-arena-r2-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("my-cjpeg.sh");
        std::fs::write(&stub, "#!/bin/sh\necho FAKEOVERRIDE > \"$4\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let scratch = dir.join("scratch");
        let bytes = probe_onestop_size(
            fixture("photo-ref.png"),
            OnestopFormat::Jpeg,
            75,
            &scratch,
            dir.join("tools"),
            &EncoderOverrides {
                cjpeg: Some(stub),
                ..Default::default()
            },
        )
        .expect("覆盖的编码器应被探测使用");
        assert_eq!(bytes, b"FAKEOVERRIDE\n".len() as u64, "探测应回传桩产物的大小");
        assert!(
            !dir.join("tools/mozjpeg").exists(),
            "覆盖生效时内置编码器不应被安装"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
