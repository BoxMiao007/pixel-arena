// CLI run 子命令（一站式批量，T12）的黑盒测试：跑真实二进制，
// 只断言 stdout/stderr/退出码等外部行为，不钉内部实现。
//
// 分层策略（沿 T10/T11 先例，全部离线可跑）：
// - 无损 PNG 组不需要外部编码器：正常路径的主断言（CSV/JSON/产物落盘）用它做全链路验证；
// - 有损格式依赖编码器：用「预置桩编码器」验证内置落位复用路径（T32 起不再检查
//   哈希 sidecar——运行期下载与校验链已移除），用「缺失 + 空工具目录」验证中文
//   报错含官方发布页指引（决策 0025），真实编码器用 shared/encoders 工件直接解包预置；
// - 完整默认阶梯（15 项）依赖本机已装的真实编码器（T11 留下），未装则自动跳过。
// 样例图复用核心库黄金基准样例（crates/pixel-arena-core/tests/data/）。

use assert_cmd::Command;
use std::path::{Path, PathBuf};

/// 黄金基准样例图路径。
fn sample(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pixel-arena-core/tests/data")
        .join(name)
}

/// 预置一个桩 cwebp 到内置落位（T32：复用只看「成员文件存在」，哈希 sidecar 已随
/// 下载链路移除），桩被调用时把入库的真实 WebP 样例拷成产物，保证跑分环节能解码。
/// 参数契约（encode_webp_using）：$1=-quiet $2=-q $3=质量 $4=输入 $5=-o $6=产物临时文件。
fn preseed_stub_cwebp(tools: &Path, fixture_webp: &Path) {
    let dir = tools.join("libwebp").join("1.6.0");
    std::fs::create_dir_all(&dir).unwrap();
    let encoder = dir.join("cwebp");
    std::fs::write(&encoder, format!("#!/bin/sh\ncp '{}' \"$6\"\n", fixture_webp.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&encoder, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

// ---------- 正常路径：无损 PNG 组（无需外部编码器，全链路真实） ----------

#[test]
fn run_png对照组_csv_表头与一行_质量列lossless_psnr为inf_退出码0() {
    let reference = sample("photo-ref.png");
    let reference_bytes = std::fs::metadata(&reference).unwrap().len();

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            // 有损组显式清空：只跑无损 PNG（默认有损组为全开）
            "--formats",
            "--lossless",
            "png",
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
    assert_eq!(lines.len(), 2, "一个档位应输出表头加一行，实际：{stdout}");
    assert_eq!(
        lines[0],
        "reference,candidate,format,quality,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio",
        "列 = score 现有列序 + format/quality 两列（T12 笔记登记，T13 以此为准）"
    );

    let fields: Vec<&str> = lines[1].split(',').collect();
    assert_eq!(fields.len(), 12, "每行 12 列，实际：{}", lines[1]);
    assert_eq!(fields[0], reference.to_str().unwrap(), "reference 列应原样回显传入路径");
    assert!(fields[1].ends_with("photo-ref_png.png"), "candidate 列应为产物路径：{}", fields[1]);
    assert_eq!(fields[2], "png", "format 列应为规范格式字符串");
    assert_eq!(fields[3], "lossless", "无损组质量列应为 lossless");
    assert_eq!(fields[4], "inf", "无损产物与原图逐位一致，PSNR 应为 inf 哨兵");
    assert_eq!(fields[5], "1.000000", "无损 SSIM 应为 1，实际：{}", lines[1]);
    assert_eq!(fields[6], "1.000000", "无损 MS-SSIM 应为 1，实际：{}", lines[1]);
    assert_eq!(fields[7], "0.000000", "无损 Butteraugli 应为 0，实际：{}", lines[1]);
    assert_eq!(fields[8], "100.000000", "无损 SSIMULACRA2 应为 100，实际：{}", lines[1]);
    assert_eq!(fields[9], reference_bytes.to_string(), "reference_bytes 应等于原图字节数");
    let candidate_bytes: u64 = fields[10].parse().unwrap_or_else(|_| panic!("candidate_bytes 应是整数，实际 {}", fields[10]));
    assert!(candidate_bytes > 0);
    assert!(fields[11].parse::<f64>().unwrap() > 0.0, "体积比应为正数，实际 {}", fields[11]);

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("正在生成 PNG（1/1）"), "生成进度走 stderr：{stderr}");
    assert!(stderr.contains("正在跑分 1/1"), "跑分进度走 stderr：{stderr}");
}

#[test]
fn run_png对照组_json_质量为null_psnr为inf哨兵_退出码0() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "--lossless",
            "png",
            "--format",
            "json",
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).expect("stdout 应是合法 JSON");
    let rows = parsed.as_array().expect("JSON 顶层应是数组");
    assert_eq!(rows.len(), 1, "一个档位应有一个元素");
    let row = &rows[0];
    assert_eq!(row["reference"].as_str(), Some(reference.to_str().unwrap()));
    assert!(row["candidate"].as_str().unwrap().ends_with("photo-ref_png.png"));
    assert_eq!(row["format"], "png", "format 字段应为规范格式字符串");
    assert!(row["quality"].is_null(), "无损组 JSON quality 应为 null：{row}");
    assert_eq!(row["psnr"], serde_json::json!("inf"), "无损 PSNR 应为 \"inf\" 哨兵");
    assert_eq!(row["ssim"], serde_json::json!(1.0));
    assert_eq!(row["ms_ssim"], serde_json::json!(1.0));
    assert_eq!(row["butteraugli"], serde_json::json!(0.0));
    assert_eq!(row["ssimulacra2"], serde_json::json!(100.0));
    assert!(row["reference_bytes"].as_u64().unwrap() > 0);
    assert!(row["candidate_bytes"].as_u64().unwrap() > 0);
    assert!(row["size_ratio"].as_f64().unwrap() > 0.0);
}

