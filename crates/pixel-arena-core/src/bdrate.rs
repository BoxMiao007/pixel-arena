// BD-rate（Bjøntegaard delta 码率）计算（T13）。
//
// 口径（决策 0013，docs/decisions.md）：
// - 画质轴：PSNR（dB），与跑分同一口径；
// - 码率轴：文件字节数。同轮全部跑分图与原图同分辨率（跑分的前提），与 bpp 只差
//   一个公共常数因子，在「同画质 log2 码率差」的差分中抵消，BD-rate 数值与 bpp
//   口径恒等，因此实现直接用文件字节数，免去读图片尺寸及其失败分支；
// - 拟合：log2(码率) 对画质做最小二乘多项式拟合，点数 ≥4 用三次、恰 3 点降为二次；
// - BD-rate% = (2^Δ − 1) × 100，Δ 为参照与对比两条拟合曲线在画质区间交集上的
//   平均 log2 码率差；负值 = 同画质下比参照更省码率（更好）。
//
// 降级行为（明确报错、不 panic）：
// - 有效点数 < 3：样本不足，该格式不参与对比；
// - 率失真非单调（按画质升序码率不递增）：跳过该格式；
// - 两条曲线画质区间无交集或拟合矩阵退化：跳过该格式。
// 无损组（PSNR = ∞）的点位无法进入拟合，由 summarize_round 单独标注。

use serde::Serialize;

/// 单个率失真样本点：文件字节数 + PSNR（dB）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RdPoint {
    pub rate_bytes: f64,
    pub psnr: f64,
}

impl RdPoint {
    pub fn new(rate_bytes: f64, psnr: f64) -> Self {
        RdPoint { rate_bytes, psnr }
    }
}

/// BD-rate 汇总里的一行（一个编码格式）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BdrateEntry {
    /// 格式显示名（JPEG / WebP / AVIF / JPEG XL / PNG / 其他扩展名大写）。
    pub format: String,
    /// BD-rate（%）。None = 不可算（参照行、样本不足、非单调等），原因见 note。
    pub bd_rate_percent: Option<f64>,
    /// 参与拟合判断的有效点数（跑分成功且 PSNR 有限）。
    pub point_count: usize,
    /// 中文说明（参照格式 / 样本不足 / 无损格式 / 跳过原因）。
    pub note: Option<String>,
}

/// 评测轮的 BD-rate 汇总（GUI 展示与导出报告共用同一数据源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BdrateSummary {
    /// 参照格式显示名；None = 没有任何格式点数足够，无法确定参照。
    pub reference_format: Option<String>,
    /// 汇总级的中文说明（如无法计算时的整体原因）。
    pub note: Option<String>,
    pub entries: Vec<BdrateEntry>,
}

/// 计算对比格式相对参照格式的 BD-rate（%）。
/// 负值 = 同画质下码率更低。失败时返回中文原因（跳过该格式，不 panic）。
pub fn bd_rate_percent(reference: &[RdPoint], test: &[RdPoint]) -> Result<f64, String> {
    let (ref_fit, ref_range) = fit_curve(reference, "参照格式")?;
    let (test_fit, test_range) = fit_curve(test, "对比格式")?;
    let delta = delta_log2(&ref_fit, ref_range, &test_fit, test_range)?;
    Ok((2.0f64.powf(delta) - 1.0) * 100.0)
}

/// 平均 log2 码率差：两条已拟合曲线在画质区间交集上的积分差除以区间长度。
/// 这是 BD-rate 的核心量，bd_rate_percent 与 summarize_round 共用。
fn delta_log2(
    ref_fit: &[f64],
    ref_range: (f64, f64),
    test_fit: &[f64],
    test_range: (f64, f64),
) -> Result<f64, String> {
    // 标准做法：只在两条曲线画质区间的交集上积分，避免外插
    let lo = ref_range.0.max(test_range.0);
    let hi = ref_range.1.min(test_range.1);
    if !(hi > lo) {
        return Err("与参照格式的画质区间无交集，无法对比".to_string());
    }
    let delta = (poly_integral(test_fit, hi) - poly_integral(test_fit, lo)
        - poly_integral(ref_fit, hi)
        + poly_integral(ref_fit, lo))
        / (hi - lo);
    if !delta.is_finite() {
        return Err("BD-rate 计算结果异常（码率差非有限值）".to_string());
    }
    Ok(delta)
}

