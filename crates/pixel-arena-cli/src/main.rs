// CLI 入口：clap 解析参数，score 子命令对外部导入场景批量跑分，run 子命令跑一站式批量。
// stdout 只输出数据（CSV/JSON/HTML），进度与错误提示走 stderr（简体中文），方便管道。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use pixel_arena_core::encode::{encode_onestop, probe_onestop_size, EncoderOverrides, EncoderSource, OnestopFormat};
use pixel_arena_core::ladder::{quality_ladder, size_search, LadderItem, LOSSLESS_FORMATS, LOSSY_FORMATS};
use pixel_arena_core::parallel::{concurrency_limit, logical_cores, run_parallel};
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

        /// 并行跑分线程数，默认 = 逻辑核数的一半（与桌面应用默认一致），传入值夹在 [1, 逻辑核数]。
        #[arg(long, value_name = "N")]
        concurrency: Option<usize>,
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

        /// 基准质量（0–100，质量优先模式）：在基准附近自动取点，每个有损格式至少
        /// 3 个质量点 + 无损对照组；不传时基准取 75（输出与默认阶梯完全一致）。
        #[arg(long, value_name = "Q", conflicts_with_all = ["qualities", "target_size"])]
        baseline_quality: Option<u8>,

        /// 目标大小（KB，大小优先模式）：每个有损格式自动搜索逼近该大小，
        /// 不可达时取最接近点并在 note 列标注；无损对照组照常生成。
        #[arg(long, value_name = "KB", conflicts_with_all = ["qualities"])]
        target_size: Option<u64>,

        /// 输出格式，默认 csv（可选 json / html）。
        #[arg(long, value_enum, default_value_t = OutputFormat::Csv)]
        format: OutputFormat,

        /// 产物目录（默认在系统临时目录新建 pixel-arena-run-*，路径见运行结束的 stderr 提示）。
        #[arg(long, value_name = "DIR")]
        out: Option<PathBuf>,

        /// 编码器安装目录（默认应用数据目录 tools/，与桌面应用共用；首次使用自动下载）。
        #[arg(long, value_name = "DIR")]
        tools_dir: Option<PathBuf>,

        /// 并行跑分线程数，默认 = 逻辑核数的一半（与桌面应用默认一致），传入值夹在 [1, 逻辑核数]。
        #[arg(long, value_name = "N")]
        concurrency: Option<usize>,
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
            concurrency,
        } => run_score(&reference, &candidates, format, concurrency),
        Command::Run {
            reference,
            formats,
            qualities,
            lossless,
            baseline_quality,
            target_size,
            format,
            out,
            tools_dir,
            concurrency,
        } => run_run(RunArgs {
            reference,
            formats,
            qualities,
            lossless,
            baseline_quality,
            target_size,
            format,
            out,
            tools_dir,
            concurrency,
        }),
    }
}

/// 并行跑分的线程上限：未传时取半核（决策 0018 的默认档），显式值夹在
/// [1, 逻辑核数]——夹制而非报错，脚本里按机器规格传大值也能跑。
fn resolve_concurrency(explicit: Option<usize>) -> usize {
    match explicit {
        None => concurrency_limit(0.5),
        Some(value) => value.clamp(1, logical_cores()),
    }
}