#[test]
fn run_产物目录参数_产物落盘_结束提示路径() {
    let reference = sample("photo-ref.png");
    let out = tempfile::tempdir().unwrap();

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "--lossless",
            "png",
            "--out",
            out.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        out.path().join("photo-ref_png.png").exists(),
        "产物应落在 --out 指定目录"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains(&format!("产物目录：{}", out.path().display())),
        "结束应提示产物目录：{stderr}"
    );
}

// ---------- 错误路径 ----------

#[test]
fn run_原图不存在时退出码1_中文报错_stdout无数据() {
    let reference = sample("不存在的原图.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap()])
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
fn run_原图损坏时全部档位失败_退出码1_中文报错_stdout空() {
    let dir = tempfile::tempdir().unwrap();
    let reference = dir.path().join("损坏的原图.png");
    std::fs::write(&reference, "这不是图片").unwrap();

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "--lossless",
            "png",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("生成失败：PNG"), "失败档位应逐项点名：{stderr}");
    assert!(
        stderr.contains("错误：") && stderr.contains("无法解码"),
        "无可用结果时应汇总中文错误：{stderr}"
    );
    assert!(output.stdout.is_empty(), "全部失败时 stdout 应为空");
}

#[test]
fn run_未知格式时退出码1_中文报错() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--formats", "gif"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("不支持的编码格式") && stderr.contains("gif"),
        "未知格式应报中文错误并点名格式，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_有损参数选了无损格式_提示改用lossless参数() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--formats", "png"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("--lossless"),
        "应提示无损格式走 --lossless，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_无损参数选了有损格式_提示改用formats参数() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--lossless", "jpeg"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("--formats"),
        "应有损格式走 --formats，stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_质量越界时退出码1_中文报错() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--formats", "jpeg", "--qualities", "0"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("质量 0 无效，有效范围 1–100"),
        "stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_质量非数字时退出码1_中文报错() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--formats", "jpeg", "--qualities", "abc"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("质量 abc 无效，有效范围 1–100"),
        "stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_阶梯为空时退出码1_中文报错() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap(), "--formats", "--lossless"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("没有可生成的档位"),
        "stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_缺必填参数时退出码2() {
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2), "用法错误退出码应为 2（沿用现有约定）");
}

// ---------- 有损格式：已装复用（桩编码器预置 tools 目录，离线确定性） ----------

