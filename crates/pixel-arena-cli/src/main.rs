// CLI 入口：clap 解析参数，score 子命令对外部导入场景批量跑分。
// stdout 只输出数据（CSV/JSON），进度与错误提示走 stderr（简体中文），方便管道。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
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

        /// 输出格式，默认 csv。
        #[arg(long, value_enum, default_value_t = OutputFormat::Csv)]
        format: OutputFormat,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    Csv,
    Json,
}

/// 指标表的一行：一张跑分图相对原图的结果。
struct ScoreRow {
    reference: String,
    candidate: String,
    psnr: f64,
    ssim: f64,
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
            reference_bytes,
            candidate_bytes,
            size_ratio: candidate_bytes as f64 / reference_bytes as f64,
        });
    }

    match format {
        OutputFormat::Csv => write_csv(&rows),
        OutputFormat::Json => write_json(&rows),
    }
    ExitCode::SUCCESS
}

/// 运行期错误：中文提示走 stderr，退出码 1（用法错误由 clap 退出 2）。
fn fail(error: &CoreError) -> ExitCode {
    eprintln!("错误：{error}");
    ExitCode::from(1)
}

fn write_csv(rows: &[ScoreRow]) {
    println!("reference,candidate,psnr,ssim,reference_bytes,candidate_bytes,size_ratio");
    for row in rows {
        println!(
            "{},{},{},{},{},{},{}",
            csv_field(&row.reference),
            csv_field(&row.candidate),
            metric_text(row.psnr),
            metric_text(row.ssim),
            row.reference_bytes,
            row.candidate_bytes,
            metric_text(row.size_ratio),
        );
    }
}

/// JSON 输出：字段名与 CSV 表头一致。PSNR 无穷大时写为字符串 "inf"
/// （serde_json 无法序列化无穷大，统一哨兵见 metric_text），其余为数字、全精度。
fn write_json(rows: &[ScoreRow]) {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "reference": row.reference,
                "candidate": row.candidate,
                "psnr": metric_value(row.psnr),
                "ssim": metric_value(row.ssim),
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

/// 单个指标值转 JSON：无穷大写作字符串 "inf"，其余为数字。
fn metric_value(value: f64) -> serde_json::Value {
    if value.is_infinite() {
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

/// 指标数值的文本表示：无穷大（两图逐像素一致时 PSNR）写作 "inf"，
/// 其余定点 6 位小数。该哨兵是 CSV 与 JSON 的统一约定。
fn metric_text(value: f64) -> String {
    if value.is_infinite() {
        "inf".to_string()
    } else {
        format!("{value:.6}")
    }
}
