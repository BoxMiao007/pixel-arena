// CLI 入口：clap 解析参数，score 子命令对外部导入场景批量跑分，run 子命令跑一站式批量。
// stdout 只输出数据（CSV/JSON/HTML），进度与错误提示走 stderr（简体中文），方便管道。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use pixel_arena_core::encode::{encode_onestop, EncoderSource};
use pixel_arena_core::{score_images, CoreError};

#[derive(Parser)]
#[command(
    name = "pixel-arena-cli",
    version = pixel_arena_core::version(),
    about = "像素竞技场命令行：一行命令批量跑分"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 对一张原图与若干张跑分图计算质量指标与压缩效率，输出指标表。
    Score {
        /// 原图路径（画质与压缩效率的基准）。
        #[arg(long, value_name = "FILE")]
        reference: PathBuf,

        /// 跑分图路径，一张或多张。
        #[arg(long, value_name = "FILE", num_args = 1.., required = true)]
        candidates: Vec<PathBuf>,

        /// 输出格式，默认 csv（可选 json / html）。
        #[arg(long, value_enum, default_value_t = OutputFormat::Csv)]
        format: OutputFormat,
    },
    /// 对一张原图按编码阶梯（决策 0003）自动生成跑分图并跑分，输出指标表。
    Run {
        /// 原图路径（画质与压缩效率的基准）。
        #[arg(long, value_name = "FILE")]
        reference: PathBuf,

        /// 有损格式收窄（jpeg/webp/avif/jxl），默认全部；不带值表示不生成有损组。
        #[arg(long, value_name = "FORMAT", num_args = 0..)]
        formats: Option<Vec<String>>,

        /// 有损质量档收窄（1–100），默认 60 75 90，仅作用于有损格式。
        #[arg(long, value_name = "Q", num_args = 0..)]
        qualities: Option<Vec<String>>,

        /// 无损对照组收窄（png/webp-lossless/jxl-lossless），默认全部；不带值表示不生成无损组。
        #[arg(long, value_name = "FORMAT", num_args = 0..)]
        lossless: Option<Vec<String>>,

        /// 输出格式，默认 csv（可选 json / html）。
        #[arg(long, value_enum, default_value_t = OutputFormat::Csv)]
        format: OutputFormat,

        /// 产物目录（默认在系统临时目录新建 pixel-arena-run-*，路径见运行结束的 stderr 提示）。
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// 编码器安装目录（默认应用数据目录 tools/，与桌面应用共用；首次使用自动下载）。
        #[arg(long, value_name = "DIR")]
        tools_dir: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    Csv,
    Json,
    /// 自包含简体中文 HTML 报告（US30）：内联样式、含生成时间，浏览器直接打开。
    Html,
}

/// 指标表的一行：一张跑分图相对原图的结果。
struct ScoreRow {
    reference: String,
    candidate: String,
    psnr: f64,
    ssim: f64,
    ms_ssim: f64,
    butteraugli: f64,
    ssimulacra2: f64,
    reference_bytes: u64,
    candidate_bytes: u64,
    size_ratio: f64,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Score {
            reference,
            candidates,
            format,
        } => run_score(&reference, &candidates, format),
        Command::Run {
            reference,
            formats,
            qualities,
            lossless,
            format,
            out,
            tools_dir,
        } => run_run(&reference, formats, qualities, lossless, format, out, tools_dir),
    }
}