#[test]
fn run_内置落位编码器直接复用_webp有损档_输出真实跑分行() {
    let tools = tempfile::tempdir().unwrap();
    preseed_stub_cwebp(tools.path(), &sample("photo-dis.webp"));
    let out = tempfile::tempdir().unwrap();
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "webp",
            "--qualities",
            "60",
            // 无损组显式清空：只跑有损 WebP 一档（默认无损组为全开）
            "--lossless",
            "--out",
            out.path().to_str().unwrap(),
            "--tools-dir",
            tools.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<&str> = stdout.lines().nth(1).unwrap().split(',').collect();
    assert_eq!(fields[2], "webp", "format 列应为规范格式字符串");
    assert_eq!(fields[3], "60", "有损档质量列应为十进制整数：{stdout}");
    let psnr: f64 = fields[4].parse().unwrap_or_else(|_| panic!("psnr 应是数字，实际 {}", fields[4]));
    assert!(psnr.is_finite() && psnr > 0.0, "有损档 PSNR 应为有限正值，实际 {psnr}");
    assert!(
        out.path().join("photo-ref_webp_q60.webp").exists(),
        "产物应按 <原图名>-q<质量>.<扩展名> 落在 --out 目录"
    );
}

// ---------- 有损格式：内置编码器缺失（T32：运行期下载已移除，报错指引官方发布页） ----------

#[test]
fn run_内置编码器缺失_退出码1_中文报错含官方发布页与外部路径指引() {
    // 空工具目录（无内置落位）：不再自动下载，必须报中文错误并给出
    // 官方发布页 URL（单一数据源）与「设置页指定外部路径」指引
    let tools = tempfile::tempdir().unwrap();
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "jpeg",
            "--qualities",
            "75",
            // 无损组显式清空：只跑有损 JPEG 一档（缺失编码器 → 全部失败）
            "--lossless",
            "--tools-dir",
            tools.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("内置文件缺失"),
        "报错应说明内置文件缺失：{stderr}"
    );
    assert!(
        stderr.contains("https://github.com/mozilla/mozjpeg/releases"),
        "报错应含官方发布页 URL（单一数据源）：{stderr}"
    );
    assert!(stderr.contains("设置页"), "报错应指引设置页指定外部路径：{stderr}");
    assert!(
        !tools.path().join("mozjpeg").exists(),
        "缺失路径不得创建安装目录（运行期不再下载）"
    );
    assert!(output.stdout.is_empty(), "全部失败时 stdout 应为空");
}

// ---------- T26：跑分阶段并行（--concurrency） ----------

#[test]
fn run_并发参数_png组_并发2与并发1输出逐行一致() {
    // PNG 无损组离线可跑全链路：image crate 编码确定性保证两次产物逐位一致，
    // 并发度不同 stdout 必须完全一致（run_parallel 保序 + 闭式指标）。
    // 两次 run 各用自己的 --out：产物同名冲突自动 _1 不覆盖（T29-1 决策 D9），
    // 共用目录会让 candidate 列路径不同、无法逐行对比。
    let reference = sample("photo-ref.png");
    let run_with = |concurrency: &str| {
        let out = tempfile::tempdir().unwrap();
        let output = Command::cargo_bin("pixel-arena-cli")
            .unwrap()
            .args([
                "run",
                "--reference",
                reference.to_str().unwrap(),
                "--formats",
                "--lossless",
                "png",
                "--out",
                out.path().to_str().unwrap(),
                "--concurrency",
                concurrency,
            ])
            .output()
            .unwrap();
        (out, output)
    };

    let (out_serial, serial) = run_with("1");
    assert_eq!(
        serial.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&serial.stderr)
    );
    let (out_parallel, parallel) = run_with("2");
    assert_eq!(
        parallel.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&parallel.stderr)
    );
    // candidate 列含各自的临时目录路径，比较前归一成文件名
    let normalize = |bytes: &[u8], dir: &std::path::Path| -> String {
        String::from_utf8(bytes.to_vec())
            .unwrap()
            .replace(dir.to_str().unwrap(), "")
    };
    assert_eq!(
        normalize(&serial.stdout, out_serial.path()),
        normalize(&parallel.stdout, out_parallel.path()),
        "并发度不应改变 run 的输出数据"
    );

    let stderr = String::from_utf8(parallel.stderr).unwrap();
    assert!(
        stderr.contains("正在跑分 1/1"),
        "并行跑分的进度仍应是 N/M 形式：{stderr}"
    );
}

#[test]
fn run_并发0_钳到1_png组正常出结果() {
    let reference = sample("photo-ref.png");
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats",
            "--lossless",
            "png",
            "--concurrency",
            "0",
        ])
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "--concurrency 0 应钳到 1 而不是报错，stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        stdout.lines().count(),
        2,
        "无损 PNG 一档应输出表头加一行：{stdout}"
    );
}

