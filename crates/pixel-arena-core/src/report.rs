// 评测轮结果的导出序列化（T13）：CSV 与自包含 HTML 报告。
// 与 GUI 结果区共用同一份数据源（Round + bdrate::summarize_round），
// 保证「导出内容与界面结果一致」。CSV 口径沿用 T03 的约定：
// RFC 4180 最小转义、inf/nan 哨兵、定点 6 位小数。
//
// CSV 分三节（节标题为 # 注释行）：图片跑分结果 / 视频跑分结果（无视频时省略）/
// BD-rate 汇总。指标列固定为图片五指标（psnr/ssim/ms_ssim/butteraugli/ssimulacra2），
// 旧轮次只跑过 PSNR/SSIM 时缺的列留空。图片节含编码参数列（一站式写入，外部导入
// 为空——参数用户自备，工具不知晓）。

use crate::bdrate::summarize_round;
use crate::workspace::{MetricValue, Round};

/// 图片指标列（固定列名与 T03/T04 的 CSV schema 一致；旧轮次缺的指标留空/显示 —）。
const IMAGE_METRIC_KEYS: [&str; 5] = ["PSNR", "SSIM", "MS-SSIM", "Butteraugli", "SSIMULACRA2"];
/// 视频指标列（T14 口径，顺序与 GUI 一致：VMAF 优先展示）。
const VIDEO_METRIC_KEYS: [&str; 3] = ["VMAF", "PSNR", "SSIM"];

/// RFC 4180 最小转义：字段含 , " 换行 回车 时整体加引号、内部引号翻倍（T03 同款）。
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 指标数值文本（T03 约定）：无穷大 → "inf"、NaN → "nan" 哨兵，其余定点 6 位小数。
fn metric_text(value: f64) -> String {
    if value.is_nan() {
        "nan".to_string()
    } else if value.is_infinite() {
        "inf".to_string()
    } else {
        format!("{value:.6}")
    }
}

/// HTML 转义：& < > " 全部转实体，防路径/名称里的特殊字符破坏文档结构。
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 界面同款文件大小格式（src/main.ts formatSize 的对齐实现）。
fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// 界面同款体积比格式（<1 显百分比，≥1 显倍数）。
fn format_ratio(ratio: f64) -> String {
    if ratio < 1.0 {
        format!("{:.1}%", ratio * 100.0)
    } else {
        format!("×{ratio:.2}")
    }
}

/// 界面同款指标格式（∞ 直接显示；|v|≥10 两位小数，小值四位）。
fn format_metric_html(value: &MetricValue) -> String {
    let v = value.value();
    if value == &MetricValue::Inf {
        "∞".to_string()
    } else if v.abs() >= 10.0 {
        format!("{v:.2}")
    } else {
        format!("{v:.4}")
    }
}

/// 文件名（HTML 报告里原图/跑分图显示名）。
fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// 行状态文案（与 GUI 结果表一致）。
fn status_text(error: &Option<String>, scored: bool) -> String {
    match error {
        Some(err) => format!("失败：{err}"),
        None if !scored => "待跑分".to_string(),
        None => "完成".to_string(),
    }
}

/// 评测轮 BD-rate 口径说明（CSV 与 HTML 报告同一段文案）。
fn bdrate_legend(reference_format: Option<&str>) -> String {
    let reference = reference_format.unwrap_or("无可用参照格式");
    format!(
        "{reference}；画质轴：PSNR；码率轴为文件字节数（同轮同分辨率下与 bpp 口径等价）。BD-rate 为负表示同画质下码率更低。"
    )
}

