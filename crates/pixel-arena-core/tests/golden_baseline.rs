// 黄金基准守护测试：样例图与指标数值入库（tests/golden.toml），容差比对。
// 这是全项目指标正确性的锚点——改指标实现导致数值变化时，这里必须先显式重算。
// 样例图由 scripts/generate_golden_samples.sh 生成，同样入库。

use serde::Deserialize;

const TOLERANCE_PSNR: f64 = 1e-6;
const TOLERANCE_SSIM: f64 = 1e-9;

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
    }
}