fn run_score(
    reference: &Path,
    candidates: &[PathBuf],
    format: OutputFormat,
    concurrency: Option<usize>,
) -> ExitCode {
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
    // 并行跑分（决策 0018 的 run_parallel，结果保序）：串行版的「遇错即停」变为
    // 跑完统一结算，错误仍取输入顺序里的第一张坏图，stdout 保持失败时不输出数据
    let results = run_parallel(
        candidates,
        resolve_concurrency(concurrency),
        |candidate| {
            let candidate_bytes = match std::fs::metadata(candidate) {
                Ok(metadata) => metadata.len(),
                Err(source) => {
                    return Err(CoreError::Io {
                        path: candidate.to_path_buf(),
                        source,
                    });
                }
            };
            let metrics = score_images(reference, candidate)?;
            Ok(ScoreRow {
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
            })
        },
        |done| eprintln!("正在跑分 {done}/{total}…"),
    );
    let mut rows = Vec::with_capacity(total);
    for result in results {
        match result {
            Ok(row) => rows.push(row),
            Err(error) => return fail(&error),
        }
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

// ---------- run 子命令（一站式批量，与 GUI 共用核心库取点 + encode_onestop + score_images） ----------

/// 阶梯模式（T21 单源化）：取点逻辑全部来自核心库 ladder 模块，CLI 只做参数收窄与编排。
/// 互斥组合已由 clap 拒绝（退出码 2），这里只做剩余取值校验。
enum LadderMode {
    /// 质量优先：统一基准 0–100 自动取点（默认 75，输出与现行默认阶梯完全一致）。
    Baseline(u8),
    /// 显式质量枚举（--qualities，既有行为：只生成列出的档位，不做自动取点）。
    Explicit(Vec<u8>),
    /// 大小优先：目标字节数（--target-size，KB × 1024）。
    TargetSize(u64),
}

fn resolve_ladder_mode(
    qualities: Option<Vec<String>>,
    baseline_quality: Option<u8>,
    target_size: Option<u64>,
) -> Result<LadderMode, String> {
    if let Some(kb) = target_size {
        // KB → 字节；超大输入饱和处理而非溢出 panic
        return Ok(LadderMode::TargetSize(kb.saturating_mul(1024)));
    }
    if let Some(baseline) = baseline_quality {
        if baseline > 100 {
            return Err(format!("基准质量 {baseline} 无效，有效范围 0–100"));
        }
        return Ok(LadderMode::Baseline(baseline));
    }
    match qualities {
        Some(list) => Ok(LadderMode::Explicit(parse_quality_list(&list)?)),
        // 默认 = 质量优先基准 75（核心库取点与决策 0003 的 60/75/90 完全一致）
        None => Ok(LadderMode::Baseline(75)),
    }
}

/// 质量档列表解析（--qualities 显式枚举）：1–100，非法值中文报错（沿用既有文案）。
fn parse_quality_list(raw: &[String]) -> Result<Vec<u8>, String> {
    let mut values = Vec::with_capacity(raw.len());
    for value in dedup(raw.to_vec()) {
        let parsed: u8 = value
            .parse()
            .map_err(|_| format!("质量 {value} 无效，有效范围 1–100"))?;
        if parsed == 0 || parsed > 100 {
            return Err(format!("质量 {parsed} 无效，有效范围 1–100"));
        }
        values.push(parsed);
    }
    Ok(values)
}

/// 收窄参数解析（--formats / --lossless）：None = 该组默认全选；出现但不带值 = 该组不跑；
/// 值逐个过核心库解析（未知格式的中文文案以核心库为准），选错组提示改用对应参数。
fn parse_format_selection(
    raw: Option<Vec<String>>,
    canonical: &[OnestopFormat],
) -> Result<Vec<OnestopFormat>, String> {
    let Some(values) = raw else {
        return Ok(canonical.to_vec());
    };
    if values.is_empty() {
        return Ok(Vec::new());
    }
    let mut selected: Vec<OnestopFormat> = Vec::new();
    for value in dedup(values) {
        let format = OnestopFormat::parse(&value).map_err(|error| error.to_string())?;
        if !canonical.contains(&format) {
            return Err(if LOSSLESS_FORMATS.contains(&format) {
                format!("{value} 是无损格式，请改用 --lossless 选择")
            } else {
                format!("{value} 是有损格式，请改用 --formats 选择")
            });
        }
        selected.push(format);
    }
    Ok(selected)
}

/// 编码器首次使用预告（大小优先搜索与正式生成前都会调用；每个编码器只提示一次）。
fn announce_encoder_download(item_format: &str, tools_dir: &Path, announced: &mut Vec<String>) {
    if let Some((source, members)) = encoder_source_for(item_format) {
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
}

/// 展开编码阶梯：取点数据源 = 核心库 ladder 模块（单一实现，GUI 目录同源）。
fn build_run_ladder(
    mode: &LadderMode,
    lossy_sel: &[OnestopFormat],
    lossless_sel: &[OnestopFormat],
    reference: &Path,
    tools_dir: &Path,
    announced: &mut Vec<String>,
) -> Result<BuiltLadder, String> {
    let mut ladder: Vec<LadderItem> = Vec::new();
    let mut notes = std::collections::HashMap::new();
    let mut any_failed = false;

    match mode {
        LadderMode::Baseline(baseline) => {
            // 单一来源：核心库质量优先取点（基准 75 = 决策 0003 默认阶梯），按收窄参数过滤。
            // 只保有损项——无损对照组由下方公共循环统一追加，避免重复。
            for item in quality_ladder(*baseline).map_err(|error| error.to_string())? {
                let keep = match item.quality {
                    Some(_) => lossy_sel.iter().any(|f| f.as_str() == item.format),
                    None => false,
                };
                if keep {
                    ladder.push(item);
                }
            }
        }
        LadderMode::Explicit(quality_values) => {
            // 既有行为：用户点名的质量档直接枚举（格式 × 质量），不走自动取点
            for format in lossy_sel {
                for quality in quality_values {
                    ladder.push(LadderItem::new(*format, Some(*quality)));
                }
            }
        }
        LadderMode::TargetSize(target_bytes) => {
            // 大小优先（US21-23）：每格式自动搜索逼近目标；探测产物落暂存目录即弃
            eprintln!("大小优先模式：目标 {} 字节", target_bytes);
            let scratch = tempfile::tempdir()
                .map_err(|error| format!("无法创建探测暂存目录：{error}"))?;
            for format in lossy_sel {
                announce_encoder_download(format.as_str(), tools_dir, announced);
                eprintln!("正在搜索 {} 逼近目标大小…", format.display_name());
                let result = size_search(*format, *target_bytes, &mut |quality| {
                    // CLI 不读 GUI 设置：覆盖恒为默认值，探测与正式生成同一约定
                    probe_onestop_size(
                        reference,
                        *format,
                        quality,
                        scratch.path(),
                        tools_dir,
                        &EncoderOverrides::default(),
                    )
                });
                match result {
                    Ok(result) => {
                        if let Some(note) = result.annotation_note() {
                            eprintln!("标注：{}：{note}", format.display_name());
                            notes.insert(format.as_str().to_string(), note);
                        }
                        // 命中点 + 邻近补点全部入阶梯（率失真样本 ≥3，US23）
                        for point in &result.points {
                            ladder.push(LadderItem::new(*format, Some(point.quality)));
                        }
                    }
                    Err(error) => {
                        // 搜索失败 = 该格式整体失败，继续其余格式（沿用逐档失败语义）
                        eprintln!("生成失败：{}：{error}", format.display_name());
                        any_failed = true;
                    }
                }
            }
        }
    }

    // 无损对照组：三种模式一致（大小优先下无损产物大小固定，不参与搜索）
    for format in lossless_sel {
        ladder.push(LadderItem::new(*format, None));
    }
    Ok(BuiltLadder {
        items: ladder,
        notes,
        any_failed,
    })
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
    /// 大小优先模式的不可达标注（US22：不可达时结果不骗人）；其余模式为 None。
    note: Option<String>,
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

/// run 子命令的 clap 解析结果（审查修复 C11：摊平的 9 个参数捆成一组传递）。
struct RunArgs {
    reference: PathBuf,
    formats: Option<Vec<String>>,
    qualities: Option<Vec<String>>,
    lossless: Option<Vec<String>>,
    baseline_quality: Option<u8>,
    target_size: Option<u64>,
    format: OutputFormat,
    out: Option<PathBuf>,
    tools_dir: Option<PathBuf>,
    concurrency: Option<usize>,
}

/// [`build_run_ladder`] 的返回（阶梯 + 大小优先标注 + 失败标记，不再走三元组）。
struct BuiltLadder {
    items: Vec<LadderItem>,
    /// 大小优先不可达标注：格式 → 文本（与 CLI note 列同源）。
    notes: std::collections::HashMap<String, String>,
    any_failed: bool,
}

fn run_run(args: RunArgs) -> ExitCode {
    let RunArgs {
        reference,
        formats,
        qualities,
        lossless,
        baseline_quality,
        target_size,
        format,
        out,
        tools_dir,
        concurrency,
    } = args;
    // 原图先于一切校验：最基础的输入错了，后面都不用做
    let reference_bytes = match std::fs::metadata(&reference) {
        Ok(metadata) => metadata.len(),
        Err(source) => {
            return fail(&CoreError::Io {
                path: reference.clone(),
                source,
            });
        }
    };

    // 模式与收窄解析：全部是纯校验，fail-fast 在任何编码动作之前
    let mode = match resolve_ladder_mode(qualities, baseline_quality, target_size) {
        Ok(mode) => mode,
        Err(message) => return fail_message(&message),
    };
    let lossy_sel = match parse_format_selection(formats, &LOSSY_FORMATS) {
        Ok(selected) => selected,
        Err(message) => return fail_message(&message),
    };
    let lossless_sel = match parse_format_selection(lossless, &LOSSLESS_FORMATS) {
        Ok(selected) => selected,
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

    // 阶梯构建：大小优先模式在此完成逼近搜索（探测 = 真实编码，标注/失败在此结算）
    let mut announced: Vec<String> = Vec::new();
    let BuiltLadder {
        items: ladder,
        notes,
        mut any_failed,
    } = match build_run_ladder(&mode, &lossy_sel, &lossless_sel, &reference, &tools_dir, &mut announced)
    {
        Ok(built) => built,
        Err(message) => return fail_message(&message),
    };
    let mut first_error: Option<String> = None;
    let size_mode = matches!(mode, LadderMode::TargetSize(_));
    if ladder.is_empty() && !any_failed {
        return fail_message(
            "没有可生成的档位：请至少选择一个有损格式（--formats）或无损格式（--lossless）",
        );
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
    let mut products: Vec<(String, String, Option<u8>, Option<String>, PathBuf)> = Vec::new();
    for (index, item) in ladder.iter().enumerate() {
        // 编码器首次使用预告：成员文件缺失即会触发下载（每个编码器只提示一次）
        announce_encoder_download(&item.format, &tools_dir, &mut announced);
        eprintln!("正在生成 {}（{}/{}）", item.label, index + 1, ladder.len());
        // CLI 行为只由命令行参数决定，不读 GUI 设置：编码器覆盖恒为空（T23）
        match encode_onestop(
            &reference,
            &item.format,
            item.quality,
            &output_dir,
            &tools_dir,
            &EncoderOverrides::default(),
        ) {
            Ok(product) => products.push((
                item.label.clone(),
                item.format.clone(),
                item.quality,
                notes.get(&item.format).cloned(),
                product,
            )),
            Err(error) => {
                eprintln!("生成失败：{}：{error}", item.label);
                any_failed = true;
                first_error.get_or_insert_with(|| error.to_string());
            }
        }
    }

    // 跑分阶段：始终用产物本身（AVIF/JXL 的 PNG 代片只供查看器显示）。
    // 并行调度（run_parallel 保序）：单项失败不中断其余，结算按输入顺序打印
    // 失败行、取首个错误，与串行版语义一致
    let total = products.len();
    let results = run_parallel(
        &products,
        resolve_concurrency(concurrency),
        |(_, item_format, quality, note, product)| {
            let candidate_bytes = match std::fs::metadata(product) {
                Ok(metadata) => metadata.len(),
                Err(source) => {
                    return Err((
                        format!("跑分失败：{}：{source}", product.display()),
                        format!("无法读取产物 {}：{source}", product.display()),
                    ));
                }
            };
            match score_images(&reference, product) {
                Ok(metrics) => Ok(RunRow {
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
                    note: note.clone(),
                }),
                Err(error) => Err((
                    format!("跑分失败：{}：{error}", product.display()),
                    error.to_string(),
                )),
            }
        },
        |done| eprintln!("正在跑分 {done}/{total}…"),
    );

    let mut rows: Vec<RunRow> = Vec::with_capacity(total);
    for result in results {
        match result {
            Ok(row) => rows.push(row),
            Err((line, first)) => {
                eprintln!("{line}");
                any_failed = true;
                first_error.get_or_insert(first);
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
        OutputFormat::Csv => write_run_csv(&rows, size_mode),
        OutputFormat::Json => write_run_json(&rows, size_mode),
        OutputFormat::Html => write_run_html(&rows, size_mode),
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
/// 大小优先模式（size_mode）追加尾随 note 列（不可达标注，可达行为空）；
/// 其余模式保持既有列序不变。
fn write_run_csv(rows: &[RunRow], size_mode: bool) {
    // 与 score 的 CSV 同约定：UTF-8 BOM 开头（票 18，见 write_csv 注释）
    print!("\u{FEFF}");
    let mut header = "reference,candidate,format,quality,psnr,ssim,ms_ssim,butteraugli,ssimulacra2,reference_bytes,candidate_bytes,size_ratio".to_string();
    if size_mode {
        header.push_str(",note");
    }
    println!("{header}");
    for row in rows {
        let mut line = format!(
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
        if size_mode {
            line.push(',');
            line.push_str(&csv_field(row.note.as_deref().unwrap_or("")));
        }
        println!("{line}");
    }
}

/// run 结果的 JSON 输出：字段名与 CSV 表头一致；quality 无损组为 null；
/// 指标无穷大写作字符串 "inf"、NaN 写作 "nan"（哨兵与 score 子命令一致）。
/// 大小优先模式追加 note 字段（不可达标注，可达为 null）；其余模式无该字段。
fn write_run_json(rows: &[RunRow], size_mode: bool) {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            let mut value = serde_json::json!({
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
                "note": row.note,
            });
            if !size_mode {
                value
                    .as_object_mut()
                    .expect("run 行应为 JSON 对象")
                    .remove("note");
            }
            value
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
/// 大小优先模式追加「备注」列（不可达标注）；其余模式保持既有列不变。
fn write_run_html(rows: &[RunRow], size_mode: bool) {
    let generated_at = utc_now_text();
    let note_header = if size_mode { "<th>备注</th>" } else { "" };
    let mut table = format!(
        "<table>\n<thead><tr><th>跑分图</th><th>路径</th><th>格式</th><th>质量</th><th>PSNR</th>\
         <th>SSIM</th><th>MS-SSIM</th><th>Butteraugli</th><th>SSIMULACRA2</th><th>原图大小</th>\
         <th>跑分图大小</th><th>体积比</th>{note_header}</tr></thead>\n<tbody>\n",
    );
    for row in rows {
        let quality = row
            .quality
            .map(|q| q.to_string())
            .unwrap_or_else(|| "无损".to_string());
        let note_cell = if size_mode {
            format!(
                "<td>{}</td>",
                html_escape(row.note.as_deref().unwrap_or(""))
            )
        } else {
            String::new()
        };
        table.push_str(&format!(
            "<tr><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td>{}</tr>\n",
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
            note_cell,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 并发参数_未传时取半核() {
        assert_eq!(resolve_concurrency(None), concurrency_limit(0.5));
    }

    #[test]
    fn 并发参数_零与超界都钳到区间端点() {
        let cores = logical_cores();
        assert_eq!(resolve_concurrency(Some(0)), 1, "0 钳到 1");
        assert_eq!(resolve_concurrency(Some(cores + 100)), cores, "超界钳到逻辑核数");
    }

    #[test]
    fn 并发参数_区间内原样使用() {
        let cores = logical_cores();
        // 2 在核数 ≥2 时原样使用；单核机器上被钳到 1（2.min(cores) 两端都锚定，无条件断言）
        assert_eq!(resolve_concurrency(Some(2)), 2.min(cores));
        assert_eq!(resolve_concurrency(Some(1)), 1);
    }
}
