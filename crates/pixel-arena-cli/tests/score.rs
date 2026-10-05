// CLI 黑盒测试（规格 Issue #1 Testing Decisions）：跑真实二进制，
// 只断言 stdout/stderr/退出码等外部行为，不钉内部实现。
// 样例图复用核心库黄金基准样例（crates/pixel-arena-core/tests/data/）。

use assert_cmd::Command;
use std::path::PathBuf;

/// 黄金基准样例图路径。
fn sample(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pixel-arena-core/tests/data")
        .join(name)
}

#[test]
fn score_csv_单张跑分图_输出表头与一行指标_退出码0() {
    let reference = sample("photo-ref.png");
    let candidate = sample("photo-dis.png");
    let reference_bytes = std::fs::metadata(&reference).unwrap().len();
    let candidate_bytes = std::fs::metadata(&candidate).unwrap().len();

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "score",
            "--reference",
            reference.to_str().unwrap(),
            "--candidates",
            candidate.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "正常路径退出码应为 0，stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );

    // 票 18：CSV 输出以 UTF-8 BOM（EF BB BF）开头，Excel 中文环境直开不乱码
    assert_eq!(
        &output.stdout[..3],
        &[0xEF, 0xBB, 0xBF],
        "CSV 输出前三字节应为 UTF-8 BOM"
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let body = stdout.strip_prefix('\u{FEFF}').expect("stdout 应以 UTF-8 BOM 开头");
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines.len(), 2, "单张跑分图应输出表头加一行，实际：{stdout}");
    assert_eq!(
        lines[0],
        "reference,candidate,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio",
        "CSV 表头字段名固定：T03 的 7 列之后追加三个感知指标列，下游 T13 以此为准"
    );

    let fields: Vec<&str> = lines[1].split(',').collect();
    assert_eq!(fields.len(), 10, "每行 10 列，实际：{}", lines[1]);
    assert_eq!(fields[0], reference.to_str().unwrap(), "reference 列应原样回显传入路径");
    assert_eq!(fields[1], candidate.to_str().unwrap(), "candidate 列应原样回显传入路径");

    let psnr: f64 = fields[2].parse().unwrap_or_else(|_| panic!("psnr 列应是数字，实际 {}", fields[2]));
    assert!(
        psnr.is_finite() && psnr > 0.0 && psnr < 100.0,
        "有损跑分图 PSNR 应为有限正值，实际 {psnr}"
    );
    let ssim: f64 = fields[3].parse().unwrap_or_else(|_| panic!("ssim 列应是数字，实际 {}", fields[3]));
    assert!(
        (0.0..=1.0).contains(&ssim),
        "SSIM 应在 [0, 1]，实际 {ssim}"
    );
    let ms_ssim: f64 = fields[4].parse().unwrap_or_else(|_| panic!("ms_ssim 列应是数字，实际 {}", fields[4]));
    assert!(
        (0.0..=1.0).contains(&ms_ssim) && ms_ssim >= ssim - 1e-6,
        "MS-SSIM 应在 [0, 1] 且不低于单尺度 SSIM（多尺度对平滑失真更宽容），实际 {ms_ssim}"
    );
    let butteraugli: f64 = fields[5].parse().unwrap_or_else(|_| panic!("butteraugli 列应是数字，实际 {}", fields[5]));
    assert!(
        butteraugli.is_finite() && butteraugli > 0.0,
        "Butteraugli 距离分应为有限正值（0 = 相同），实际 {butteraugli}"
    );
    let ssimulacra2: f64 = fields[6].parse().unwrap_or_else(|_| panic!("ssimulacra2 列应是数字，实际 {}", fields[6]));
    assert!(
        ssimulacra2.is_finite() && ssimulacra2 > 0.0 && ssimulacra2 < 100.0,
        "有损跑分图的 SSIMULACRA2 应为有限正值且小于 100（100 = 相同），实际 {ssimulacra2}"
    );

    assert_eq!(
        fields[7].parse::<u64>().unwrap(),
        reference_bytes,
        "reference_bytes 应等于原图文件字节数"
    );
    assert_eq!(
        fields[8].parse::<u64>().unwrap(),
        candidate_bytes,
        "candidate_bytes 应等于跑分图文件字节数"
    );
    let size_ratio: f64 = fields[9].parse().unwrap_or_else(|_| panic!("size_ratio 列应是数字，实际 {}", fields[9]));
    let expected_ratio = candidate_bytes as f64 / reference_bytes as f64;
    assert!(
        (size_ratio - expected_ratio).abs() < 1e-6,
        "size_ratio 应为跑分图字节数/原图字节数，实际 {size_ratio}，期望 {expected_ratio}"
    );

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("1/1"), "进度应显示第几张/共几张，stderr：{stderr}");
}