fn run_score(reference: &Path, candidates: &[PathBuf], format: OutputFormat) -> ExitCode {
    let reference_bytes = match std::fs::metadata(reference) {
        Ok(metadata) => metadata.len(),
        Err(source) => {
            return fail(&CoreError::Io {
                path: reference.to_path_buf(),
                source,
            });
        }
    };

    let total = candidates.len();
    let mut rows = Vec::with_capacity(total);
    for (index, candidate) in candidates.iter().enumerate() {
        eprintln!("正在跑分 {}/{}：{}", index + 1, total, candidate.display());

        let candidate_bytes = match std::fs::metadata(candidate) {
            Ok(metadata) => metadata.len(),
            Err(source) => {
                return fail(&CoreError::Io {
                    path: candidate.to_path_buf(),
                    source,
                });
            }
        };
        let metrics = match score_images(reference, candidate) {
            Ok(metrics) => metrics,
            Err(error) => return fail(&error),
        };
        rows.push(ScoreRow {
            reference: reference.display().to_string(),
            candidate: candidate.display().to_string(),
            psnr: metrics.psnr,
            ssim: metrics.ssim,
            ms_ssim: metrics.ms_ssim,
            butteraugli: metrics.butteraugli,
            ssimulacra2: metrics.ssimulacra2,
            reference_bytes,
            candidate_bytes,
            size_ratio: candidate_bytes as f64 / reference_bytes as f64,
        });
    }

    match format {
        OutputFormat::Csv => write_csv(&rows),
        OutputFormat::Json => write_json(&rows),
        OutputFormat::Html => write_html(&rows),
    }
    ExitCode::SUCCESS
}

/// 运行期错误：中文提示走 stderr，退出码 1（用法错误由 clap 退出 2）。
fn fail(error: &CoreError) -> ExitCode {
    eprintln!("错误：{error}");
    ExitCode::from(1)
}

fn write_csv(rows: &[ScoreRow]) {
    // CSV 输出以 UTF-8 BOM 开头（票 18）：重定向到文件后 Excel 中文环境按 ANSI
    // 解析无 BOM 的 UTF-8 会乱码；JSON/HTML 不加（非 CSV 约定）
    print!("\u{FEFF}");
    println!(
        "reference,candidate,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio"
    );
    for row in rows {
        println!(
            "{},{},{},{},{},{},{},{},{},{}",
            csv_field(&row.reference),
            csv_field(&row.candidate),
            metric_text(row.psnr),
            metric_text(row.ssim),
            metric_text(row.ms_ssim),
            metric_text(row.butteraugli),
            metric_text(row.ssimulacra2),
            row.reference_bytes,
            row.candidate_bytes,
            metric_text(row.size_ratio),
        );
    }
}

/// JSON 输出：字段名与 CSV 表头一致。指标为无穷大时写为字符串 "inf"、
/// NaN 时写为 "nan"（serde_json 无法序列化非有限数，统一哨兵见 metric_text），
/// 其余为数字、全精度。
fn write_json(rows: &[ScoreRow]) {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "reference": row.reference,
                "candidate": row.candidate,
                "psnr": metric_value(row.psnr),
                "ssim": metric_value(row.ssim),
                "ms_ssim": metric_value(row.ms_ssim),
                "butteraugli": metric_value(row.butteraugli),
                "ssimulacra2": metric_value(row.ssimulacra2),
                "reference_bytes": row.reference_bytes,
                "candidate_bytes": row.candidate_bytes,
                "size_ratio": metric_value(row.size_ratio),
            })
        })
        .collect();
    let document = serde_json::Value::Array(items);
    println!(
        "{}",
        serde_json::to_string_pretty(&document).expect("ScoreRow 序列化不应失败")
    );
}

/// 单个指标值转 JSON：无穷大写作字符串 "inf"，NaN 写作 "nan"，其余为数字。
fn metric_value(value: f64) -> serde_json::Value {
    if value.is_nan() {
        serde_json::json!("nan")
    } else if value.is_infinite() {
        serde_json::json!("inf")
    } else {
        serde_json::json!(value)
    }
}

/// CSV 字段转义：含逗号、引号或换行时加引号并把内部引号翻倍（RFC 4180）。
fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 指标数值的文本表示：无穷大（两图逐像素一致时 PSNR）写作 "inf"，NaN 写作
/// "nan"（防 serde_json 静默变 null 的同类问题），其余定点 6 位小数。
/// 该哨兵是 CSV 与 JSON 的统一约定。
fn metric_text(value: f64) -> String {
    if value.is_nan() {
        "nan".to_string()
    } else if value.is_infinite() {
        "inf".to_string()
    } else {
        format!("{value:.6}")
    }
}