// ---------- 默认阶梯：本机已装真实编码器时全 15 项（未装自动跳过） ----------

#[test]
#[cfg(target_os = "linux")]
fn run_默认阶梯_本机已装编码器时_15行_格式质量序与无损锚点() {
    // 门控：桌面端（T11）已把 7 格式编码器装进应用数据目录；未装齐则跳过（CI 离线）。
    let Some(home) = std::env::var_os("HOME") else {
        eprintln!("跳过：无 HOME");
        return;
    };
    let tools = PathBuf::from(home).join(".local/share/io.github.boxmiao007.pixelarena/tools");
    let all_installed = [
        "mozjpeg/4.1.5/cjpeg",
        "libwebp/1.6.0/cwebp",
        "libavif/1.4.2/avifenc",
        "libavif/1.4.2/avifdec",
        "libjxl/0.11.1/cjxl",
    ]
    .iter()
    .all(|member| tools.join(member).is_file());
    if !all_installed {
        eprintln!("跳过：应用数据目录未装齐编码器（{}）", tools.display());
        return;
    }

    let out = tempfile::tempdir().unwrap();
    let reference = sample("photo-ref.png");
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--out",
            out.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        16,
        "默认阶梯 = 有损 4 格式 × 3 档 + 无损 3 项，共 15 行加表头：{stdout}"
    );

    let formats: Vec<&str> = lines[1..].iter().map(|l| l.split(',').nth(2).unwrap()).collect();
    assert_eq!(
        formats,
        [
            "jpeg", "jpeg", "jpeg", "webp", "webp", "webp", "avif", "avif", "avif", "jxl", "jxl",
            "jxl", "png", "webp-lossless", "jxl-lossless"
        ],
        "阶梯顺序应与前端 buildLadder 一致：先有损（格式 × 质量档）后无损组"
    );
    let qualities: Vec<&str> = lines[1..].iter().map(|l| l.split(',').nth(3).unwrap()).collect();
    assert_eq!(
        qualities,
        [
            "60", "75", "90", "60", "75", "90", "60", "75", "90", "60", "75", "90", "lossless",
            "lossless", "lossless"
        ]
    );

    for line in &lines[1..13] {
        let fields: Vec<&str> = line.split(',').collect();
        let psnr: f64 = fields[4].parse().unwrap_or_else(|_| panic!("有损档 PSNR 应为数字：{line}"));
        assert!(psnr.is_finite() && psnr > 0.0, "有损档 PSNR 应为有限正值：{line}");
    }
    for line in &lines[13..] {
        let fields: Vec<&str> = line.split(',').collect();
        assert_eq!(fields[4], "inf", "无损组 PSNR 应为 inf：{line}");
    }

    // 产物落盘抽查：三种扩展名代表有损/无损/代片机制
    assert!(out.path().join("photo-ref_jpeg_q60.jpg").exists());
    assert!(out.path().join("photo-ref_avif_q90.avif").exists());
    assert!(out.path().join("photo-ref_jpegxl_lossless.jxl").exists());

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("（15/15）"), "生成进度应走到最后一项：{stderr}");
}

#[test]
fn run_png对照组_html报告_自包含_格式质量列齐全_退出码0() {
    let reference = sample("photo-ref.png");

    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            reference.to_str().unwrap(),
            "--formats", // 有损组显式清空：只跑无损 PNG（离线全链路）
            "--lossless",
            "png",
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
    // 自包含中文报告：doctype + 内联样式 + 生成时间，无外部资源引用
    assert!(stdout.starts_with("<!doctype html>"), "HTML 报告开头：{stdout}");
    assert!(stdout.contains("<html lang=\"zh-CN\">"));
    assert!(stdout.contains("<style>"), "样式应内联");
    assert!(!stdout.contains("src="), "报告不应引用外部资源：{stdout}");
    // run 特有的格式/质量列：规范格式串 png + 无损组的中文「无损」质量
    for fragment in [
        "像素竞技场跑分报告",
        "生成时间：",
        "一站式批量跑分",
        "photo-ref.png",
        ">png<",
        "无损",
        "PSNR",
        "SSIMULACRA2",
    ] {
        assert!(stdout.contains(fragment), "报告应含「{fragment}」：{stdout}");
    }
    // 无损产物与原图逐位一致：PSNR 显示 ∞（HTML 口径，非 CSV 的 inf 哨兵）
    assert!(stdout.contains("∞"), "无损产物 PSNR 应显示 ∞：{stdout}");

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("正在生成 PNG（1/1）"), "生成进度走 stderr：{stderr}");
}

