// 像素竞技场核心库。
// 解码、指标、编码编排等能力按票逐个加入（T01 版本号通路 -> T02 图片指标链路 -> T05 工作区数据模型
// -> T10 一站式编码编排），不预写后续票才用得上的抽象。

mod error;
mod metrics;
pub mod video;

pub use error::CoreError;
pub use metrics::{score_images, ImageMetrics};
pub use video::{score_videos, VideoError, VideoMetrics};

pub mod encode;
pub mod workspace;

/// 核心库版本号，与 Cargo.toml 的 package.version 保持一致。
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_returns_current_core_version() {
        // 独立事实来源：当前核心库版本就是 0.1.0（与 Cargo.toml 保持一致）。
        assert_eq!(version(), "0.1.0");
    }
}