// ---------- HTML 输出（--format html，规格 US30）：自包含简体中文报告 ----------

/// 报告共用内联样式（核心库 report.rs 同款精简版，无外部资源引用）。
const HTML_CSS: &str = "body { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif; margin: 24px auto; max-width: 1100px; color: #1f2328; padding: 0 16px; } h1 { font-size: 20px; margin-bottom: 4px; } .meta { color: #57606a; font-size: 13px; margin: 4px 0; } table { border-collapse: collapse; font-size: 13px; width: 100%; margin-top: 8px; } th, td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; } th { background: #f6f8fa; } code { font-size: 12px; color: #57606a; word-break: break-all; }";

/// HTML 转义（& < > "），防路径里的特殊字符破坏文档结构。
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 路径的文件名（报告里显示名）。
fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// 界面同款文件大小格式（核心库 report.rs 对齐实现）。
fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// HTML 显示口径的指标：无穷大显示 ∞（两图逐像素一致），≥10 两位小数、小值四位
/// （与 GUI 结果表和导出报告一致；CSV/JSON 的 inf/nan 哨兵仅供程序读）。
fn html_metric(value: f64) -> String {
    if value.is_nan() {
        "nan".to_string()
    } else if value.is_infinite() {
        "∞".to_string()
    } else if value.abs() >= 10.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.4}")
    }
}

/// 当前时间的报告用文本（UTC，YYYY-MM-DD HH:MM:SS）。CLI 不引时间库，
/// 手写 Unix 秒 → 公历换算（Howard Hinnant civil_from_days 算法）。
fn utc_now_text() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970 年")
        .as_secs();
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 自包含 HTML 骨架：标题、生成时间等元信息与表格正文拼装。
fn html_document(meta: &str, table: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n\
         <title>像素竞技场 · 跑分报告</title>\n<style>{HTML_CSS}</style>\n</head>\n<body>\n\
         <h1>像素竞技场跑分报告</h1>\n<p class=\"meta\">{meta}</p>\n{table}\n\
         <p class=\"meta\">由像素竞技场 CLI 生成；指标无穷大（两图逐像素一致时 PSNR 等）显示 ∞。</p>\n</body>\n</html>\n"
    )
}

/// score 结果的 HTML 输出：自包含中文报告，原图入元信息行，逐行一张跑分图。
fn write_html(rows: &[ScoreRow]) {
    let generated_at = utc_now_text();
    let mut table = String::from(
        "<table>\n<thead><tr><th>跑分图</th><th>路径</th><th>PSNR</th><th>SSIM</th>\
         <th>MS-SSIM</th><th>Butteraugli</th><th>SSIMULACRA2</th><th>原图大小</th>\
         <th>跑分图大小</th><th>体积比</th></tr></thead>\n<tbody>\n",
    );
    for row in rows {
        table.push_str(&format!(
            "<tr><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>\n",
            html_escape(&file_name(&row.candidate)),
            html_escape(&row.candidate),
            html_metric(row.psnr),
            html_metric(row.ssim),
            html_metric(row.ms_ssim),
            html_metric(row.butteraugli),
            html_metric(row.ssimulacra2),
            format_size(row.reference_bytes),
            format_size(row.candidate_bytes),
            html_metric(row.size_ratio),
        ));
    }
    table.push_str("</tbody>\n</table>\n");
    println!(
        "{}",
        html_document(
            &format!(
                "生成时间：{generated_at}　模式：外部导入跑分　原图：<code>{}</code>",
                html_escape(&rows.first().map(|r| r.reference.as_str()).unwrap_or(""))
            ),
            &table
        )
    );
}

// ---------- run 子命令（一站式批量，与 GUI 共用 encode_onestop + score_images） ----------