// ---------- T21：基准质量（质量优先自动取点）与目标大小（大小优先搜索） ----------

/// 从共享工件目录解出真实 cjpeg 预置到 tools 内置落位，跑一轮 run，
/// 返回 (退出码, stdout, stderr)。工件缺失时返回 None（调用方跳过）。
/// T32 起运行期下载已移除：测试改用与安装包捆绑同源的 shared/encoders 工件
/// 直接解包预置（mozjpeg 工件仅 170KB，秒级）。
fn run_with_real_cjpeg(extra_args: &[&str]) -> Option<(Option<i32>, String, String)> {
    let tools = preseed_real_cjpeg()?;
    let reference = sample("photo-ref.png");
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args(["run", "--reference", reference.to_str().unwrap()])
        .args(extra_args)
        .args(["--tools-dir", tools.path().to_str().unwrap()])
        .output()
        .unwrap();
    Some((
        output.status.code(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    ))
}

/// 在目录树里按文件名找文件（工件包内可能多一层版本目录）。
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    let mut queue: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect();
    while let Some(path) = queue.pop() {
        if path.is_file() && path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                queue.extend(entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()));
            }
        }
    }
    None
}

/// 解包 shared/encoders 的 mozjpeg 工件到 tools/mozjpeg/4.1.5/（内置落位规则）。
/// 工件缺失返回 None；解包/归位失败 panic（环境异常应当暴露而不是静默跳过）。
#[allow(unused_variables)]
fn preseed_real_cjpeg() -> Option<tempfile::TempDir> {
    let artifact = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../pixel-arena-shared/encoders/mozjpeg-v4.1.5-linux-x86_64.tar.gz");
    let Ok(artifact) = artifact.canonicalize() else {
        eprintln!("跳过：未找到 pixel-arena-shared/encoders 的 mozjpeg 工件");
        return None;
    };
    let tools = tempfile::tempdir().unwrap();
    let dest = tools.path().join("mozjpeg").join("4.1.5");
    std::fs::create_dir_all(&dest).unwrap();
    let ok = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&artifact)
        .arg("-C")
        .arg(&dest)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    assert!(ok, "解包 mozjpeg 工件失败：{}", artifact.display());
    let cjpeg = find_file(&dest, "cjpeg").expect("工件内应有 cjpeg");
    let member = dest.join("cjpeg");
    if cjpeg != member {
        std::fs::rename(&cjpeg, &member).expect("cjpeg 应能归位到落位路径");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&member, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    Some(tools)
}

fn quality_columns(stdout: &str) -> Vec<&str> {
    stdout
        .lines()
        .skip(1)
        .map(|line| line.split(',').nth(3).unwrap())
        .collect()
}

#[test]
fn run_基准质量75_jpeg自动取点_复现默认阶梯60_75_90() {
    let Some((code, stdout, stderr)) = run_with_real_cjpeg(&[
        "--formats",
        "jpeg",
        "--lossless",
        "--baseline-quality",
        "75",
    ]) else {
        return;
    };
    assert_eq!(code, Some(0), "stderr：{stderr}");
    assert_eq!(
        quality_columns(&stdout),
        ["60", "75", "90"],
        "基准 75 的取点应与现行默认阶梯完全一致：{stdout}"
    );
}

#[test]
fn run_基准质量90_jpeg自动取点_75_90_100_贴上界夹紧() {
    let Some((code, stdout, stderr)) = run_with_real_cjpeg(&[
        "--formats",
        "jpeg",
        "--lossless",
        "--baseline-quality",
        "90",
    ]) else {
        return;
    };
    assert_eq!(code, Some(0), "stderr：{stderr}");
    assert_eq!(
        quality_columns(&stdout),
        ["75", "90", "100"],
        "基准 90 在 jpeg 范围 1–100 内应取 75/90/100：{stdout}"
    );
}

