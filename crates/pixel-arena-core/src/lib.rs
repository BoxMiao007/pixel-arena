// 像素竞技场核心库。
// 解码、指标、编码编排等能力按票逐个加入（T01 版本号通路 -> T02 图片指标链路 -> T05 工作区数据模型
// -> T10 一站式编码编排），不预写后续票才用得上的抽象。

mod error;
mod metrics;
pub mod video;

pub use error::CoreError;
pub use metrics::{score_images, ImageMetrics};
pub use video::{score_videos, VideoError, VideoMetrics};

/// AVIF/JPEG XL 产物解码（T11）：GUI 在启动时用它定位 avifdec 并注入环境变量。
pub mod bdrate;
pub mod decode;
pub mod encode;
/// 编码阶梯取点（T21）：质量优先/大小优先两套取点逻辑的唯一实现，GUI 与 CLI 共用。
pub mod ladder;
/// 并行调度（T24）：整轮跑分的并发上限换算与有序调度函数，GUI 与 CLI 共用。
pub mod parallel;
/// 共享的 HTTP 下载与文件哈希（决策 0009/0010）：编码器安装与 ffmpeg 安装同一套网络口径。
pub mod net;
pub mod report;
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
        // 独立事实来源：version() 读 Cargo.toml 的 package version，断言恒等——
        // 版本号升级时本测试不用改。
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