/// 把一组样本点拟合成 log2(码率) = 多项式(画质)，并返回画质区间。
/// 失败时返回中文原因。`label` 用于错误信息定位是参照还是对比格式。
fn fit_curve(points: &[RdPoint], label: &str) -> Result<(Vec<f64>, (f64, f64)), String> {
    let mut pts: Vec<(f64, f64)> = points
        .iter()
        .filter(|p| p.rate_bytes > 0.0 && p.psnr.is_finite())
        .map(|p| (p.psnr, p.rate_bytes.log2()))
        .collect();
    if pts.len() < 3 {
        return Err(format!(
            "样本不足：只有 {} 个有效质量点，至少需要 3 个",
            pts.len()
        ));
    }
    // 按画质升序（同画质按码率升序），检查率失真单调性
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    for w in pts.windows(2) {
        if w[1].1 < w[0].1 {
            return Err(format!(
                "{label}的率失真曲线非单调（画质升高码率反而降低），无法拟合"
            ));
        }
    }
    let degree = if pts.len() >= 4 { 3 } else { 2 };
    let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = pts.iter().map(|p| p.1).collect();
    let coeffs = polyfit(&xs, &ys, degree)
        .ok_or_else(|| format!("{label}的率失真数据退化，多项式拟合失败"))?;
    let lo = *xs.first().expect("上方已确认非空");
    let hi = *xs.last().expect("上方已确认非空");
    Ok((coeffs, (lo, hi)))
}

/// 最小二乘多项式拟合（正规方程 + 列主元高斯消元）。矩阵退化时返回 None。
fn polyfit(xs: &[f64], ys: &[f64], degree: usize) -> Option<Vec<f64>> {
    let n = degree + 1;
    let mut a = vec![0.0; n * n];
    let mut b = vec![0.0; n];
    // 幂表 x^0..=x^(2·degree)：每个样本先展开幂，再累加进正规方程
    let mut powers = vec![1.0; 2 * degree + 1];
    for (&x, &y) in xs.iter().zip(ys) {
        for k in 1..powers.len() {
            powers[k] = powers[k - 1] * x;
        }
        for k in 0..n {
            b[k] += y * powers[k];
            for j in 0..n {
                a[k * n + j] += powers[k + j];
            }
        }
    }
    // 高斯消元
    for col in 0..n {
        let pivot = (col..n)
            .max_by(|&r1, &r2| a[r1 * n + col].abs().total_cmp(&a[r2 * n + col].abs()))
            .expect("col < n，区间非空");
        if a[pivot * n + col].abs() < 1e-10 {
            return None;
        }
        for j in col..n {
            a.swap(pivot * n + j, col * n + j);
        }
        b.swap(pivot, col);
        for row in (col + 1)..n {
            let factor = a[row * n + col] / a[col * n + col];
            for j in col..n {
                a[row * n + j] -= factor * a[col * n + j];
            }
            b[row] -= factor * b[col];
        }
    }
    let mut coeffs = vec![0.0; n];
    for i in (0..n).rev() {
        let tail: f64 = (i + 1..n).map(|j| a[i * n + j] * coeffs[j]).sum();
        coeffs[i] = (b[i] - tail) / a[i * n + i];
    }
    Some(coeffs)
}

/// 多项式的解析原函数在 x 处的值：∫₀ˣ Σ c_k t^k dt。
fn poly_integral(coeffs: &[f64], x: f64) -> f64 {
    coeffs
        .iter()
        .enumerate()
        .map(|(k, c)| c * x.powi(k as i32 + 1) / (k as f64 + 1.0))
        .sum()
}

