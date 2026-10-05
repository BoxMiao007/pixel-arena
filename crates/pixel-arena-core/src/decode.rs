// AVIF 与 JPEG XL 产物的解码（T11，方案见 docs/decisions.md 0011）。
//
// image crate 0.25 只解 PNG/JPEG/WebP；一站式产物另外两种格式在此按魔数分派：
// - JPEG XL：jxl-oxide 进程内解码（纯 Rust，三端无外部依赖，无需下载任何工具）；
// - AVIF：avifdec 子进程（libavif 工件随 avifenc 一并安装；用环境变量
//   PIXEL_ARENA_AVIFDEC 定位，GUI 由 src-tauri 启动时注入确定性路径，CLI 自行设置）。
//
// 解码口径与 metrics::decode_srgb 一致：统一 8-bit sRGB、alpha 丢弃、忽略 ICC
//（第一版已知局限，见规格 Out of Scope）。

use crate::error::CoreError;
use crate::metrics::decode_srgb;
use image::{ImageBuffer, Rgb};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 需要 image crate 之外解码路径的产物格式。
pub(crate) enum SpecialFormat {
    Jxl,
    Avif,
}

/// 按文件魔数嗅探是否为 AVIF/JXL（PNG/JPEG/WebP 返回 None，走原解码路径）。
/// 文件读不了时返回与原解码路径一致的中文 IO 错误。
pub(crate) fn sniff_special(path: &Path) -> Result<Option<SpecialFormat>, CoreError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut magic = [0u8; 12];
    let read = file.read(&mut magic).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let magic = &magic[..read];

    // JPEG XL：裸码流以 FF 0A 开头；容器以 ISO BMFF 盒「00 00 00 0C 4A 58 4C 20 0D 0A 87 0A」开头
    if magic.starts_with(&[0xFF, 0x0A])
        || magic.starts_with(&[0x00, 0x00, 0x00, 0x0C, b'J', b'X', b'L', b' ', 0x0D, 0x0A, 0x87, 0x0A])
    {
        return Ok(Some(SpecialFormat::Jxl));
    }
    // AVIF：ISO BMFF 容器，major brand 为 avif（静态图）或 avis（图序）
    if magic.len() >= 12
        && &magic[4..8] == b"ftyp"
        && (&magic[8..12] == b"avif" || &magic[8..12] == b"avis")
    {
        return Ok(Some(SpecialFormat::Avif));
    }
    Ok(None)
}

/// JPEG XL → 8-bit sRGB（jxl-oxide 进程内解码，取第一帧）。
pub(crate) fn decode_jxl(path: &Path) -> Result<ImageBuffer<Rgb<u8>, Vec<u8>>, CoreError> {
    let decode_err = |message: String| CoreError::Decode {
        path: path.to_path_buf(),
        message,
    };
    let image = jxl_oxide::JxlImage::open_with_defaults(path)
        .map_err(|err| decode_err(format!("JPEG XL 解码失败：{err}")))?;
    let render = image
        .render_frame(0)
        .map_err(|err| decode_err(format!("JPEG XL 解码失败：{err}")))?;
    let buffer = render.image_all_channels();
    let (width, height, channels) = (buffer.width(), buffer.height(), buffer.channels());
    if width == 0 || height == 0 || channels == 0 {
        return Err(decode_err("JPEG XL 解码结果尺寸为空".to_string()));
    }
    // 样本为 f32（0..1）：灰度复制到三通道，alpha 及额外通道丢弃（与 decode_srgb 口径一致）
    let samples = buffer.buf();
    let to_u8 = |value: f32| (value * 255.0).round().clamp(0.0, 255.0) as u8;
    let mut rgb = Vec::with_capacity(width * height * 3);
    for index in 0..width * height {
        let base = index * channels;
        if channels >= 3 {
            rgb.extend_from_slice(&[
                to_u8(samples[base]),
                to_u8(samples[base + 1]),
                to_u8(samples[base + 2]),
            ]);
        } else {
            let gray = to_u8(samples[base]);
            rgb.extend_from_slice(&[gray, gray, gray]);
        }
    }
    ImageBuffer::from_raw(width as u32, height as u32, rgb)
        .ok_or_else(|| decode_err("JPEG XL 解码结果尺寸不一致".to_string()))
}

/// AVIF → 8-bit sRGB：avifdec 子进程解码为无损 PNG 临时文件，再走统一解码口径读回。
pub(crate) fn decode_avif(path: &Path) -> Result<ImageBuffer<Rgb<u8>, Vec<u8>>, CoreError> {
    let decode_err = |message: String| CoreError::Decode {
        path: path.to_path_buf(),
        message,
    };
    let hint = "请先在一站式模式生成一次 AVIF 产物（会自动安装 avifdec），或设置环境变量 PIXEL_ARENA_AVIFDEC 指向 avifdec 可执行文件";
    let decoder = std::env::var("PIXEL_ARENA_AVIFDEC")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| decode_err(format!("缺少 AVIF 解码工具 avifdec：{hint}")))?;
    if !Path::new(&decoder).is_file() {
        return Err(decode_err(format!("AVIF 解码工具不可用（{decoder} 不存在）：{hint}")));
    }

    // avifdec 按输出扩展名决定容器，必须带 .png 后缀
    let png = tempfile::Builder::new()
        .suffix(".png")
        .tempfile()
        .map_err(|err| decode_err(format!("无法创建 AVIF 解码临时文件：{err}")))?;
    let output = Command::new(&decoder)
        .arg(path)
        .arg(png.path())
        .output()
        .map_err(|err| decode_err(format!("无法启动 AVIF 解码工具 {decoder}：{err}")))?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "信号中断".to_string());
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if stderr.is_empty() { "（无错误输出）".to_string() } else { stderr };
        return Err(decode_err(format!("avifdec 退出码 {code}：{stderr}")));
    }
    if !png.path().is_file() {
        return Err(decode_err("avifdec 正常退出但没有生成解码文件".to_string()));
    }
    // avifdec 输出 PNG：复用统一解码口径读回（临时文件随后自动删除）
    decode_srgb(png.path())
}

/// avifdec 的确定性安装路径（<tools_dir>/libavif/<版本>/avifdec）。
/// 平台没有来源清单时返回 None；是否已安装不影响本函数结果，
/// GUI 在启动时把它注入 PIXEL_ARENA_AVIFDEC，之后安装完成即可直接解码。
pub fn avif_decoder_path(tools_dir: impl AsRef<Path>) -> Option<PathBuf> {
    let source = super::encode::avif_source().ok()?;
    Some(
        tools_dir
            .as_ref()
            .join(&source.name)
            .join(&source.version)
            .join("avifdec"),
    )
}