#[test]
fn score_csv_多张跑分图_按参数顺序逐张输出_进度显示第几张共几张() {
    let reference = sample("photo-ref.png");
    let first = sample("photo-dis.png");
    let second = sample("photo-dis.jpg");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "score",
            "--reference",
            reference.to_str().unwrap(),
            "--candidates",
            first.to_str().unwrap(),
            second.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "正常路径退出码应为 0，stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 3, "两张跑分图应输出表头加两行，实际：{stdout}");

    let candidate_of = |line: &str| line.split(',').nth(1).unwrap().to_string();
    assert_eq!(candidate_of(lines[1]), first.to_str().unwrap(), "行顺序应与参数顺序一致");
    assert_eq!(candidate_of(lines[2]), second.to_str().unwrap(), "行顺序应与参数顺序一致");

    let stderr = String::from_utf8(output.stderr).unwrap();
    let first_progress = stderr.find("1/2").expect("进度应包含 1/2");
    let second_progress = stderr.find("2/2").expect("进度应包含 2/2");
    assert!(
        first_progress < second_progress,
        "进度应按 1/2、2/2 顺序出现，stderr：{stderr}"
    );
}

#[test]
fn score_json_输出可解析_字段与_csv_同名单张退出码0() {
    let reference = sample("photo-ref.png");
    let candidate = sample("photo-dis.png");
    let reference_bytes = std::fs::metadata(&reference).unwrap().len();
    let candidate_bytes = std::fs::metadata(&candidate).unwrap().len();

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "score",
            "--reference",
            reference.to_str().unwrap(),
            "--candidates",
            candidate.to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "正常路径退出码应为 0，stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let parsed: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout 应是合法 JSON");
    let rows = parsed.as_array().expect("JSON 顶层应是数组");
    assert_eq!(rows.len(), 1, "单张跑分图应有一个元素");
    let row = &rows[0];
    assert_eq!(
        row["reference"].as_str(),
        Some(reference.to_str().unwrap()),
        "reference 字段应原样回显传入路径"
    );
    assert_eq!(row["candidate"].as_str(), Some(candidate.to_str().unwrap()));

    let psnr = row["psnr"]
        .as_f64()
        .expect("psnr 字段应是数字，实际 {row}");
    assert!(psnr.is_finite() && psnr > 0.0 && psnr < 100.0, "实际 {psnr}");
    let ssim = row["ssim"].as_f64().expect("ssim 字段应是数字");
    assert!((0.0..=1.0).contains(&ssim), "SSIM 应在 [0, 1]，实际 {ssim}");
    let ms_ssim = row["ms_ssim"].as_f64().expect("ms_ssim 字段应是数字");
    assert!((0.0..=1.0).contains(&ms_ssim), "MS-SSIM 应在 [0, 1]，实际 {ms_ssim}");
    let butteraugli = row["butteraugli"].as_f64().expect("butteraugli 字段应是数字");
    assert!(
        butteraugli.is_finite() && butteraugli > 0.0,
        "Butteraugli 距离分应为有限正值，实际 {butteraugli}"
    );
    let ssimulacra2 = row["ssimulacra2"].as_f64().expect("ssimulacra2 字段应是数字");
    assert!(
        ssimulacra2.is_finite() && (0.0..100.0).contains(&ssimulacra2),
        "有损跑分图的 SSIMULACRA2 应在 [0, 100)，实际 {ssimulacra2}"
    );

    assert_eq!(
        row["reference_bytes"].as_u64(),
        Some(reference_bytes),
        "reference_bytes 应等于原图文件字节数"
    );
    assert_eq!(row["candidate_bytes"].as_u64(), Some(candidate_bytes));
    let size_ratio = row["size_ratio"].as_f64().expect("size_ratio 字段应是数字");
    let expected_ratio = candidate_bytes as f64 / reference_bytes as f64;
    assert!(
        (size_ratio - expected_ratio).abs() < 1e-9,
        "size_ratio 应为跑分图字节数/原图字节数，实际 {size_ratio}"
    );
}

