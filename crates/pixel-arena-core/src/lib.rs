// 像素竞技场核心库。
// 解码、指标、编码编排等能力按票逐个加入（T01 版本号通路 -> T02 图片指标链路 -> T05 工作区数据模型
// -> T10 一站式编码编排），不预写后续票才用得上的抽象。

mod error;
mod metrics;
pub mod video;

pub use error::CoreError;
pub use metrics::{score_images, ImageMetrics};
pub use video::{score_videos, VideoError, VideoMetrics};

/// 高级创建（T29-3）：自定义参数的合并/冲突判定/命令行拼装与编码执行，以及视频
/// 编码器静态映射规格（决策 D10–D14）。
pub mod advanced;
pub mod bdrate;
pub mod decode;
pub mod encode;
/// 编码阶梯取点（T21）：质量优先/大小优先两套取点逻辑的唯一实现，GUI 与 CLI 共用。
pub mod ladder;
/// 产物命名与输出目录（T29-1，决策 D5–D9）：新命名格式纯函数、冲突去重、
/// 原图旁「Pixel Arena」输出目录，GUI 与 CLI 共用。
pub mod naming;
/// 并行调度（T24）：整轮跑分的并发上限换算与有序调度函数，GUI 与 CLI 共用。
pub mod parallel;
/// 共享的 HTTP 下载与文件哈希（决策 0009/0010）：编码器安装与 ffmpeg 安装同一套网络口径。
pub mod net;
/// 子进程派生的跨平台窗口抑制助手（issue #42）：Windows 上统一加 CREATE_NO_WINDOW，
/// 编码/探测/跑分子进程不再闪 conhost 终端；其余平台 no-op。
pub mod process;
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
