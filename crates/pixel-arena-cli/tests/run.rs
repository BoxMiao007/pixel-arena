// CLI run 子命令（一站式批量，T12）的黑盒测试：跑真实二进制，
// 只断言 stdout/stderr/退出码等外部行为，不钉内部实现。
//
// 分层策略（沿 T10/T11 先例，全部离线可跑）：
// - 无损 PNG 组不需要外部编码器：正常路径的主断言（CSV/JSON/产物落盘）用它做全链路验证；
// - 有损格式依赖编码器：用「预置桩编码器 + 哈希 sidecar」验证已装复用路径，
//   用「本地 HTTP 镜像服务 shared/encoders 工件」验证首次下载与下载失败路径；
// - 完整默认阶梯（15 项）依赖本机已装的真实编码器（T11 留下），未装则自动跳过。
// 样例图复用核心库黄金基准样例（crates/pixel-arena-core/tests/data/）。

use assert_cmd::Command;
use sha2::{Digest, Sha256};
use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

/// 黄金基准样例图路径。
fn sample(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pixel-arena-core/tests/data")
        .join(name)
}

/// 起一个把请求路径映射到目录内文件的本地 HTTP 服务器（镜像测试用），返回 base URL。
fn serve_dir(dir: &Path) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        head.extend_from_slice(&chunk[..n]);
                        if head.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            let request = String::from_utf8_lossy(&head);
            let file = request
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .trim_start_matches('/');
            match std::fs::read(dir.join(file)) {
                Ok(body) => {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&body);
                }
                Err(_) => {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
            let _ = stream.flush();
        }
    });
    format!("http://{addr}")
}

/// 预置一个桩 cwebp：复用检查只看「成员文件存在 + sidecar 哈希吻合」，
/// 桩被调用时把入库的真实 WebP 样例拷成产物，保证跑分环节能解码。
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
    let digest = format!("{:x}", Sha256::digest(std::fs::read(&encoder).unwrap()));
    std::fs::write(dir.join("cwebp.sha256"), digest).unwrap();
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

    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "一个档位应输出表头加一行，实际：{stdout}");
    assert_eq!(
        lines[0],
        "reference,candidate,format,quality,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio",
        "列 = score 现有列序 + format/quality 两列（T12 笔记登记，T13 以此为准）"
    );

    let fields: Vec<&str> = lines[1].split(',').collect();
    assert_eq!(fields.len(), 12, "每行 12 列，实际：{}", lines[1]);
    assert_eq!(fields[0], reference.to_str().unwrap(), "reference 列应原样回显传入路径");
    assert!(fields[1].ends_with("photo-ref-png.png"), "candidate 列应为产物路径：{}", fields[1]);
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
    assert!(row["candidate"].as_str().unwrap().ends_with("photo-ref-png.png"));
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
        out.path().join("photo-ref-png.png").exists(),
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
fn run_已装编码器直接复用_webp有损档_输出真实跑分行_无下载提示() {
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
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        !stderr.contains("正在下载编码器"),
        "已装编码器不应提示下载：{stderr}"
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<&str> = stdout.lines().nth(1).unwrap().split(',').collect();
    assert_eq!(fields[2], "webp", "format 列应为规范格式字符串");
    assert_eq!(fields[3], "60", "有损档质量列应为十进制整数：{stdout}");
    let psnr: f64 = fields[4].parse().unwrap_or_else(|_| panic!("psnr 应是数字，实际 {}", fields[4]));
    assert!(psnr.is_finite() && psnr > 0.0, "有损档 PSNR 应为有限正值，实际 {psnr}");
    assert!(
        out.path().join("photo-ref-q60.webp").exists(),
        "产物应按 <原图名>-q<质量>.<扩展名> 落在 --out 目录"
    );
}

// ---------- 有损格式：首次下载（本地镜像，不依赖外网） ----------

#[test]
fn run_首次使用自动下载_本地镜像_提示一次_二次直接复用() {
    let mirror_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../pixel-arena-shared/encoders");
    let Ok(mirror_root) = mirror_root.canonicalize() else {
        eprintln!("跳过：未找到 pixel-arena-shared/encoders 工件目录");
        return;
    };
    let base = serve_dir(&mirror_root);
    let tools = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let reference = sample("photo-ref.png");

    let run_once = || {
        Command::cargo_bin("pixel-arena-cli")
            .unwrap()
            .args([
                "run",
                "--reference",
                reference.to_str().unwrap(),
                "--formats",
                "jpeg",
                "--qualities",
                "75",
                "--out",
                out.path().to_str().unwrap(),
                "--tools-dir",
                tools.path().to_str().unwrap(),
            ])
            .env("PIXEL_ARENA_ENCODER_MIRROR", &base)
            .env_remove("HTTPS_PROXY")
            .env_remove("https_proxy")
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy")
            .output()
            .unwrap()
    };

    let first = run_once();
    assert_eq!(
        first.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let stderr = String::from_utf8(first.stderr).unwrap();
    assert!(
        stderr.contains("正在下载编码器") && stderr.contains("mozjpeg"),
        "首次使用应提示下载并点名编码器：{stderr}"
    );

    let second = run_once();
    assert_eq!(
        second.status.code(),
        Some(0),
        "stderr：{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let stderr = String::from_utf8(second.stderr).unwrap();
    assert!(
        !stderr.contains("正在下载编码器"),
        "已装后二次运行不应提示下载：{stderr}"
    );
    let stdout = String::from_utf8(second.stdout).unwrap();
    let fields: Vec<&str> = stdout.lines().nth(1).unwrap().split(',').collect();
    assert_eq!(fields[2], "jpeg");
    assert_eq!(fields[3], "75");
}

#[test]
fn run_镜像无工件下载失败_退出码1_中文报错_stdout空() {
    let empty = tempfile::tempdir().unwrap();
    let base = serve_dir(empty.path());
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
            "--lossless",
            "--tools-dir",
            tools.path().to_str().unwrap(),
        ])
        .env("PIXEL_ARENA_ENCODER_MIRROR", &base)
        .env_remove("HTTPS_PROXY")
        .env_remove("https_proxy")
        .env_remove("ALL_PROXY")
        .env_remove("all_proxy")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("正在下载编码器"), "下载前应提示：{stderr}");
    assert!(
        stderr.contains("下载编码器失败"),
        "下载失败应透传核心库中文错误：{stderr}"
    );
    assert!(output.stdout.is_empty(), "全部失败时 stdout 应为空");
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
    assert!(out.path().join("photo-ref-q60.jpg").exists());
    assert!(out.path().join("photo-ref-q90.avif").exists());
    assert!(out.path().join("photo-ref-jxllossless.jxl").exists());

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("（15/15）"), "生成进度应走到最后一项：{stderr}");
    assert!(!stderr.contains("正在下载编码器"), "本机已装不应提示下载：{stderr}");
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