/// 默认有损格式（决策 0003 编码阶梯，顺序即生成顺序，与前端 onestop.ts 一致）。
const LOSSY_FORMATS: [&str; 4] = ["jpeg", "webp", "avif", "jxl"];

/// 默认质量档（仅作用于有损格式）。
const DEFAULT_QUALITIES: [u8; 3] = [60, 75, 90];

/// 默认无损对照组（核心库保证像素逐位一致）。
const LOSSLESS_FORMATS: [&str; 3] = ["png", "webp-lossless", "jxl-lossless"];

/// 编码阶梯的一项：一个待生成并跑分的档位。
struct LadderItem {
    /// 传给核心库的规范格式字符串。
    format: String,
    /// 无损组为 None。
    quality: Option<u8>,
    /// 进度文本用显示名，如「JPEG q60」「无损 WebP」。
    label: String,
}

/// 一站式结果表的一行：一个档位的产物相对原图的跑分结果。
struct RunRow {
    reference: String,
    candidate: String,
    format: String,
    /// 无损组为 None（CSV 写 lossless，JSON 写 null）。
    quality: Option<u8>,
    psnr: f64,
    ssim: f64,
    ms_ssim: f64,
    butteraugli: f64,
    ssimulacra2: f64,
    reference_bytes: u64,
    candidate_bytes: u64,
    size_ratio: f64,
}

/// 格式的进度显示名：委托核心库 OnestopFormat::display_name（单一来源，
/// 与前端 onestop.ts 的映射需人工同步）。
fn format_label(format: &str) -> &'static str {
    pixel_arena_core::encode::OnestopFormat::parse(format)
        .expect("build_ladder 已校验格式")
        .display_name()
}

/// 去重且保持首次出现顺序（用户重复选择同一格式/档位时按一项处理）。
fn dedup(values: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

/// 展开编码阶梯：先有损（格式 × 质量档），后无损组；与前端 buildLadder 同序。
/// 收窄参数 None = 该组取默认全选，Some(空) = 该组不跑；非法值 fail-fast 中文报错。
fn build_ladder(
    formats: Option<Vec<String>>,
    qualities: Option<Vec<String>>,
    lossless: Option<Vec<String>>,
) -> Result<Vec<LadderItem>, String> {
    let formats = dedup(
        formats.unwrap_or_else(|| LOSSY_FORMATS.iter().map(|s| s.to_string()).collect()),
    );
    let qualities = dedup(
        qualities.unwrap_or_else(|| DEFAULT_QUALITIES.iter().map(|q| q.to_string()).collect()),
    );
    let lossless = dedup(
        lossless.unwrap_or_else(|| LOSSLESS_FORMATS.iter().map(|s| s.to_string()).collect()),
    );

    // 质量档先解析校验（启动任何编码器之前 fail-fast）
    let mut quality_values = Vec::with_capacity(qualities.len());
    for raw in &qualities {
        let parsed: u8 = raw
            .parse()
            .map_err(|_| format!("质量 {raw} 无效，有效范围 1–100"))?;
        if parsed == 0 || parsed > 100 {
            return Err(format!("质量 {parsed} 无效，有效范围 1–100"));
        }
        quality_values.push(parsed);
    }

    // 格式名先过核心库解析（未知格式的中文文案以核心库为准），再核对组别归属
    for raw in formats.iter().chain(lossless.iter()) {
        pixel_arena_core::encode::OnestopFormat::parse(raw).map_err(|error| error.to_string())?;
    }
    for raw in &formats {
        if !LOSSY_FORMATS.contains(&raw.as_str()) {
            return Err(format!("{raw} 是无损格式，请改用 --lossless 选择"));
        }
    }
    for raw in &lossless {
        if !LOSSLESS_FORMATS.contains(&raw.as_str()) {
            return Err(format!("{raw} 是有损格式，请改用 --formats 选择"));
        }
    }

    let mut ladder = Vec::new();
    for format in &formats {
        for quality in &quality_values {
            ladder.push(LadderItem {
                format: format.clone(),
                quality: Some(*quality),
                label: format!("{} q{quality}", format_label(format)),
            });
        }
    }
    for format in &lossless {
        ladder.push(LadderItem {
            format: format.clone(),
            quality: None,
            label: format_label(format).to_string(),
        });
    }
    if ladder.is_empty() {
        return Err("没有可生成的档位：请至少选择一个有损格式（--formats）或无损格式（--lossless）"
            .to_string());
    }
    Ok(ladder)
}

/// 格式 → 编码器来源与所需成员（PNG 走进程内编码，无外部编码器）。
/// 仅用于「正在下载编码器」预告；真正的下载/复用由核心库 encode_onestop 内部完成。
fn encoder_source_for(format: &str) -> Option<(EncoderSource, Vec<&'static str>)> {
    use pixel_arena_core::encode::{avif_source, jxl_source, mozjpeg_source, webp_source};
    match format {
        "jpeg" => mozjpeg_source().ok().map(|source| (source, vec!["cjpeg"])),
        "webp" | "webp-lossless" => webp_source().ok().map(|source| (source, vec!["cwebp"])),
        "avif" => avif_source()
            .ok()
            .map(|source| (source, vec!["avifenc", "avifdec"])),
        "jxl" | "jxl-lossless" => jxl_source().ok().map(|source| (source, vec!["cjxl"])),
        _ => None,
    }
}

/// 编码器安装目录默认值：与桌面端共用（Tauri app_data_dir + tools/，见 src-tauri/src/lib.rs）。
/// Linux $XDG_DATA_HOME（缺省 ~/.local/share）、macOS ~/Library/Application Support、
/// Windows %APPDATA%，拼上应用标识 io.github.boxmiao007.pixelarena。
fn default_tools_dir() -> Option<PathBuf> {
    let identifier = "io.github.boxmiao007.pixelarena";
    let base = match std::env::consts::OS {
        "linux" => std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))?,
        "macos" => PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support"),
        "windows" => PathBuf::from(std::env::var_os("APPDATA")?),
        _ => return None,
    };
    Some(base.join(identifier).join("tools"))
}