#[test]
fn run_基准质量越界_退出码1_中文报错() {
    let output = Command::cargo_bin("pixel-arena-cli")
        .unwrap()
        .args([
            "run",
            "--reference",
            sample("photo-ref.png").to_str().unwrap(),
            "--baseline-quality",
            "101",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("基准质量 101 无效，有效范围 0–100"),
        "stderr：{stderr}"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_目标大小可达_jpeg命中加邻近补点_note列留空() {
    // 先用 --qualities 50 拿一档产物大小当目标：q50 的产物大小必然落在
    // q1–q100 的可达范围内，保证第二轮「目标可达」
    let Some((code, first, stderr)) =
        run_with_real_cjpeg(&["--formats", "jpeg", "--lossless", "--qualities", "50"])
    else {
        return;
    };
    assert_eq!(code, Some(0), "stderr：{stderr}");
    let candidate_bytes: u64 = first
        .lines()
        .nth(1)
        .unwrap()
        .split(',')
        .nth(10)
        .unwrap()
        .parse()
        .expect("candidate_bytes 应是整数");
    let target_kb = candidate_bytes.div_ceil(1024).max(1);

    let target_kb_text = target_kb.to_string();
    let Some((code, stdout, stderr)) = run_with_real_cjpeg(&[
        "--formats",
        "jpeg",
        "--lossless",
        "--target-size",
        &target_kb_text,
    ]) else {
        return;
    };
    assert_eq!(code, Some(0), "stderr：{stderr}");

    let lines: Vec<&str> = stdout.lines().collect();
    assert!(lines.len() >= 4, "命中点 + 邻近补点应 ≥3 行：{stdout}");
    // 大小优先模式的 CSV 带尾随 note 列；可达时全部留空
    assert!(
        lines[0].ends_with(",note"),
        "大小优先模式表头应有 note 列：{stdout}"
    );
    for line in &lines[1..] {
        let fields: Vec<&str> = line.split(',').collect();
        assert_eq!(fields.len(), 13, "13 列（含 note）：{line}");
        assert_eq!(fields[12], "", "可达行 note 应留空：{line}");
        assert!(
            fields[10].parse::<u64>().unwrap() > 0,
            "产物大小应为正：{line}"
        );
    }
}

#[test]
fn run_目标大小0_过小不可达_回退最小质量点并标注() {
    let Some((code, stdout, stderr)) = run_with_real_cjpeg(&[
        "--formats",
        "jpeg",
        "--lossless",
        "--target-size",
        "0",
    ]) else {
        return;
    };
    assert_eq!(code, Some(0), "回退最接近点仍是可用结果：stderr：{stderr}");
    assert_eq!(
        quality_columns(&stdout),
        ["1", "16", "31"],
        "目标 0 字节不可达，应回退最小质量点 q1 并补邻近点：{stdout}"
    );
    for line in stdout.lines().skip(1) {
        let note = line.split(',').nth(12).expect("note 列：{line}");
        assert!(note.contains("不可达") && note.contains("过小"), "note：{line}");
    }
    assert!(stderr.contains("不可达"), "stderr 应提示标注：{stderr}");
}

#[test]
fn run_目标大小过大_回退最高质量点并标注() {
    let Some((code, stdout, stderr)) = run_with_real_cjpeg(&[
        "--formats",
        "jpeg",
        "--lossless",
        "--target-size",
        "104857600",
    ]) else {
        return;
    };
    assert_eq!(code, Some(0), "stderr：{stderr}");
    assert_eq!(
        quality_columns(&stdout),
        ["70", "85", "100"],
        "目标 100GB 不可达，应回退最高质量点 q100 并补邻近点：{stdout}"
    );
    for line in stdout.lines().skip(1) {
        let note = line.split(',').nth(12).expect("note 列：{line}");
        assert!(note.contains("不可达") && note.contains("过大"), "note：{line}");
    }
}

#[test]
fn run_互斥参数同用_退出码2_用法错误() {
    let reference = sample("photo-ref.png").to_str().unwrap().to_string();
    let cases: [(&[&str], &str); 3] = [
        (
            &["--qualities", "75", "--baseline-quality", "75"],
            "--qualities 与 --baseline-quality",
        ),
        (
            &["--baseline-quality", "75", "--target-size", "200"],
            "--baseline-quality 与 --target-size",
        ),
        (
            &["--target-size", "200", "--qualities", "75"],
            "--target-size 与 --qualities",
        ),
    ];
    for (conflict_args, what) in cases {
        let output = Command::cargo_bin("pixel-arena-cli")
            .unwrap()
            .args(["run", "--reference", &reference])
            .args(conflict_args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{what} 互斥应为用法错误");
    }
}
