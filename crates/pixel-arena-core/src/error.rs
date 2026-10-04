// 核心库错误类型：错误信息面向用户（简体中文），能定位原因。

use std::fmt;
use std::path::PathBuf;

/// 核心库错误。错误信息为简体中文，上游原因（如解码器报文）保持原文。
#[derive(Debug)]
pub enum CoreError {
    /// 文件不存在或无法读取。
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// 文件不是有效图片，或格式不受支持。
    Decode { path: PathBuf, message: String },
    /// 原图与跑分图尺寸不一致：像素级指标必须逐像素对比，尺寸不同则指标无意义。
    DimensionMismatch {
        reference: (u32, u32),
        distorted: (u32, u32),
    },
    /// 感知指标无法计算：图片尺寸低于指标的最小要求，或指标库内部报错。
    Metric { message: String },
    /// 编码器获取或执行失败：下载/校验/解包失败，或编码器子进程非零退出。
    Encode { message: String },
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Io { path, source } => {
                write!(f, "无法读取图片文件 {}：{source}", path.display())
            }
            CoreError::Decode { path, message } => write!(
                f,
                "无法解码图片 {}：{message}。请确认文件是受支持的格式（PNG/JPEG/WebP）且未损坏。",
                path.display()
            ),
            CoreError::DimensionMismatch { reference, distorted } => write!(
                f,
                "原图与跑分图尺寸不一致：原图 {}x{}，跑分图 {}x{}。跑分图必须与原图同尺寸（被缩放或裁剪过的图无法按像素对比）。",
                reference.0, reference.1, distorted.0, distorted.1
            ),
            CoreError::Metric { message } => {
                write!(f, "无法计算感知指标：{message}")
            }
            CoreError::Encode { message } => {
                write!(f, "编码失败：{message}")
            }
        }
    }
}

impl std::error::Error for CoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CoreError::Io { source, .. } => Some(source),
            CoreError::Decode { .. }
            | CoreError::DimensionMismatch { .. }
            | CoreError::Metric { .. }
            | CoreError::Encode { .. } => None,
        }
    }
}
