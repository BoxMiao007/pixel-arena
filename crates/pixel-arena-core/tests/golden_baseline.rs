// 黄金基准守护测试：样例图与指标数值入库（tests/golden.toml），容差比对。
// 这是全项目指标正确性的锚点——改指标实现导致数值变化时，这里必须先显式重算。
// 样例图由 scripts/generate_golden_samples.sh 生成，同样入库。

use serde::Deserialize;

const TOLERANCE_PSNR: f64 = 1e-6;
const TOLERANCE_SSIM: f64 = 1e-9;
const TOLERANCE_MS_SSIM: f64 = 1e-9;
// 与 butteraugli crate 自带 C++ 对照回归同标准（相对 0.1%，观测 FMA 噪声约 0.002%）。
const TOLERANCE_BUTTERAUGLI_RELATIVE: f64 = 1e-3;
// 近零分数（相同图为 0、JPEG q85 为 0.85）的绝对下限兜底。
const TOLERANCE_BUTTERAUGLI_FLOOR: f64 = 1e-3;
// 与 ssimulacra2 crate 官方测试同款绝对容差（作者注明跨平台浮点/求和顺序有差异）。
const TOLERANCE_SSIMULACRA2: f64 = 0.25;

#[derive(Deserialize)]
struct GoldenBaseline {
    samples: Vec<GoldenSample>,
}

#[derive(Deserialize)]
struct GoldenSample {
    name: String,
    reference: String,
    distorted: String,
    psnr: f64,
    ssim: f64,
    ms_ssim: f64,
    butteraugli: f64,
    ssimulacra2: f64,
}

#[test]
fn 指标与黄金基准在容差内一致() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let raw = std::fs::read_to_string(format!("{manifest_dir}/tests/golden.toml"))
        .expect("黄金基准文件应存在");
    let baseline: GoldenBaseline = toml::from_str(&raw).expect("黄金基准文件应能解析");

    assert!(
        baseline.samples.len() >= 4,
        "黄金基准至少应覆盖纯色/渐变/噪声/照片四类样例"
    );

    for sample in &baseline.samples {
        let reference = format!("{manifest_dir}/tests/data/{}", sample.reference);
        let distorted = format!("{manifest_dir}/tests/data/{}", sample.distorted);
        let score = pixel_arena_core::score_images(&reference, &distorted)
            .unwrap_or_else(|error| panic!("样例「{}」跑分失败：{error}", sample.name));

        let psnr_diff = (score.psnr - sample.psnr).abs();
        let ssim_diff = (score.ssim - sample.ssim).abs();
        assert!(
            psnr_diff <= TOLERANCE_PSNR,
            "样例「{}」PSNR 漂移：基准 {}，实测 {}（差 {psnr_diff}）",
            sample.name,
            sample.psnr,
            score.psnr
        );
        assert!(
            ssim_diff <= TOLERANCE_SSIM,
            "样例「{}」SSIM 漂移：基准 {}，实测 {}（差 {ssim_diff}）",
            sample.name,
            sample.ssim,
            score.ssim
        );

        let ms_ssim_diff = (score.ms_ssim - sample.ms_ssim).abs();
        assert!(
            ms_ssim_diff <= TOLERANCE_MS_SSIM,
            "样例「{}」MS-SSIM 漂移：基准 {}，实测 {}（差 {ms_ssim_diff}）",
            sample.name,
            sample.ms_ssim,
            score.ms_ssim
        );

        // Butteraugli 用相对容差（分数跨样例跨数量级），近零分数用绝对下限兜底。
        let butteraugli_tolerance = TOLERANCE_BUTTERAUGLI_RELATIVE
            * sample.butteraugli.abs().max(1.0)
            + TOLERANCE_BUTTERAUGLI_FLOOR;
        let butteraugli_diff = (score.butteraugli - sample.butteraugli).abs();
        assert!(
            butteraugli_diff <= butteraugli_tolerance,
            "样例「{}」Butteraugli 漂移：基准 {}，实测 {}（差 {butteraugli_diff}，容差 {butteraugli_tolerance}）",
            sample.name,
            sample.butteraugli,
            score.butteraugli
        );

        let ssimulacra2_diff = (score.ssimulacra2 - sample.ssimulacra2).abs();
        assert!(
            ssimulacra2_diff <= TOLERANCE_SSIMULACRA2,
            "样例「{}」SSIMULACRA2 漂移：基准 {}，实测 {}（差 {ssimulacra2_diff}）",
            sample.name,
            sample.ssimulacra2,
            score.ssimulacra2
        );
    }
}