fn run_run(
    reference: &Path,
    formats: Option<Vec<String>>,
    qualities: Option<Vec<String>>,
    lossless: Option<Vec<String>>,
    format: OutputFormat,
    out: Option<PathBuf>,
    tools_dir: Option<PathBuf>,
) -> ExitCode {
    // 原图先于一切校验：最基础的输入错了，后面都不用做
    let reference_bytes = match std::fs::metadata(reference) {
        Ok(metadata) => metadata.len(),
        Err(source) => {
            return fail(&CoreError::Io {
                path: reference.to_path_buf(),
                source,
            });
        }
    };

    let ladder = match build_ladder(formats, qualities, lossless) {
        Ok(ladder) => ladder,
        Err(message) => return fail_message(&message),
    };

    let tools_dir = match tools_dir {
        Some(dir) => dir,
        None => match default_tools_dir() {
            Some(dir) => dir,
            None => {
                return fail_message(
                    "无法确定编码器安装目录（缺少 HOME/APPDATA 等环境变量），请用 --tools-dir 指定",
                );
            }
        },
    };

    // AVIF 产物的解码/代片要 avifdec：CLI 与桌面端同一约定，从工具目录推导注入
    //（已设置时尊重调用方覆盖，见 examples/onestop_sample.rs）
    if std::env::var_os("PIXEL_ARENA_AVIFDEC").is_none() {
        if let Some(decoder) = pixel_arena_core::decode::avif_decoder_path(&tools_dir) {
            std::env::set_var("PIXEL_ARENA_AVIFDEC", decoder);
        }
    }

    let output_dir = match out {
        Some(dir) => dir,
        None => std::env::temp_dir().join(format!(
            "pixel-arena-run-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时钟早于 1970 年")
                .as_nanos()
        )),
    };
    if let Err(source) = std::fs::create_dir_all(&output_dir) {
        return fail(&CoreError::Io {
            path: output_dir.clone(),
            source,
        });
    }

    // 生成阶段：沿用桌面端一站式语义，单项失败继续其余档位，结束统一结算
    let mut products: Vec<(String, String, Option<u8>, PathBuf)> = Vec::new();
    let mut any_failed = false;
    let mut first_error: Option<String> = None;
    let mut announced: Vec<String> = Vec::new();
    for (index, item) in ladder.iter().enumerate() {
        // 编码器首次使用预告：成员文件缺失即会触发下载（每个编码器只提示一次）
        if let Some((source, members)) = encoder_source_for(&item.format) {
            if !announced.contains(&source.name) {
                announced.push(source.name.clone());
                let installed = members.iter().all(|member| {
                    tools_dir
                        .join(&source.name)
                        .join(&source.version)
                        .join(member)
                        .is_file()
                });
                if !installed {
                    eprintln!("正在下载编码器 {}…", source.name);
                }
            }
        }
        eprintln!("正在生成 {}（{}/{}）", item.label, index + 1, ladder.len());
        match encode_onestop(reference, &item.format, item.quality, &output_dir, &tools_dir) {
            Ok(product) => products.push((
                item.label.clone(),
                item.format.clone(),
                item.quality,
                product,
            )),
            Err(error) => {
                eprintln!("生成失败：{}：{error}", item.label);
                any_failed = true;
                first_error.get_or_insert_with(|| error.to_string());
            }
        }
    }

    // 跑分阶段：始终用产物本身（AVIF/JXL 的 PNG 代片只供查看器显示）
    let mut rows: Vec<RunRow> = Vec::with_capacity(products.len());
    let total = products.len();
    for (index, (_, item_format, quality, product)) in products.iter().enumerate() {
        eprintln!("正在跑分 {}/{}：{}", index + 1, total, product.display());
        let candidate_bytes = match std::fs::metadata(product) {
            Ok(metadata) => metadata.len(),
            Err(source) => {
                eprintln!("跑分失败：{}：{source}", product.display());
                any_failed = true;
                first_error
                    .get_or_insert_with(|| format!("无法读取产物 {}：{source}", product.display()));
                continue;
            }
        };
        match score_images(reference, product) {
            Ok(metrics) => rows.push(RunRow {
                reference: reference.display().to_string(),
                candidate: product.display().to_string(),
                format: item_format.clone(),
                quality: *quality,
                psnr: metrics.psnr,
                ssim: metrics.ssim,
                ms_ssim: metrics.ms_ssim,
                butteraugli: metrics.butteraugli,
                ssimulacra2: metrics.ssimulacra2,
                reference_bytes,
                candidate_bytes,
                size_ratio: candidate_bytes as f64 / reference_bytes as f64,
            }),
            Err(error) => {
                eprintln!("跑分失败：{}：{error}", product.display());
                any_failed = true;
                first_error.get_or_insert_with(|| error.to_string());
            }
        }
    }

    eprintln!("产物目录：{}", output_dir.display());

    if any_failed && rows.is_empty() {
        // 无可用结果：沿用 score 子命令约定，stdout 保持纯数据（空）
        eprintln!(
            "错误：{}",
            first_error.expect("any_failed 为真时必有首个错误")
        );
        return ExitCode::from(1);
    }
    match format {
        OutputFormat::Csv => write_run_csv(&rows),
        OutputFormat::Json => write_run_json(&rows),
        OutputFormat::Html => write_run_html(&rows),
    }
    if any_failed {
        // 部分失败：成功档位的结果照常输出（下游可拿到部分数据），退出码 1 提示结果不完整
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

/// 用法之外的值/运行期错误：中文提示走 stderr，退出码 1。
fn fail_message(message: &str) -> ExitCode {
    eprintln!("错误：{message}");
    ExitCode::from(1)
}

/// 无损组质量列的 CSV 文本（JSON 侧为 null，见 write_run_json）。
fn run_quality_text(quality: Option<u8>) -> String {
    quality
        .map(|q| q.to_string())
        .unwrap_or_else(|| "lossless".to_string())
}

/// run 结果的 CSV 输出：列 = score 现有列序 + format/quality 两列（插在 candidate 之后）。
fn write_run_csv(rows: &[RunRow]) {
    // 与 score 的 CSV 同约定：UTF-8 BOM 开头（票 18，见 write_csv 注释）
    print!("\u{FEFF}");
    println!(
        "reference,candidate,format,quality,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio"
    );
    for row in rows {
        println!(
            "{},{},{},{},{},{},{},{},{},{},{},{}",
            csv_field(&row.reference),
            csv_field(&row.candidate),
            csv_field(&row.format),
            csv_field(&run_quality_text(row.quality)),
            metric_text(row.psnr),
            metric_text(row.ssim),
            metric_text(row.ms_ssim),
            metric_text(row.butteraugli),
            metric_text(row.ssimulacra2),
            row.reference_bytes,
            row.candidate_bytes,
            metric_text(row.size_ratio),
        );
    }
}

/// run 结果的 JSON 输出：字段名与 CSV 表头一致；quality 无损组为 null；
/// 指标无穷大写作字符串 "inf"、NaN 写作 "nan"（哨兵与 score 子命令一致）。
fn write_run_json(rows: &[RunRow]) {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "reference": row.reference,
                "candidate": row.candidate,
                "format": row.format,
                "quality": row.quality,
                "psnr": metric_value(row.psnr),
                "ssim": metric_value(row.ssim),
                "ms_ssim": metric_value(row.ms_ssim),
                "butteraugli": metric_value(row.butteraugli),
                "ssimulacra2": metric_value(row.ssimulacra2),
                "reference_bytes": row.reference_bytes,
                "candidate_bytes": row.candidate_bytes,
                "size_ratio": metric_value(row.size_ratio),
            })
        })
        .collect();
    let document = serde_json::Value::Array(items);
    println!(
        "{}",
        serde_json::to_string_pretty(&document).expect("RunRow 序列化不应失败")
    );
}

