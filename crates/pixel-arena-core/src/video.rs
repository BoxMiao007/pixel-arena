// 视频跑分（T14）：对（原视频, 跑分视频）对经外部 ffmpeg 计算 VMAF / PSNR / SSIM。
//
// 口径与边界（详见 docs/decisions.md 0010 与 GLOSSARY.md）：
// - VMAF：libvmaf 滤镜，默认内嵌模型 vmaf_v0.6.1（整数模式；两路完全一致时约 97~98，
//   不是 100，属 libvmaf 已知行为）。
// - PSNR：ffmpeg `psnr` 滤镜的 average 口径（与图片侧 PSNR 约定相同）；两路一致时为无穷大。
// - SSIM：ffmpeg `ssim` 滤镜口径——8x8 均匀窗变体，**与图片 SSIM（Wang 2004 标准实现）
//   不可直接比较**，只用于视频对之间的横向排名。
// - 音轨不参与评分（滤镜只接视频流）；两路视频需分辨率/帧率一致，否则 ffmpeg 失败并报中文错误。
//
// 实现说明：三个指标在一次 ffmpeg 进程里算完（split 出三对滤镜分支），结果从 stderr 的
// 三条汇总行解析（`VMAF score:` / `PSNR ... average:` / `SSIM ... All:`），不落 JSON 日志文件。

use std::path::Path;
use std::process::Command;
use thiserror::Error;

/// 一对视频的跑分结果（跑分视频相对原视频）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoMetrics {
    /// VMAF 均值（libvmaf 默认模型，0~100，越高越好）。
    pub vmaf: f64,
    /// PSNR（dB，ffmpeg psnr 滤镜 average 口径；两路一致时为 f64::INFINITY）。
    pub psnr: f64,
    /// SSIM（ffmpeg ssim 滤镜 All 口径，0~1，越高越好；口径与图片 SSIM 不同）。
    pub ssim: f64,
}

#[derive(Debug, Error)]
pub enum VideoError {
    #[error("文件不存在: {0}")]
    NotFound(String),
    #[error("无法启动 ffmpeg: {0}")]
    FfmpegUnavailable(String),
    #[error("ffmpeg 跑分失败（常见原因：不是视频文件、两路视频分辨率或帧率不一致、文件损坏）: {0}")]
    FfmpegFailed(String),
    #[error("无法解析 ffmpeg 输出: {0}")]
    OutputParse(String),
}

/// 滤镜图：两路输入各 split 成三份，分别喂 libvmaf / psnr / ssim，一次进程算完三个指标。
const FILTER_GRAPH: &str = "[0:v]split=3[r1][r2][r3];[1:v]split=3[d1][d2][d3];\
[r1][d1]libvmaf[vmaf];[r2][d2]psnr[psnr];[r3][d3]ssim[ssim]";

/// 对一对视频跑分：`ffmpeg` 为可执行文件路径（须含 libvmaf 滤镜），先做文件存在性检查（fail-fast）。
pub fn score_videos(
    ffmpeg: &Path,
    reference: impl AsRef<Path>,
    distorted: impl AsRef<Path>,
) -> Result<VideoMetrics, VideoError> {
    let reference = reference.as_ref();
    let distorted = distorted.as_ref();
    for path in [reference, distorted] {
        if !path.is_file() {
            return Err(VideoError::NotFound(path.display().to_string()));
        }
    }

    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            &reference.display().to_string(),
            "-i",
            &distorted.display().to_string(),
            "-filter_complex",
            FILTER_GRAPH,
            "-map",
            "[vmaf]",
            "-map",
            "[psnr]",
            "-map",
            "[ssim]",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|err| VideoError::FfmpegUnavailable(err.to_string()))?;

    if !output.status.success() {
        return Err(VideoError::FfmpegFailed(stderr_tail(&output.stderr)));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let vmaf = parse_vmaf(&stderr).ok_or_else(|| missing("VMAF", &stderr))?;
    let psnr = parse_psnr_average(&stderr).ok_or_else(|| missing("PSNR", &stderr))?;
    let ssim = parse_ssim_all(&stderr).ok_or_else(|| missing("SSIM", &stderr))?;
    Ok(VideoMetrics { vmaf, psnr, ssim })
}

fn missing(metric: &str, stderr: &str) -> VideoError {
    VideoError::OutputParse(format!("stderr 里找不到 {metric} 汇总行; 尾部: {stderr_tail}", stderr_tail = stderr_tail(stderr.as_bytes())))
}

/// 取 stderr 末尾若干行拼成可定位的错误上下文（ffmpeg 的报错总在最后）。
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail: Vec<String> = lines
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|l| l.chars().take(200).collect())
        .collect();
    tail.join(" | ")
}

