// 视频跑分端到端测试（T14）。
//
// 需要「含 libvmaf 滤镜的 ffmpeg」：按顺序探测
//   1. 环境变量 PIXEL_ARENA_FFMPEG 指向的可执行文件
//   2. 应用数据目录 tools/ 下的静态构建（Linux: $XDG_DATA_HOME|~/.local/share/io.github.boxmiao007.pixelarena/tools/ffmpeg）
//   3. PATH 上的 ffmpeg
// 并用 `-filters` 输出确认真的带 libvmaf；都没有时跳过（带原因），解析层单测不受影响。
//
// 夹具由 scripts/generate_video_fixtures.sh 再生（testsrc 两档码率，秒级时长）；
// 断言用「合理区间」而非精确值：换编码器再生夹具后数值会有小漂移。

use pixel_arena_core::video::{score_videos, VideoError};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

fn data(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/video")
        .join(name)
}

/// 找一个带 libvmaf 的 ffmpeg（进程内只探测一次）。
fn ffmpeg_with_libvmaf() -> &'static Option<PathBuf> {
    static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
    FFMPEG.get_or_init(|| {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(env_path) = std::env::var("PIXEL_ARENA_FFMPEG") {
            candidates.push(PathBuf::from(env_path));
        }
        let data_home = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs_home().map(|h| h.join(".local/share")).unwrap_or_default()
            });
        candidates.push(data_home.join("io.github.boxmiao007.pixelarena/tools/ffmpeg"));
        candidates.push(PathBuf::from("ffmpeg"));
        for candidate in candidates {
            let has_vmaf = Command::new(&candidate)
                .args(["-hide_banner", "-filters"])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).contains("libvmaf"))
                .unwrap_or(false);
            if has_vmaf {
                return Some(candidate);
            }
        }
        None
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

macro_rules! skip_without_ffmpeg {
    () => {
        match ffmpeg_with_libvmaf() {
            Some(path) => path.clone(),
            None => {
                eprintln!("跳过：找不到带 libvmaf 滤镜的 ffmpeg（可设 PIXEL_ARENA_FFMPEG）");
                return;
            }
        }
    };
}

#[test]
fn scores_low_bitrate_candidate_in_reasonable_ranges() {
    let ffmpeg = skip_without_ffmpeg!();
    let metrics = score_videos(&ffmpeg, data("video-ref-500k.mp4"), data("video-dis-150k.mp4"))
        .expect("夹具对应能跑通");
    // 实测锚点（ffmpeg 7.0.2 + 默认 vmaf_v0.6.1）：VMAF≈94.9、PSNR≈41.8、SSIM≈0.993。
    // 区间放宽：夹具再生后编码器差异造成的漂移不应打红测试。
    assert!(
        (30.0..=100.0).contains(&metrics.vmaf),
        "VMAF 应在合理区间，实际 {}",
        metrics.vmaf
    );
    assert!(
        (25.0..=60.0).contains(&metrics.psnr),
        "PSNR 应在合理区间，实际 {}",
        metrics.psnr
    );
    assert!(
        (0.5..=1.0).contains(&metrics.ssim),
        "SSIM 应在合理区间，实际 {}",
        metrics.ssim
    );
}

#[test]
fn identical_video_gives_infinite_psnr_and_perfect_ssim() {
    let ffmpeg = skip_without_ffmpeg!();
    let metrics = score_videos(&ffmpeg, data("video-ref-500k.mp4"), data("video-ref-500k.mp4"))
        .expect("自身对比应能跑通");
    assert_eq!(metrics.psnr, f64::INFINITY, "一致视频 PSNR 应为无穷大");
    assert!((metrics.ssim - 1.0).abs() < 1e-9, "一致视频 SSIM 应为 1.0");
    // libvmaf 整数模式的已知行为：完全一致的两路约 97~98 分，不是 100；只验证量级。
    assert!(
        (90.0..=100.0).contains(&metrics.vmaf),
        "一致视频 VMAF 应接近满分，实际 {}",
        metrics.vmaf
    );
}

#[test]
fn missing_file_fails_fast_without_spawning_ffmpeg() {
    let ffmpeg = skip_without_ffmpeg!();
    let err = score_videos(&ffmpeg, "/不存在/的/视频.mp4", data("video-dis-150k.mp4"))
        .expect_err("原视频不存在应报错");
    assert!(matches!(err, VideoError::NotFound(_)), "实际: {err:?}");
    assert!(err.to_string().contains("/不存在/的/视频.mp4"));
    let err = score_videos(&ffmpeg, data("video-ref-500k.mp4"), "/不存在/的/视频.mp4")
        .expect_err("跑分视频不存在应报错");
    assert!(matches!(err, VideoError::NotFound(_)));
}

#[test]
fn non_video_file_reports_chinese_ffmpeg_failure() {
    let ffmpeg = skip_without_ffmpeg!();
    // PNG 不是视频：ffmpeg 会失败，错误应可读、可定位
    let png = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/photo-ref.png");
    let err = score_videos(&ffmpeg, &png, data("video-dis-150k.mp4")).expect_err("非视频应报错");
    assert!(matches!(err, VideoError::FfmpegFailed(_)), "实际: {err:?}");
    let message = err.to_string();
    assert!(message.contains("ffmpeg"), "错误应带上 ffmpeg 上下文: {message}");
}

#[test]
fn dimension_mismatch_reports_ffmpeg_failure() {
    let ffmpeg = skip_without_ffmpeg!();
    let err = score_videos(&ffmpeg, data("video-ref-500k.mp4"), data("video-small-160x120.mp4"))
        .expect_err("分辨率不一致应报错");
    assert!(matches!(err, VideoError::FfmpegFailed(_)), "实际: {err:?}");
}