/// 已知格式的展示顺序（有损阶梯在前，PNG 锚点殿后），其余格式按名称字母序追加。
const KNOWN_FORMAT_ORDER: [&str; 5] = ["JPEG", "WebP", "AVIF", "JPEG XL", "PNG"];

/// 参照格式的优先顺序（有损阶梯顺序）；都不够格时回落到其他点数足够的格式。
const REFERENCE_PRIORITY: [&str; 4] = ["JPEG", "WebP", "AVIF", "JPEG XL"];

/// 从文件路径取格式显示名（按扩展名分组，外部导入与一站式产物同一口径）。
fn format_label(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "JPEG".to_string(),
        "webp" => "WebP".to_string(),
        "avif" => "AVIF".to_string(),
        "jxl" => "JPEG XL".to_string(),
        "png" => "PNG".to_string(),
        "" => "未知格式".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

/// 汇总过程中的每格式中间数据。
struct FormatData {
    points: Vec<RdPoint>,
    /// 跑分成功（有指标）的行数，含 PSNR = ∞ 的无损点。
    scored_rows: usize,
    /// 成功行是否全部是无损点（PSNR = ∞，无法进入拟合）。
    all_lossless: bool,
}

/// 对一轮评测按格式汇总 BD-rate。格式按文件扩展名分组；参照默认 JPEG，
/// 点数不足时按有损阶梯顺序（JPEG → WebP → AVIF → JPEG XL）回落。
pub fn summarize_round(round: &crate::workspace::Round) -> BdrateSummary {
    use crate::workspace::MetricValue;
    use std::collections::BTreeMap;

    let mut groups: BTreeMap<String, FormatData> = BTreeMap::new();
    for candidate in &round.candidates {
        let label = format_label(&candidate.path);
        let entry = groups.entry(label).or_insert(FormatData {
            points: Vec::new(),
            scored_rows: 0,
            all_lossless: true,
        });
        let Some(metrics) = &candidate.metrics else {
            continue; // 未跑分 / 失败行不进入拟合（原因已在该行展示）
        };
        entry.scored_rows += 1;
        let Some(MetricValue::Number(psnr)) = metrics.get("PSNR") else {
            continue; // PSNR = ∞ 的无损点：画质轴无界，进不了拟合
        };
        entry.all_lossless = false;
        if candidate.file_size > 0 {
            entry.points.push(RdPoint::new(candidate.file_size as f64, *psnr));
        }
    }

    // 展示顺序：已知格式按阶梯顺序，其余（BTreeMap 字典序）追加在后
    let mut labels: Vec<String> = groups.keys().cloned().collect();
    labels.sort_by_key(|label| {
        KNOWN_FORMAT_ORDER
            .iter()
            .position(|k| k == label)
            .unwrap_or(KNOWN_FORMAT_ORDER.len())
    });

    // 选参照：优先有损阶梯顺序（JPEG → WebP → AVIF → JPEG XL），其次其他格式；
    // 必须点数足够且拟合成功（非单调/退化的格式当不了参照）
    let mut reference: Option<(String, Vec<f64>, (f64, f64))> = None;
    let mut reference_candidates = labels.clone();
    reference_candidates.sort_by_key(|label| {
        REFERENCE_PRIORITY
            .iter()
            .position(|k| k == label)
            .unwrap_or(REFERENCE_PRIORITY.len())
    });
    for label in &reference_candidates {
        let data = &groups[label];
        if data.points.len() < 3 {
            continue;
        }
        if let Ok((coeffs, range)) = fit_curve(&data.points, "参照格式") {
            reference = Some((label.clone(), coeffs, range));
            break;
        }
    }

    // 单个格式的降级标注：无损锚点 / 样本不足
    let fallback_note = |data: &FormatData| -> Option<String> {
        if data.all_lossless && data.scored_rows > 0 {
            Some("无损格式，不参与 BD-rate 拟合".to_string())
        } else {
            Some("样本不足".to_string())
        }
    };

    let mut entries = Vec::new();
    for label in &labels {
        let data = &groups[label];
        let (bd_rate, note) = match &reference {
            Some((ref_label, ref_coeffs, ref_range)) if ref_label == label => {
                (None, Some("参照格式".to_string()))
            }
            Some((_, ref_coeffs, ref_range)) => {
                if data.points.len() >= 3 {
                    // 参照曲线已拟合好，这里只拟合对比侧再积分
                    match fit_curve(&data.points, "对比格式")
                        .and_then(|(coeffs, range)| {
                            delta_log2(ref_coeffs, *ref_range, &coeffs, range)
                        }) {
                        Ok(delta) => (Some((2.0f64.powf(delta) - 1.0) * 100.0), None),
                        Err(err) => (None, Some(err)),
                    }
                } else {
                    (None, fallback_note(data))
                }
            }
            None => (None, fallback_note(data)),
        };
        entries.push(BdrateEntry {
            format: label.clone(),
            bd_rate_percent: bd_rate,
            point_count: data.points.len(),
            note,
        });
    }

    let note = if reference.is_none() && !labels.is_empty() {
        Some(
            "各格式的率失真样本不足（每格式至少需要 3 个有损质量点），无法计算 BD-rate"
                .to_string(),
        )
    } else {
        None
    };

    BdrateSummary {
        reference_format: reference.map(|(label, _, _)| label),
        note,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- bd_rate_percent：合成数据黄金测试 ----------

    /// 黄金锚点 1（线性率失真，解析解）：参照 P = 30 + 6·log2(R)，
    /// 对比 P = 31 + 6·log2(R)。同画质下 log2 码率差恒为 −1/6，
    /// BD-rate = (2^(−1/6) − 1) × 100 ≈ −10.9101%。
    #[test]
    fn linear_rd_curves_match_analytic_solution() {
        let points = |offset: f64| -> Vec<RdPoint> {
            // 取 4 个跨越一个数量级的码率点
            [1024.0, 4096.0, 16384.0, 65536.0]
                .iter()
                .map(|r| RdPoint::new(*r, offset + 6.0 * (r.log2())))
                .collect()
        };
        let reference = points(30.0);
        let test = points(31.0);
        let bd = bd_rate_percent(&reference, &test).expect("应可计算");
        let expected = (2.0f64.powf(-1.0 / 6.0) - 1.0) * 100.0;
        assert!(
            (bd - expected).abs() < 1e-6,
            "BD-rate 应为解析解 {expected}，实际 {bd}"
        );
    }

    /// 黄金锚点 2（三次曲线，独立数值积分交叉验证）：两条曲线的 log2 码率都是
    /// 画质的三次多项式，期望值在测试里用梯形数值积分独立算出（与实现的解析
    /// 积分是两条不同算法路径），应一致到 1e-6。
    #[test]
    fn cubic_rd_curves_match_numeric_integration() {
        let poly = |p: f64, c: [f64; 4]| c[0] + c[1] * p + c[2] * p * p + c[3] * p * p * p;
        // 参照与对比用不同形状的三次曲线（不只是平移），画质区间 32..44 dB
        let ref_c = [1.0, 0.05, 1.0e-3, 1.0e-6];
        let test_c = [0.8, 0.055, 0.9e-3, 1.2e-6];
        let sample = |c: [f64; 4]| -> Vec<RdPoint> {
            [32.0, 34.0, 36.0, 38.0, 40.0, 42.0, 44.0]
                .iter()
                .map(|p| {
                    let log2_rate = poly(*p, c);
                    RdPoint::new(2.0f64.powf(log2_rate), *p)
                })
                .collect()
        };
        let bd = bd_rate_percent(&sample(ref_c), &sample(test_c)).expect("应可计算");

        // 独立真值：在交集区间（32..44）用 10 万步梯形积分算平均 log2 码率差
        let n = 100_000;
        let (lo, hi) = (32.0, 44.0);
        let step = (hi - lo) / n as f64;
        let mut acc = 0.0;
        for i in 0..=n {
            let p = lo + step * i as f64;
            let w = if i == 0 || i == n { 0.5 } else { 1.0 };
            acc += w * (poly(p, test_c) - poly(p, ref_c)) * step;
        }
        let expected = (2.0f64.powf(acc / (hi - lo)) - 1.0) * 100.0;
        assert!(
            (bd - expected).abs() < 1e-6,
            "BD-rate 应为数值积分解 {expected}，实际 {bd}"
        );
    }

    /// 恰 3 个点降为二次拟合：两条抛物线形率失真曲线，期望值同样由数值积分独立给出。
    #[test]
    fn three_points_fall_back_to_quadratic_fit() {
        let poly = |p: f64, c: [f64; 3]| c[0] + c[1] * p + c[2] * p * p;
        let ref_c = [2.0, 0.04, 5.0e-4];
        let test_c = [1.5, 0.042, 4.5e-4];
        let sample = |c: [f64; 3]| -> Vec<RdPoint> {
            [33.0, 38.0, 43.0]
                .iter()
                .map(|p| RdPoint::new(2.0f64.powf(poly(*p, c)), *p))
                .collect()
        };
        let bd = bd_rate_percent(&sample(ref_c), &sample(test_c)).expect("应可计算");

        let n = 100_000;
        let (lo, hi) = (33.0, 43.0);
        let step = (hi - lo) / n as f64;
        let mut acc = 0.0;
        for i in 0..=n {
            let p = lo + step * i as f64;
            let w = if i == 0 || i == n { 0.5 } else { 1.0 };
            acc += w * (poly(p, test_c) - poly(p, ref_c)) * step;
        }
        let expected = (2.0f64.powf(acc / (hi - lo)) - 1.0) * 100.0;
        assert!(
            (bd - expected).abs() < 1e-6,
            "二次拟合的 BD-rate 应为 {expected}，实际 {bd}"
        );
    }

    #[test]
    fn fewer_than_three_points_is_insufficient() {
        let pts = |n: usize| -> Vec<RdPoint> {
            (0..n)
                .map(|i| RdPoint::new(1024.0 * 2.0f64.powi(i as i32), 30.0 + i as f64))
                .collect()
        };
        let err = bd_rate_percent(&pts(4), &pts(2)).unwrap_err();
        assert!(err.contains("样本不足"), "应提示样本不足: {err}");
        let err = bd_rate_percent(&pts(1), &pts(4)).unwrap_err();
        assert!(err.contains("样本不足"), "参照点不足也应提示: {err}");
    }

    #[test]
    fn non_monotonic_curve_is_rejected() {
        // 画质升高反而码率降低：率失真关系倒挂，无法拟合
        let bad = vec![
            RdPoint::new(1024.0, 30.0),
            RdPoint::new(8192.0, 33.0),
            RdPoint::new(2048.0, 36.0),
        ];
        let good = vec![
            RdPoint::new(1024.0, 30.0),
            RdPoint::new(4096.0, 33.0),
            RdPoint::new(16384.0, 36.0),
        ];
        let err = bd_rate_percent(&good, &bad).unwrap_err();
        assert!(err.contains("非单调"), "应提示非单调: {err}");
    }

    #[test]
    fn disjoint_quality_ranges_are_rejected() {
        let low = vec![
            RdPoint::new(1024.0, 28.0),
            RdPoint::new(4096.0, 30.0),
            RdPoint::new(16384.0, 32.0),
        ];
        let high = vec![
            RdPoint::new(1024.0, 40.0),
            RdPoint::new(4096.0, 42.0),
            RdPoint::new(16384.0, 44.0),
        ];
        let err = bd_rate_percent(&low, &high).unwrap_err();
        assert!(err.contains("无交集"), "应提示画质区间无交集: {err}");
    }

    #[test]
    fn positive_bd_rate_means_more_rate_for_same_quality() {
        // 对比格式比参照差 1 dB：同画质要多花码率，BD-rate 应为正
        let points = |offset: f64| -> Vec<RdPoint> {
            [1024.0, 4096.0, 16384.0, 65536.0]
                .iter()
                .map(|r| RdPoint::new(*r, offset + 6.0 * r.log2()))
                .collect()
        };
        let bd = bd_rate_percent(&points(30.0), &points(29.0)).expect("应可计算");
        let expected = (2.0f64.powf(1.0 / 6.0) - 1.0) * 100.0;
        assert!((bd - expected).abs() < 1e-6 && bd > 0.0, "应为正 {expected}，实际 {bd}");
    }

    // ---------- summarize_round：分组、参照回落与降级标注 ----------

    use crate::workspace::{CandidateImage, MetricValue, Round};
    use std::collections::BTreeMap;

    fn candidate(path: &str, bytes: u64, psnr: Option<f64>) -> CandidateImage {
        CandidateImage {
            path: path.to_string(),
            file_size: bytes,
            size_ratio: None,
            metrics: psnr.map(|p| {
                BTreeMap::from([
                    ("PSNR".to_string(), MetricValue::new(p)),
                    ("SSIM".to_string(), MetricValue::new(0.99)),
                ])
            }),
            encoding_params: None,
            note: None,
            error: None,
        }
    }

    fn round_with(candidates: Vec<CandidateImage>) -> Round {
        Round {
            id: "r-1".to_string(),
            name: "测试轮".to_string(),
            reference_path: Some("/tmp/ref.png".to_string()),
            reference_size: None,
            candidates,
            video_reference_path: None,
            video_candidates: Vec::new(),
            note: None,
        }
    }

    #[test]
    fn one_stop_ladder_groups_by_extension_with_jpeg_reference() {
        // 一站式默认阶梯：JPEG/WebP/AVIF/JPEG XL × 3 档 + 无损组（PSNR = ∞）
        let mut candidates = Vec::new();
        for q in [60u64, 75, 90] {
            let bytes = 6000 * q;
            // 各格式画质只差一个小偏移，保证画质区间相互有交集（真实阶梯也是如此）
            let base = 33.0 + q as f64 / 10.0;
            candidates.push(candidate(&format!("/r/photo-q{q}.jpg"), bytes, Some(base)));
            candidates.push(candidate(&format!("/r/photo-q{q}.webp"), bytes, Some(base + 0.2)));
            candidates.push(candidate(&format!("/r/photo-q{q}.avif"), bytes, Some(base + 0.4)));
            candidates.push(candidate(&format!("/r/photo-q{q}.jxl"), bytes, Some(base + 0.6)));
        }
        // 无损组产物跑分成功但 PSNR = ∞（与原图逐像素一致）
        candidates.push(candidate("/r/photo-png.png", 999_999, Some(f64::INFINITY)));
        candidates.push(candidate("/r/photo-webpll.webp", 888_888, Some(f64::INFINITY)));
        candidates.push(candidate("/r/photo-jxllossless.jxl", 777_777, Some(f64::INFINITY)));

        let summary = summarize_round(&round_with(candidates));
        assert_eq!(summary.reference_format.as_deref(), Some("JPEG"));
        let formats: Vec<&str> = summary.entries.iter().map(|e| e.format.as_str()).collect();
        assert_eq!(formats, vec!["JPEG", "WebP", "AVIF", "JPEG XL", "PNG"]);
        for entry in &summary.entries {
            match entry.format.as_str() {
                "JPEG" => {
                    assert_eq!(entry.point_count, 3);
                    assert_eq!(entry.note.as_deref(), Some("参照格式"));
                }
                "WebP" | "AVIF" | "JPEG XL" => {
                    assert_eq!(entry.point_count, 3, "{} 应有 3 个有损点", entry.format);
                    assert!(entry.bd_rate_percent.is_some(), "{} 应有 BD-rate", entry.format);
                }
                "PNG" => {
                    // 无损组唯一一个点是 ∞，进不了拟合，但要有明确说明而不是「样本不足」
                    assert_eq!(entry.point_count, 0);
                    assert_eq!(
                        entry.note.as_deref(),
                        Some("无损格式，不参与 BD-rate 拟合")
                    );
                }
                _ => panic!("意外格式 {entry:?}"),
            }
        }
    }

    #[test]
    fn insufficient_format_gets_sample_note_not_error() {
        let candidates = vec![
            candidate("/r/a-q60.jpg", 1000, Some(30.0)),
            candidate("/r/a-q90.jpg", 4000, Some(36.0)),
            candidate("/r/b-q60.webp", 1100, Some(30.5)),
            candidate("/r/b-q75.webp", 2100, Some(33.5)),
            candidate("/r/b-q90.webp", 4100, Some(36.5)),
        ];
        let summary = summarize_round(&round_with(candidates));
        assert_eq!(summary.reference_format.as_deref(), Some("WebP"), "JPEG 点数不足应回落");
        let webp = summary.entries.iter().find(|e| e.format == "WebP").unwrap();
        assert_eq!(webp.note.as_deref(), Some("参照格式"));
        let jpeg = summary.entries.iter().find(|e| e.format == "JPEG").unwrap();
        assert_eq!(jpeg.point_count, 2);
        assert_eq!(jpeg.bd_rate_percent, None);
        assert_eq!(jpeg.note.as_deref(), Some("样本不足"));
    }

    #[test]
    fn no_qualified_format_leaves_summary_with_global_note() {
        let candidates = vec![candidate("/r/a.png", 1000, None)];
        let summary = summarize_round(&round_with(candidates));
        assert_eq!(summary.reference_format, None);
        assert!(summary.entries.iter().all(|e| e.bd_rate_percent.is_none()));
        assert!(
            summary.note.as_deref().unwrap_or_default().contains("样本不足"),
            "应有整体说明: {:?}",
            summary.note
        );
    }

    #[test]
    fn failed_and_unscored_rows_do_not_enter_fit() {
        let mut failed = candidate("/r/a-q60.jpg", 1000, Some(30.0));
        failed.error = Some("跑分失败".to_string());
        failed.metrics = None;
        let unscored = candidate("/r/a-q75.jpg", 2000, None);
        let ok = candidate("/r/a-q90.jpg", 4000, Some(36.0));
        let summary = summarize_round(&round_with(vec![failed, unscored, ok]));
        let jpeg = summary.entries.iter().find(|e| e.format == "JPEG").unwrap();
        assert_eq!(jpeg.point_count, 1);
        assert_eq!(jpeg.note.as_deref(), Some("样本不足"));
        assert_eq!(summary.reference_format, None);
    }

    #[test]
    fn monotonicity_violation_marks_entry_as_skipped() {
        // WebP 三点画质升码率降（数据坏），JPEG 正常作参照
        let candidates = vec![
            candidate("/r/a-q60.jpg", 1000, Some(30.0)),
            candidate("/r/a-q75.jpg", 2000, Some(33.0)),
            candidate("/r/a-q90.jpg", 4000, Some(36.0)),
            candidate("/r/b-q60.webp", 4000, Some(30.5)),
            candidate("/r/b-q75.webp", 2000, Some(33.5)),
            candidate("/r/b-q90.webp", 1000, Some(36.5)),
        ];
        let summary = summarize_round(&round_with(candidates));
        let webp = summary.entries.iter().find(|e| e.format == "WebP").unwrap();
        assert_eq!(webp.bd_rate_percent, None);
        assert!(
            webp.note.as_deref().unwrap_or_default().contains("非单调"),
            "应注明非单调: {:?}",
            webp.note
        );
    }
}