/// run 结果的 HTML 输出：score 同款自包含中文报告，另加格式/质量两列
/// （质量无损组显示「无损」，CSV/JSON 里是 lossless/null）。
fn write_run_html(rows: &[RunRow]) {
    let generated_at = utc_now_text();
    let mut table = String::from(
        "<table>\n<thead><tr><th>跑分图</th><th>路径</th><th>格式</th><th>质量</th><th>PSNR</th>\
         <th>SSIM</th><th>MS-SSIM</th><th>Butteraugli</th><th>SSIMULACRA2</th><th>原图大小</th>\
         <th>跑分图大小</th><th>体积比</th></tr></thead>\n<tbody>\n",
    );
    for row in rows {
        let quality = row
            .quality
            .map(|q| q.to_string())
            .unwrap_or_else(|| "无损".to_string());
        table.push_str(&format!(
            "<tr><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>\n",
            html_escape(&file_name(&row.candidate)),
            html_escape(&row.candidate),
            html_escape(&row.format),
            html_escape(&quality),
            html_metric(row.psnr),
            html_metric(row.ssim),
            html_metric(row.ms_ssim),
            html_metric(row.butteraugli),
            html_metric(row.ssimulacra2),
            format_size(row.reference_bytes),
            format_size(row.candidate_bytes),
            html_metric(row.size_ratio),
        ));
    }
    table.push_str("</tbody>\n</table>\n");
    println!(
        "{}",
        html_document(
            &format!(
                "生成时间：{generated_at}　模式：一站式批量跑分　原图：<code>{}</code>",
                html_escape(&rows.first().map(|r| r.reference.as_str()).unwrap_or(""))
            ),
            &table
        )
    );
}
