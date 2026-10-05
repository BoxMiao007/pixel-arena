// 导出命令实现体的端到端测试（T13）：不经 Tauri 运行时，直接调
// pixel_arena_lib::export_round_file，验证「定位轮 → 核心库序列化 → 写文件」
// 全链路，覆盖 CSV / HTML 两种格式、错误路径与成功路径。
// 序列化内容本身由核心库 report 模块的测试守护，这里钉住命令层的行为。

use pixel_arena_core::workspace::{CandidateImage, CandidateVideo, MetricValue, Workspace};
use std::collections::BTreeMap;

fn candidate(path: &str, bytes: u64, psnr: Option<f64>) -> CandidateImage {
    CandidateImage {
        path: path.to_string(),
        file_size: bytes,
        size_ratio: Some(0.5),
        metrics: psnr.map(|p| {
            BTreeMap::from([
                ("PSNR".to_string(), MetricValue::new(p)),
                ("SSIM".to_string(), MetricValue::new(0.99)),
            ])
        }),
        encoding_params: None,
        error: None,
    }
}

fn video_candidate(path: &str, bytes: u64) -> CandidateVideo {
    CandidateVideo {
        path: path.to_string(),
        file_size: bytes,
        size_ratio: Some(0.4),
        metrics: Some(BTreeMap::from([
            ("VMAF".to_string(), MetricValue::new(94.87)),
            ("PSNR".to_string(), MetricValue::new(38.2)),
            ("SSIM".to_string(), MetricValue::new(0.9926)),
        ])),
        encoding_params: None,
        error: None,
        elapsed_ms: Some(1200),
    }
}

/// 一轮真实形状的评测：一站式阶梯的缩样（JPEG 3 档 + 无损 PNG）+ 视频小节。
/// 路径指向临时目录里的真实文件：数据模型只读文件大小（fs::metadata），不解码内容。
fn workspace_with_round() -> (Workspace, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let file = |name: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, b"placeholder").unwrap();
        path.to_string_lossy().into_owned()
    };
    let reference = file("ref.png");
    let video_reference = file("ref.mp4");

    let mut ws = Workspace::new();
    let group = ws.create_group("验收组").unwrap().id.clone();
    let round = ws.create_round(&group, "验收轮").unwrap().id.clone();
    ws.set_round_reference(&group, &round, &reference).unwrap();
    let candidate_paths: Vec<String> = ["photo-q60.jpg", "photo-q75.jpg", "photo-q90.jpg", "photo-png.png"]
        .iter()
        .map(|name| file(name))
        .collect();
    let borrowed: Vec<&str> = candidate_paths.iter().map(String::as_str).collect();
    ws.add_round_candidates(&group, &round, &borrowed).unwrap();
    let round_ref = ws
        .groups
        .get_mut(0)
        .unwrap()
        .rounds
        .get_mut(0)
        .unwrap();
    for (i, bytes) in [35_586u64, 76_872, 559_699, 999_999].into_iter().enumerate() {
        round_ref.candidates[i].file_size = bytes;
        // 占位文件同大小会把体积比重算成 1.0；这里固定为演示值
        round_ref.candidates[i].size_ratio = Some(0.5);
    }
    round_ref.candidates[0].metrics = Some(BTreeMap::from([
        ("PSNR".to_string(), MetricValue::new(33.12)),
        ("SSIM".to_string(), MetricValue::new(0.6967)),
    ]));
    round_ref.candidates[1].metrics = Some(BTreeMap::from([
        ("PSNR".to_string(), MetricValue::new(33.40)),
        ("SSIM".to_string(), MetricValue::new(0.7127)),
    ]));
    round_ref.candidates[2].metrics = Some(BTreeMap::from([
        ("PSNR".to_string(), MetricValue::new(36.29)),
        ("SSIM".to_string(), MetricValue::new(0.8613)),
    ]));
    // 无损对照组：PSNR = ∞ 哨兵
    round_ref.candidates[3].metrics = Some(BTreeMap::from([
        ("PSNR".to_string(), MetricValue::Inf),
        ("SSIM".to_string(), MetricValue::new(1.0)),
    ]));
    ws.set_round_video_reference(&group, &round, &video_reference).unwrap();
    let video_path = file("dis-150k.mp4");
    ws.add_round_video_candidates(&group, &round, &[&video_path]).unwrap();
    ws.groups[0].rounds[0].video_candidates[0] = video_candidate(&video_path, 27_050);
    (ws, group, round)
}