/// 导出 CSV 文本。分三节：图片跑分结果、视频跑分结果（无视频时省略）、BD-rate 汇总。
/// 开头带 UTF-8 BOM（EF BB BF）：Excel 在中文环境把无 BOM 的 UTF-8 按 ANSI 解析会乱码
/// （票 18），BOM 是 Excel 识别 UTF-8 的依据；LibreOffice 与程序读取均容忍 BOM。
pub fn export_csv(group_name: &str, round: &Round, generated_at: &str) -> String {
    let summary = summarize_round(round);
    let mut lines: Vec<String> = Vec::new();

    lines.push("# 像素竞技场评测报告".to_string());
    lines.push(format!("# 跑分组：{group_name}"));
    lines.push(format!("# 评测轮：{}", round.name));
    lines.push(format!(
        "# 原图：{}",
        round.reference_path.as_deref().unwrap_or("未设置")
    ));
    lines.push(format!("# 生成时间：{generated_at}"));

    lines.push(String::new());
    lines.push("# 【图片跑分结果】".to_string());
    // US22（审查修复 B6）：任一行有备注（大小优先不可达标注）才追加尾随 note 列，
    // 无备注的轮保持既有列序不变（与 GUI 结果表同口径）
    let has_notes = round.candidates.iter().any(|c| c.note.is_some());
    lines.push(format!(
        "candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status{}",
        if has_notes { ",note" } else { "" },
    ));
    for candidate in &round.candidates {
        let metrics = candidate.metrics.as_ref();
        let cell = |key: &str| {
            metrics
                .and_then(|m| m.get(key))
                .map(|v| metric_text(v.value()))
                .unwrap_or_default()
        };
        let ratio = candidate
            .size_ratio
            .map(|r| format!("{r:.6}"))
            .unwrap_or_default();
        let base = format!(
            "{},{},{},{},{},{},{},{},{},{}",
            csv_field(&candidate.path),
            candidate.encoding_params.as_deref().map(csv_field).unwrap_or_default(),
            candidate.file_size,
            ratio,
            cell("PSNR"),
            cell("SSIM"),
            cell("MS-SSIM"),
            cell("Butteraugli"),
            cell("SSIMULACRA2"),
            csv_field(&status_text(&candidate.error, metrics.is_some())),
        );
        if has_notes {
            lines.push(format!(
                "{},{}",
                base,
                candidate.note.as_deref().map(csv_field).unwrap_or_default(),
            ));
        } else {
            lines.push(base);
        }
    }

    if round.video_reference_path.is_some() || !round.video_candidates.is_empty() {
        lines.push(String::new());
        lines.push("# 【视频跑分结果】".to_string());
        lines.push(format!(
            "# 原视频：{}",
            round.video_reference_path.as_deref().unwrap_or("未设置")
        ));
        lines.push("candidate,candidate_bytes,size_ratio,vmaf,psnr,ssim,status".to_string());
        for candidate in &round.video_candidates {
            let metrics = candidate.metrics.as_ref();
            let cell = |key: &str| {
                metrics
                    .and_then(|m| m.get(key))
                    .map(|v| metric_text(v.value()))
                    .unwrap_or_default()
            };
            let ratio = candidate
                .size_ratio
                .map(|r| format!("{r:.6}"))
                .unwrap_or_default();
            lines.push(format!(
                "{},{},{},{},{},{},{}",
                csv_field(&candidate.path),
                candidate.file_size,
                ratio,
                cell("VMAF"),
                cell("PSNR"),
                cell("SSIM"),
                csv_field(&status_text(&candidate.error, metrics.is_some())),
            ));
        }
    }

    lines.push(String::new());
    match &summary.reference_format {
        Some(format) => lines.push(format!("# 【BD-rate 汇总】（参照格式：{format}）")),
        None => lines.push("# 【BD-rate 汇总】（无可用参照格式）".to_string()),
    }
    lines.push("format,bd_rate_percent,point_count,note".to_string());
    for entry in &summary.entries {
        let bd = entry
            .bd_rate_percent
            .map(|v| format!("{v:.6}"))
            .unwrap_or_default();
        let note = entry.note.as_deref().map(csv_field).unwrap_or_default();
        lines.push(format!(
            "{},{},{},{}",
            csv_field(&entry.format),
            bd,
            entry.point_count,
            note
        ));
    }

    // BOM 作为字符串首字符写出即 EF BB BF（票 18：Excel 中文环境直开不乱码）
    let mut csv = String::new();
    csv.push('\u{FEFF}');
    csv.push_str(&lines.join("\n"));
    csv.push('\n');
    csv
}