#[test]
fn score_两图逐像素一致时psnr在csv与json中都表示为inf() {
    let image = sample("solid-ref.png");

    let csv_output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score", "--reference", image.to_str().unwrap(), "--candidates", image.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(csv_output.status.code(), Some(0));
    let stdout = String::from_utf8(csv_output.stdout).unwrap();
    let fields: Vec<&str> = stdout.lines().nth(1).unwrap().split(',').collect();
    assert_eq!(fields[2], "inf", "同一张图 CSV 的 psnr 列应为 \"inf\"，实际：{stdout}");
    assert_eq!(fields[3], "1.000000", "同一张图 SSIM 应为 1，实际：{stdout}");
    assert_eq!(fields[4], "1.000000", "同一张图 MS-SSIM 应为 1，实际：{stdout}");
    assert_eq!(fields[5], "0.000000", "同一张图 Butteraugli 应为 0（距离分），实际：{stdout}");
    assert_eq!(fields[6], "100.000000", "同一张图 SSIMULACRA2 应为 100（质量分），实际：{stdout}");
    assert_eq!(fields[9], "1.000000", "同一张图体积比应为 1，实际：{stdout}");

    let json_output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "score",
            "--reference",
            image.to_str().unwrap(),
            "--candidates",
            image.to_str().unwrap(),
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert_eq!(json_output.status.code(), Some(0));
    let parsed: serde_json::Value = serde_json::from_slice(&json_output.stdout).unwrap();
    assert_eq!(
        parsed[0]["psnr"],
        serde_json::json!("inf"),
        "同一张图 JSON 的 psnr 字段应为字符串 \"inf\""
    );
    assert_eq!(parsed[0]["ssim"], serde_json::json!(1.0));
    assert_eq!(parsed[0]["ms_ssim"], serde_json::json!(1.0));
    assert_eq!(parsed[0]["butteraugli"], serde_json::json!(0.0));
    assert_eq!(parsed[0]["ssimulacra2"], serde_json::json!(100.0));
}

#[test]
fn score_原图不存在时退出码1_中文报错_stdout无数据() {
    let reference = sample("不存在的原图.png");
    let candidate = sample("photo-dis.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score", "--reference", reference.to_str().unwrap(), "--candidates", candidate.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1), "运行期错误退出码应为 1");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("错误："), "应有中文错误前缀，stderr：{stderr}");
    assert!(
        stderr.contains("无法读取") && stderr.contains(reference.to_str().unwrap()),
        "报错应能定位到读不了的文件，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty(), "出错时 stdout 应保持纯数据约定（空）");
}

#[test]
fn score_跑分图是不支持的格式时退出码1_中文报错() {
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let reference = sample("photo-ref.png");
    let candidate = dir.path().join("文本伪装的跑分图.txt");
    std::fs::write(&candidate, "这不是图片").expect("测试样例应能写入");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score", "--reference", reference.to_str().unwrap(), "--candidates", candidate.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("无法解码") && stderr.contains("受支持的格式"),
        "不支持格式应报中文错误并说明受支持范围，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn score_跑分图损坏时退出码1_中文报错() {
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let reference = sample("photo-ref.png");
    let candidate = dir.path().join("损坏的跑分图.png");
    std::fs::write(&candidate, [0x89, b'P', b'N', b'G', 0xFF, 0x00, 0xDE, 0xAD]).expect("测试样例应能写入");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score", "--reference", reference.to_str().unwrap(), "--candidates", candidate.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("无法解码"),
        "损坏文件应报中文解码错误，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn score_跑分图尺寸与原图不一致时退出码1_中文报错含两边尺寸() {
    // photo-ref 是 256x256，solid-dis 是 128x128。
    let reference = sample("photo-ref.png");
    let candidate = sample("solid-dis.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score", "--reference", reference.to_str().unwrap(), "--candidates", candidate.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("尺寸不一致") && stderr.contains("256x256") && stderr.contains("128x128"),
        "尺寸不一致报错应包含两边尺寸，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn score_缺必填参数时退出码2() {
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["score"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "用法错误退出码应为 2（沿用现有约定）");
}

#[test]
fn score_html_自包含中文报告_含五指标表头与生成时间() {
    let reference = sample("photo-ref.png");
    let candidate = sample("photo-dis.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "score",
            "--reference",
            reference.to_str().unwrap(),
            "--candidates",
            candidate.to_str().unwrap(),
            "--format",
            "html",
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "正常路径退出码应为 0，stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    // 自包含：doctype + 简体中文 + 内联样式，无外部资源引用
    assert!(stdout.starts_with("<!doctype html>"), "HTML 报告开头：{stdout}");
    assert!(stdout.contains("<html lang=\"zh-CN\">"));
    assert!(stdout.contains("charset=\"utf-8\""));
    assert!(stdout.contains("<style>"), "样式应内联");
    assert!(!stdout.contains("src="), "报告不应引用外部资源：{stdout}");
    // 简体中文表头 + 全部五指标 + 生成时间与原图元信息
    for fragment in [
        "像素竞技场跑分报告",
        "生成时间：",
        "跑分图",
        "PSNR",
        "SSIM",
        "MS-SSIM",
        "Butteraugli",
        "SSIMULACRA2",
        "体积比",
        "photo-ref.png",
        "photo-dis.png",
    ] {
        assert!(stdout.contains(fragment), "报告应含「{fragment}」：{stdout}");
    }
    // 有损样例的 PSNR 应为两位小数显示口径（非 CSV 的 6 位）
    assert!(!stdout.contains("inf"), "有损样例不应出现 ∞/inf：{stdout}");

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("1/1"), "进度提示不受输出格式影响，stderr：{stderr}");
}
