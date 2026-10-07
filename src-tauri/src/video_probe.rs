// 视频元信息探测（T15）：逐帧同步对比需要帧率（±1 帧步长）与时长（时间轴），
// 用应用数据目录 tools/ 里的 ffprobe 读取（与 ffmpeg 同一锁定来源，见 ffmpeg_setup.rs）。
// 输出用 default=noprint_wrappers=1 的 key=value 行格式，解析是纯函数，不引 JSON 依赖。

use std::path::Path;

use serde::Serialize;

/// ffprobe 读到的视频流元信息；fps / duration_secs 为 0 表示未知（前端自行降级处理）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_secs: f64,
}

/// 用 ffprobe 读取视频元信息。任何失败都返回面向用户的中文错误（fail-fast，不崩应用）。
pub fn probe(ffprobe: &Path, video: &Path) -> Result<VideoMeta, String> {
    let mut command = std::process::Command::new(ffprobe);
    pixel_arena_core::process::apply_no_window(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate:format=duration",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(video)
        .output()
        .map_err(|err| format!("无法调用 ffprobe: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("读取视频信息失败：{}", last_line(stderr.trim())));
    }
    parse_probe_output(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        "读取视频信息失败：ffprobe 输出缺少画面宽高，文件可能不是有效视频".to_string()
    })
}

/// 解析 ffprobe 的 key=value 行输出（不含节头）。缺 width/height 视为无效；
/// 帧率或时长缺失/无法解析时记 0（前端降级：步进禁用、时间轴回退到播放器时长）。
fn parse_probe_output(stdout: &str) -> Option<VideoMeta> {
    let mut width = None;
    let mut height = None;
    let mut fps = 0.0;
    let mut duration = 0.0;
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "width" => width = value.trim().parse().ok(),
            "height" => height = value.trim().parse().ok(),
            "r_frame_rate" => fps = parse_frame_rate(value.trim()).unwrap_or(0.0),
            "duration" => duration = value.trim().parse().unwrap_or(0.0),
            _ => {}
        }
    }
    Some(VideoMeta {
        width: width?,
        height: height?,
        fps,
        duration_secs: duration,
    })
}

/// 解析 "num/den" 形式的帧率（如 "30/1"、"30000/1001"）；非正数或无法解析返回 None。
fn parse_frame_rate(rate: &str) -> Option<f64> {
    let (num, den) = rate.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if num <= 0.0 || den <= 0.0 {
        return None;
    }
    Some(num / den)
}

/// 取 stderr 最后一个非空行（ffprobe 的错误通常只有一行，如 "No such file or directory"）。
fn last_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("ffprobe 未返回原因")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frame_rate_handles_common_streams() {
        assert_eq!(parse_frame_rate("30/1"), Some(30.0));
        assert!((parse_frame_rate("30000/1001").unwrap() - 29.97).abs() < 0.001);
        assert_eq!(parse_frame_rate("25/1"), Some(25.0));
    }

    #[test]
    fn parse_frame_rate_rejects_invalid_rates() {
        assert_eq!(parse_frame_rate("0/0"), None);
        assert_eq!(parse_frame_rate("0/1"), None);
        assert_eq!(parse_frame_rate("abc/def"), None);
        assert_eq!(parse_frame_rate("30"), None); // 缺分母
        assert_eq!(parse_frame_rate(""), None);
    }

    #[test]
    fn parse_probe_output_reads_kv_lines() {
        // 真实 ffprobe 对仓库视频夹具的输出形状（default=noprint_wrappers=1）
        let stdout = "width=320\nheight=240\nr_frame_rate=30/1\nduration=3.000000\n";
        let meta = parse_probe_output(stdout).unwrap();
        assert_eq!(
            meta,
            VideoMeta { width: 320, height: 240, fps: 30.0, duration_secs: 3.0 }
        );
    }

    #[test]
    fn parse_probe_output_tolerates_missing_optional_fields() {
        // 时长 N/A（个别封装）与缺 r_frame_rate 都不致命，记 0 由前端降级
        let stdout = "width=160\nheight=120\nr_frame_rate=30/1\nduration=N/A\n";
        let meta = parse_probe_output(stdout).unwrap();
        assert_eq!(meta.duration_secs, 0.0);
        let stdout = "width=160\nheight=120\nduration=2.0\n";
        let meta = parse_probe_output(stdout).unwrap();
        assert_eq!(meta.fps, 0.0);
    }

    #[test]
    fn parse_probe_output_requires_frame_dimensions() {
        assert!(parse_probe_output("duration=3.0\n").is_none());
        assert!(parse_probe_output("").is_none());
    }

    /// 真实链路：找得到的 ffprobe（环境变量 → PATH）读仓库视频夹具，全对得上才过；
    /// 找不到 ffprobe 的环境跳过（与核心库 video_scoring 的跳过口径一致）。
    #[test]
    fn probe_reads_core_video_fixture() {
        let Some(ffprobe) = locate_ffprobe() else {
            eprintln!("跳过：环境中没有可用的 ffprobe");
            return;
        };
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/pixel-arena-core/tests/data/video/video-ref-500k.mp4");
        let meta = probe(&ffprobe, &fixture).unwrap();
        assert_eq!((meta.width, meta.height), (320, 240));
        assert!((meta.fps - 30.0).abs() < 0.001, "fps = {}", meta.fps);
        assert!((meta.duration_secs - 3.0).abs() < 0.001, "duration = {}", meta.duration_secs);
    }

    #[test]
    fn probe_reports_missing_file_in_chinese() {
        let Some(ffprobe) = locate_ffprobe() else {
            eprintln!("跳过：环境中没有可用的 ffprobe");
            return;
        };
        let err = probe(&ffprobe, Path::new("/nonexistent/t15-no-such-file.mp4")).unwrap_err();
        assert!(err.starts_with("读取视频信息失败"), "实际错误: {err}");
    }

    /// 与核心库一致的查找顺序：PIXEL_ARENA_FFPROBE 环境变量 → PATH（测试不感知应用目录）。
    fn locate_ffprobe() -> Option<std::path::PathBuf> {
        if let Ok(path) = std::env::var("PIXEL_ARENA_FFPROBE") {
            let path = std::path::PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
        let mut which = std::process::Command::new("which");
        pixel_arena_core::process::apply_no_window(&mut which);
        let from_path = which
            .arg("ffprobe")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
            .filter(|path| path.is_file());
        if from_path.is_some() {
            return from_path;
        }
        // 开发机的应用数据目录（T14 预留的 ffprobe 在这里，PATH 上只有发行版 ffprobe）
        let home = std::env::var("HOME").ok()?;
        let dev_tools = std::path::PathBuf::from(home)
            .join(".local/share/io.github.boxmiao007.pixelarena/tools/ffprobe");
        dev_tools.is_file().then_some(dev_tools)
    }
}