#[test]
fn export_csv_and_html_write_files_through_command_layer() {
    let (ws, group, round) = workspace_with_round();
    let q60_path = ws.groups[0].rounds[0].candidates[0].path.clone();
    let video_path = ws.groups[0].rounds[0].video_candidates[0].path.clone();
    let dir = tempfile::tempdir().unwrap();

    let csv_path = dir.path().join("验收轮.csv");
    let written = pixel_arena_lib::export_round_file(&ws, &group, &round, "csv", csv_path.to_str().unwrap(), "2026-10-05 14:00:00").unwrap();
    assert_eq!(written, csv_path.to_str().unwrap());
    // 票 18：写出的 CSV 文件以 UTF-8 BOM（EF BB BF）开头，Excel 中文环境直开不乱码
    let csv_bytes = std::fs::read(&csv_path).unwrap();
    assert_eq!(&csv_bytes[..3], &[0xEF, 0xBB, 0xBF], "导出 CSV 前三字节应为 UTF-8 BOM");
    let csv = std::fs::read_to_string(&csv_path).unwrap();
    assert!(csv.contains("# 跑分组：验收组"));
    assert!(csv.contains("# 【图片跑分结果】"));
    let q60 = csv.lines().find(|l| l.contains("photo-q60.jpg")).unwrap();
    assert_eq!(q60, format!("{},,35586,0.500000,33.120000,0.696700,,,,完成", q60_path));
    assert!(csv.contains("# 【视频跑分结果】"));
    let video_row = csv.lines().find(|l| l.contains("dis-150k.mp4")).unwrap();
    assert_eq!(video_row, format!("{},27050,0.400000,94.870000,38.200000,0.992600,完成", video_path));
    assert!(csv.contains("# 【BD-rate 汇总】（参照格式：JPEG）"));

    let html_path = dir.path().join("验收轮.html");
    pixel_arena_lib::export_round_file(&ws, &group, &round, "html", html_path.to_str().unwrap(), "2026-10-05 14:00:00").unwrap();
    let html = std::fs::read_to_string(&html_path).unwrap();
    assert!(html.contains("<!doctype html>"));
    assert!(html.contains("验收轮"));
    assert!(html.contains("BD-rate 汇总"));
    assert!(html.contains("94.87"));
}

#[test]
fn export_rejects_unknown_kind_and_missing_round() {
    let (ws, group, round) = workspace_with_round();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");

    let err = pixel_arena_lib::export_round_file(&ws, &group, &round, "pdf", path.to_str().unwrap(), "t").unwrap_err();
    assert!(err.contains("不支持的导出格式"), "{err}");
    assert!(!path.exists(), "失败时不应留下文件");

    let err = pixel_arena_lib::export_round_file(&ws, &group, "不存在", "csv", path.to_str().unwrap(), "t").unwrap_err();
    assert!(err.contains("评测轮不存在"), "{err}");

    let err = pixel_arena_lib::export_round_file(&ws, "不存在", &round, "csv", path.to_str().unwrap(), "t").unwrap_err();
    assert!(err.contains("跑分组不存在"), "{err}");
}

#[test]
fn export_reports_unwritable_path_in_chinese() {
    let (ws, group, round) = workspace_with_round();
    // 目录不存在 → 写文件失败，中文错误可定位
    let err = pixel_arena_lib::export_round_file(&ws, &group, &round, "csv", "/不存在/目录/out.csv", "t").unwrap_err();
    assert!(err.contains("写入导出文件失败"), "{err}");
}