// ---------- stderr 汇总行解析（纯函数，单测用真实录制的输出做夹具） ----------
//
// 三条汇总行形如（ffmpeg 7.0.2 实录）：
//   [Parsed_libvmaf_2 @ 0x...] VMAF score: 94.875247
//   [Parsed_psnr_3 @ 0x...] PSNR y:41.246275 u:42.935967 v:43.375174 average:41.793071 min:... max:...
//   [Parsed_ssim_4 @ 0x...] SSIM Y:0.991470 (20.690270) U:... V:... All:0.992645 (21.334343)

/// 取 `key:` 后面的数值 token（支持 inf），找不到返回 None。
fn value_after(label: &str, text: &str) -> Option<f64> {
    let start = text.rfind(label)? + label.len();
    let rest = &text[start..];
    let token: String = rest
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| !c.is_whitespace() && *c != '(')
        .collect();
    if token == "inf" {
        return Some(f64::INFINITY);
    }
    token.parse::<f64>().ok()
}

/// 从 stderr 解析 VMAF 均值（`VMAF score:` 行；多行时取最后一次）。
pub fn parse_vmaf(stderr: &str) -> Option<f64> {
    value_after("VMAF score:", stderr)
}

/// 从 stderr 解析 PSNR 的 average 值（一致视频输出 `average:inf`，还原为无穷大）。
pub fn parse_psnr_average(stderr: &str) -> Option<f64> {
    value_after("average:", stderr)
}

/// 从 stderr 解析 SSIM 的 All 值。
pub fn parse_ssim_all(stderr: &str) -> Option<f64> {
    value_after("All:", stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 真实录制的 stderr 片段（ffmpeg 7.0.2 静态构建，夹具视频 video-ref-500k vs video-dis-150k）
    const REAL_STDERR: &str = "\
[Parsed_libvmaf_2 @ 0x74c7c80070c0] VMAF score: 94.875247
[Parsed_psnr_3 @ 0x74c7c8007480] PSNR y:41.246275 u:42.935967 v:43.375174 average:41.793071 min:35.880665 max:51.597255
[Parsed_ssim_4 @ 0x74c7c80078c0] SSIM Y:0.991470 (20.690270) U:0.993677 (21.990748) V:0.996317 (24.337552) All:0.992645 (21.334343)";

    // 一致视频的 stderr 片段：PSNR 无穷大、SSIM 1.0
    const IDENTICAL_STDERR: &str = "\
[Parsed_libvmaf_2 @ 0x76dd140067c0] VMAF score: 97.841752
[Parsed_psnr_3 @ 0x76dd14006bc0] PSNR y:inf u:inf v:inf average:inf min:inf max:inf
[Parsed_ssim_4 @ 0x76dd14007000] SSIM Y:1.000000 (inf) U:1.000000 (inf) V:1.000000 (inf) All:1.000000 (inf)";

    #[test]
    fn parses_all_three_metrics_from_real_stderr() {
        let vmaf = parse_vmaf(REAL_STDERR).expect("应解析出 VMAF");
        let psnr = parse_psnr_average(REAL_STDERR).expect("应解析出 PSNR");
        let ssim = parse_ssim_all(REAL_STDERR).expect("应解析出 SSIM");
        assert!((vmaf - 94.875247).abs() < 1e-9);
        assert!((psnr - 41.793071).abs() < 1e-9);
        assert!((ssim - 0.992645).abs() < 1e-9);
    }

    #[test]
    fn parses_infinite_psnr_and_perfect_ssim_from_identical_stderr() {
        let psnr = parse_psnr_average(IDENTICAL_STDERR).expect("应解析出 PSNR");
        let ssim = parse_ssim_all(IDENTICAL_STDERR).expect("应解析出 SSIM");
        assert_eq!(psnr, f64::INFINITY);
        assert!((ssim - 1.0).abs() < 1e-9);
    }

    #[test]
    fn parse_returns_none_on_missing_or_garbage_lines() {
        assert_eq!(parse_vmaf("没有任何汇总行"), None);
        assert_eq!(parse_psnr_average("SSIM All:0.9"), None);
        assert_eq!(parse_ssim_all("PSNR average:41.5"), None);
        assert_eq!(parse_vmaf("VMAF score: 不是数字"), None);
    }

    #[test]
    fn parse_takes_last_occurrence_when_lines_repeat() {
        let twice = "VMAF score: 1.0\nVMAF score: 2.0";
        assert!((parse_vmaf(twice).unwrap() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn stderr_tail_keeps_last_lines_and_truncates() {
        let long = "a".repeat(300);
        let stderr = format!("line1\nline2\n{long}\nConversion failed!");
        let tail = stderr_tail(stderr.as_bytes());
        assert!(tail.contains("line2"), "应保留末尾几行: {tail}");
        assert!(tail.contains("Conversion failed!"));
        assert!(tail.chars().count() < 4 * 200 + 8, "单行应截断");
    }
}