const REPORT_CSS: &str = r#"
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px auto; max-width: 1100px; color: #1f2328; padding: 0 16px; }
h1 { font-size: 20px; margin-bottom: 4px; }
h2 { font-size: 16px; margin-top: 28px; }
.meta { color: #57606a; font-size: 13px; margin: 4px 0; }
table { border-collapse: collapse; font-size: 13px; width: 100%; margin-top: 8px; }
th, td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; }
th { background: #f6f8fa; }
code { font-size: 12px; color: #57606a; word-break: break-all; }
.status-fail { color: #cf222e; }
"#;

/// 导出自包含 HTML 报告（内联样式、简体中文、不嵌图片正文、附文件路径列）。
pub fn export_html(group_name: &str, round: &Round, generated_at: &str) -> String {
    let summary = summarize_round(round);
    let esc = html_escape;
    let mut html = String::new();

    html.push_str("<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str(&format!("<title>像素竞技场 · {}</title>\n", esc(&round.name)));
    html.push_str("<style>");
    html.push_str(REPORT_CSS);
    html.push_str("</style>\n</head>\n<body>\n");
    html.push_str("<h1>像素竞技场评测报告</h1>\n");
    html.push_str(&format!(
        "<p class=\"meta\">评测轮：{}（跑分组：{}）　生成时间：{}</p>\n",
        esc(&round.name),
        esc(group_name),
        esc(generated_at)
    ));
    html.push_str(&match &round.reference_path {
        Some(path) => format!(
            "<p class=\"meta\">原图：{}（<code>{}</code>）</p>\n",
            esc(&file_name(path)),
            esc(path)
        ),
        None => "<p class=\"meta\">原图：未设置</p>\n".to_string(),
    });

    // 图片跑分结果表（任一行有备注才追加「备注」列，与 GUI 结果表/CSV 同口径）
    let has_notes = round.candidates.iter().any(|c| c.note.is_some());
    html.push_str("<h2>图片跑分结果</h2>\n<table>\n<thead><tr><th>跑分图</th><th>路径</th><th>文件大小</th><th>体积比</th><th>编码参数</th>");
    for key in IMAGE_METRIC_KEYS {
        html.push_str(&format!("<th>{key}</th>"));
    }
    html.push_str("<th>状态</th>");
    if has_notes {
        html.push_str("<th>备注</th>");
    }
    html.push_str("</tr></thead>\n<tbody>\n");
    for candidate in &round.candidates {
        let metrics = candidate.metrics.as_ref();
        html.push_str(&format!(
            "<tr><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td>",
            esc(&file_name(&candidate.path)),
            esc(&candidate.path),
            format_size(candidate.file_size),
            candidate
                .size_ratio
                .map(format_ratio)
                .unwrap_or_else(|| "—".to_string()),
            esc(candidate.encoding_params.as_deref().unwrap_or("—"))
        ));
        for key in IMAGE_METRIC_KEYS {
            let cell = metrics
                .and_then(|m| m.get(key))
                .map(format_metric_html)
                .unwrap_or_else(|| "—".to_string());
            html.push_str(&format!("<td>{cell}</td>"));
        }
        let status = status_text(&candidate.error, metrics.is_some());
        let class = if candidate.error.is_some() {
            " class=\"status-fail\""
        } else {
            ""
        };
        html.push_str(&format!("<td{class}>{}</td>", esc(&status)));
        if has_notes {
            html.push_str(&format!(
                "<td>{}</td>",
                esc(candidate.note.as_deref().unwrap_or(""))
            ));
        }
        html.push_str("</tr>\n");
    }
    html.push_str("</tbody>\n</table>\n");

    // 视频跑分结果（无视频内容的轮次整节省略）
    if round.video_reference_path.is_some() || !round.video_candidates.is_empty() {
        html.push_str("<h2>视频跑分结果</h2>\n");
        html.push_str(&match &round.video_reference_path {
            Some(path) => format!(
                "<p class=\"meta\">原视频：{}（<code>{}</code>）</p>\n",
                esc(&file_name(path)),
                esc(path)
            ),
            None => "<p class=\"meta\">原视频：未设置</p>\n".to_string(),
        });
        html.push_str("<table>\n<thead><tr><th>跑分视频</th><th>路径</th><th>文件大小</th><th>体积比</th>");
        for key in VIDEO_METRIC_KEYS {
            html.push_str(&format!("<th>{key}</th>"));
        }
        html.push_str("<th>状态</th></tr></thead>\n<tbody>\n");
        for candidate in &round.video_candidates {
            let metrics = candidate.metrics.as_ref();
            html.push_str(&format!(
                "<tr><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td>",
                esc(&file_name(&candidate.path)),
                esc(&candidate.path),
                format_size(candidate.file_size),
                candidate
                    .size_ratio
                    .map(format_ratio)
                    .unwrap_or_else(|| "—".to_string())
            ));
            for key in VIDEO_METRIC_KEYS {
                let cell = metrics
                    .and_then(|m| m.get(key))
                    .map(format_metric_html)
                    .unwrap_or_else(|| "—".to_string());
                html.push_str(&format!("<td>{cell}</td>"));
            }
            let status = status_text(&candidate.error, metrics.is_some());
            let class = if candidate.error.is_some() {
                " class=\"status-fail\""
            } else {
                ""
            };
            html.push_str(&format!("<td{class}>{}</td></tr>\n", esc(&status)));
        }
        html.push_str("</tbody>\n</table>\n");
    }

    // BD-rate 汇总（与 GUI 汇总区同一数据源）
    html.push_str("<h2>BD-rate 汇总</h2>\n");
    html.push_str(&format!(
        "<p class=\"meta\">参照格式：{}</p>\n",
        esc(&bdrate_legend(summary.reference_format.as_deref()))
    ));
    if let Some(note) = &summary.note {
        html.push_str(&format!("<p class=\"meta\">{}</p>\n", esc(note)));
    }
    html.push_str("<table>\n<thead><tr><th>格式</th><th>BD-rate</th><th>样本点</th><th>说明</th></tr></thead>\n<tbody>\n");
    for entry in &summary.entries {
        let bd = entry
            .bd_rate_percent
            .map(|v| format!("{v:+.2}%"))
            .unwrap_or_else(|| "—".to_string());
        let note = entry.note.as_deref().map(esc).unwrap_or_default();
        html.push_str(&format!(
            "<tr><td>{}</td><td>{bd}</td><td>{}</td><td>{note}</td></tr>\n",
            esc(&entry.format),
            entry.point_count
        ));
    }
    html.push_str("</tbody>\n</table>\n");

    html.push_str("<p class=\"meta\">由像素竞技场生成；报告不含图片正文，文件路径见各表路径列。</p>\n");
    html.push_str("</body>\n</html>\n");
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{CandidateImage, CandidateVideo};

    fn image(path: &str, bytes: u64, metrics: Option<Vec<(&str, MetricValue)>>) -> CandidateImage {
        CandidateImage {
            path: path.to_string(),
            file_size: bytes,
            size_ratio: Some(0.136_424),
            metrics: metrics.map(|m| m.into_iter().map(|(k, v)| (k.to_string(), v)).collect()),
            encoding_params: None,
            note: None,
            error: None,
        }
    }

    fn video(path: &str, bytes: u64, metrics: Option<Vec<(&str, MetricValue)>>) -> CandidateVideo {
        CandidateVideo {
            path: path.to_string(),
            file_size: bytes,
            size_ratio: Some(0.453_083),
            metrics: metrics.map(|m| m.into_iter().map(|(k, v)| (k.to_string(), v)).collect()),
            encoding_params: None,
            error: None,
            elapsed_ms: None,
        }
    }

    fn round(candidates: Vec<CandidateImage>) -> Round {
        Round {
            id: "r-1".to_string(),
            name: "照片测试轮".to_string(),
            reference_path: Some("/tmp/原图 photo.png".to_string()),
            candidates,
            video_reference_path: None,
            video_candidates: Vec::new(),
        }
    }

    fn round_with_video(candidates: Vec<CandidateImage>) -> Round {
        Round {
            id: "r-1".to_string(),
            name: "照片测试轮".to_string(),
            reference_path: Some("/tmp/ref.png".to_string()),
            candidates,
            video_reference_path: Some("/tmp/ref.mp4".to_string()),
            video_candidates: vec![video(
                "/tmp/dis-150k.mp4",
                27_050,
                Some(vec![
                    ("VMAF", MetricValue::new(94.87)),
                    ("PSNR", MetricValue::Inf),
                    ("SSIM", MetricValue::new(0.9926)),
                ]),
            )],
        }
    }

    // ---------- CSV ----------

    #[test]
    fn csv_contains_meta_columns_and_metric_rows() {
        let round = round(vec![
            image(
                "/r/photo-q60.jpg",
                17_341,
                Some(vec![
                    ("PSNR", MetricValue::new(41.862_134_5)),
                    ("SSIM", MetricValue::new(0.993_912_1)),
                ]),
            ),
            image("/r/photo-png.png", 127_123, Some(vec![("PSNR", MetricValue::Inf)])),
        ]);
        let csv = export_csv("人像测试", &round, "2026-10-05 12:00:00");

        // 票 18：CSV 以 UTF-8 BOM 开头（Excel 中文环境按 ANSI 解析无 BOM 的 UTF-8 会乱码）
        assert!(csv.starts_with('\u{FEFF}'), "CSV 应以 UTF-8 BOM 开头");
        assert!(csv.contains("# 跑分组：人像测试"));
        assert!(csv.contains("# 评测轮：照片测试轮"));
        assert!(csv.contains("# 原图：/tmp/原图 photo.png"));
        assert!(csv.contains("# 生成时间：2026-10-05 12:00:00"));
        assert!(csv.contains("# 【图片跑分结果】"));
        assert!(csv.contains(
            "candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status"
        ));
        // 定点 6 位小数 + 指标缺失留空 + 状态（外部导入无编码参数，该列留空）
        let row = csv.lines().find(|l| l.contains("photo-q60.jpg")).unwrap();
        assert_eq!(
            row,
            "/r/photo-q60.jpg,,17341,0.136424,41.862135,0.993912,,,,完成"
        );
        // PSNR 无穷大走 "inf" 哨兵（与 T03 / workspace.json 同一约定）
        let inf_row = csv.lines().find(|l| l.contains("photo-png.png")).unwrap();
        assert!(inf_row.contains(",inf,"), "inf 行: {inf_row}");
    }

    #[test]
    fn csv_escapes_special_characters() {
        let round = round(vec![image("/r/照片, \"好\".jpg", 100, None)]);
        let csv = export_csv("组, 名", &round, "2026-10-05");
        // 字段含逗号/引号/换行时整体加引号、内部引号翻倍（RFC 4180）
        assert!(csv.contains("\"/r/照片, \"\"好\"\".jpg\""));
        assert!(csv.contains("# 跑分组：组, 名"));
    }

    #[test]
    fn csv_marks_unscored_and_failed_rows() {
        let mut failed = image("/r/bad.jpg", 100, None);
        failed.error = Some("原图与跑分图尺寸不一致".to_string());
        let round = round(vec![
            image("/r/pending.jpg", 100, None),
            failed,
        ]);
        let csv = export_csv("组", &round, "2026-10-05");
        let pending = csv.lines().find(|l| l.contains("pending.jpg")).unwrap();
        assert!(pending.ends_with(",待跑分"), "待跑分行: {pending}");
        let failed_line = csv.lines().find(|l| l.contains("bad.jpg")).unwrap();
        assert!(
            failed_line.ends_with("失败：原图与跑分图尺寸不一致"),
            "失败行: {failed_line}"
        );
    }

    /// 编码参数列：一站式写入的参数进 CSV 与 HTML；外部导入（None）CSV 留空、HTML 显 —。
    #[test]
    fn csv_and_html_carry_encoding_params_when_present() {
        let mut onestop =
            image("/r/产物-q75.jpg", 17_341, Some(vec![("PSNR", MetricValue::new(41.86))]));
        onestop.encoding_params = Some("JPEG q75".to_string());
        let round = round(vec![onestop, image("/r/外部导入.jpg", 9_999, None)]);

        let csv = export_csv("组", &round, "t");
        let row = csv.lines().find(|l| l.contains("产物-q75.jpg")).unwrap();
        assert!(row.contains(",JPEG q75,"), "编码参数列应写入：{row}");
        let external = csv.lines().find(|l| l.contains("外部导入.jpg")).unwrap();
        assert!(
            external.starts_with("/r/外部导入.jpg,,"),
            "外部导入编码参数留空：{external}"
        );

        let html = export_html("组", &round, "t");
        assert!(html.contains("<th>编码参数</th>"), "HTML 表头应有编码参数列");
        assert!(html.contains("JPEG q75"));
        assert!(html.contains("<td>—</td>"), "外部导入行编码参数显示 —");
    }

    /// US22（审查修复 B6）：备注（大小优先不可达标注）随导出落进 CSV 与 HTML；
    /// 无备注的轮保持既有列序不变（任一行有备注才追加尾随 note 列，与 GUI 结果表
    /// 同口径；CLI 大小优先自有的 note 列不受影响）。
    #[test]
    fn csv_and_html_carry_note_column_only_when_any_note_exists() {
        let mut noted = image("/r/产物-q1.jpg", 17_341, None);
        noted.note = Some("目标 200KB 不可达：目标低于最小质量点（q1）的产物大小，取最小质量点".to_string());
        let round_with = round(vec![noted, image("/r/产物-q75.jpg", 9_999, None)]);

        let csv = export_csv("组", &round_with, "t");
        assert!(
            csv.contains(
                "candidate,encoding_params,candidate_bytes,size_ratio,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,status,note"
            ),
            "有备注时 CSV 表头应追加 note 列"
        );
        let row = csv.lines().find(|l| l.contains("产物-q1.jpg")).unwrap();
        assert!(row.contains("目标 200KB 不可达"), "备注应进行内：{row}");
        let plain_row = csv.lines().find(|l| l.contains("产物-q75.jpg")).unwrap();
        assert!(plain_row.ends_with(",待跑分,"), "无备注行该列留空: {plain_row}");

        let html = export_html("组", &round_with, "t");
        assert!(html.contains("<th>备注</th>"), "HTML 应有备注列");
        assert!(html.contains("目标 200KB 不可达"), "HTML 备注应进行内");

        // 无备注的轮：列序与既有 schema 完全一致（不加 note 列）
        let plain = export_csv("组", &round(vec![image("/r/a.jpg", 100, None)]), "t");
        let header = plain
            .lines()
            .find(|l| l.starts_with("candidate,"))
            .unwrap();
        assert!(!header.ends_with(",note"), "无备注不得加列: {header}");
    }

    #[test]
    fn csv_video_section_only_when_video_exists() {
        let plain = round(vec![]);
        assert!(!export_csv("组", &plain, "t").contains("【视频跑分结果】"));

        let with_video = round_with_video(vec![]);
        let csv = export_csv("组", &with_video, "t");
        assert!(csv.contains("# 【视频跑分结果】"));
        assert!(csv.contains("candidate,candidate_bytes,size_ratio,vmaf,psnr,ssim,status"));
        let row = csv.lines().find(|l| l.contains("dis-150k.mp4")).unwrap();
        assert_eq!(row, "/tmp/dis-150k.mp4,27050,0.453083,94.870000,inf,0.992600,完成");
    }

    #[test]
    fn csv_bdrate_section_reflects_summary() {
        let mut candidates = Vec::new();
        for (i, q) in [60u64, 75, 90].iter().enumerate() {
            candidates.push(image(
                &format!("/r/a-q{q}.jpg"),
                1000 + i as u64 * 3000,
                Some(vec![("PSNR", MetricValue::new(30.0 + i as f64 * 3.0))]),
            ));
            candidates.push(image(
                &format!("/r/b-q{q}.webp"),
                1100 + i as u64 * 3000,
                Some(vec![("PSNR", MetricValue::new(30.2 + i as f64 * 3.0))]),
            ));
        }
        let csv = export_csv("组", &round(candidates), "t");
        assert!(csv.contains("# 【BD-rate 汇总】（参照格式：JPEG）"));
        assert!(csv.contains("format,bd_rate_percent,point_count,note"));
        let jpeg = csv.lines().find(|l| l.starts_with("JPEG,")).unwrap();
        assert_eq!(jpeg, "JPEG,,3,参照格式");
        let webp = csv.lines().find(|l| l.starts_with("WebP,")).unwrap();
        let value = webp.split(',').nth(1).unwrap().parse::<f64>().unwrap();
        assert!(value != 0.0 && value.abs() < 100.0, "WebP BD-rate 应为数值: {webp}");
    }

    // ---------- HTML ----------

    #[test]
    fn html_is_self_contained_with_meta_and_table() {
        let round = round(vec![image(
            "/r/photo-q60.jpg",
            17_341,
            Some(vec![
                ("PSNR", MetricValue::new(41.86)),
                ("SSIM", MetricValue::new(0.9939)),
            ]),
        )]);
        let html = export_html("人像测试", &round, "2026-10-05 12:00:00");

        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("<html lang=\"zh-CN\">"));
        assert!(html.contains("charset=\"utf-8\""));
        assert!(html.contains("<style>"), "内联样式");
        assert!(!html.contains("<img"), "不嵌图片正文");
        assert!(!html.contains("src="), "无外部资源引用");
        assert!(html.contains("人像测试"));
        assert!(html.contains("照片测试轮"));
        assert!(html.contains("2026-10-05 12:00:00"));
        assert!(html.contains("原图 photo.png"), "原图文件名");
        assert!(html.contains("/tmp/原图 photo.png"), "原图完整路径");
        assert!(html.contains("PSNR"));
        // 指标格式与界面一致：PSNR 两位小数、∞ 直接显示
        assert!(html.contains("41.86"));
        assert!(html.contains("0.9939"));
    }

    #[test]
    fn html_escapes_html_special_characters() {
        let round = round(vec![image(
            "/r/<script>alert(1)</script>.jpg",
            100,
            Some(vec![("PSNR", MetricValue::new(30.0))]),
        )]);
        let html = export_html("组", &round, "t");
        assert!(!html.contains("<script>"), "路径必须被转义");
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn html_shows_paths_size_ratio_and_status() {
        let mut failed = image("/r/bad.jpg", 100, None);
        failed.error = Some("尺寸不一致".to_string());
        let round = round(vec![
            image("/r/photo-q60.jpg", 17_341, Some(vec![("PSNR", MetricValue::new(41.86))])),
            image("/r/pending.jpg", 100, None),
            failed,
        ]);
        let html = export_html("组", &round, "t");
        assert!(html.contains("/r/photo-q60.jpg"), "附文件路径列");
        assert!(html.contains("16.9 KB"), "文件大小与界面同格式");
        assert!(html.contains("13.6%"), "体积比与界面同格式");
        assert!(html.contains("待跑分"));
        assert!(html.contains("失败：尺寸不一致"));
    }

    #[test]
    fn html_video_section_only_when_video_exists() {
        let plain = round(vec![]);
        assert!(!export_html("组", &plain, "t").contains("视频跑分结果"));
        let html = export_html("组", &round_with_video(vec![]), "t");
        assert!(html.contains("视频跑分结果"));
        assert!(html.contains("94.87"));
        assert!(html.contains("0.9926"));
    }

    #[test]
    fn html_bdrate_section_matches_summary() {
        let mut candidates = Vec::new();
        for (i, q) in [60u64, 75, 90].iter().enumerate() {
            candidates.push(image(
                &format!("/r/a-q{q}.jpg"),
                1000 + i as u64 * 3000,
                Some(vec![("PSNR", MetricValue::new(30.0 + i as f64 * 3.0))]),
            ));
            candidates.push(image(
                &format!("/r/b-q{q}.webp"),
                1100 + i as u64 * 3000,
                Some(vec![("PSNR", MetricValue::new(30.2 + i as f64 * 3.0))]),
            ));
        }
        candidates.push(image("/r/p.png", 99_999, Some(vec![("PSNR", MetricValue::Inf)])));
        let round = round(candidates);
        let html = export_html("组", &round, "t");
        assert!(html.contains("BD-rate 汇总"));
        assert!(html.contains("参照格式：JPEG"));
        assert!(html.contains("画质轴：PSNR"), "口径说明");
        // BD-rate 带符号百分数（两位小数），与 summarize_round 输出一致
        let webp_value = summarize_round(&round)
            .entries
            .iter()
            .find(|e| e.format == "WebP")
            .and_then(|e| e.bd_rate_percent)
            .expect("WebP 应有 BD-rate");
        let expected = format!("{webp_value:+.2}%");
        assert!(html.contains(&expected), "应包含 {expected}");
        assert!(html.contains("参照格式</td>"), "参照行标注");
        assert!(html.contains("无损格式，不参与 BD-rate 拟合"));
    }
}
