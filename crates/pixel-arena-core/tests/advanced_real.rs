//! 高级创建的真实编码回归（本机手动触发，CI 离线自动跳过）。
//!
//! 逐个把编码器规格里声明的「推荐参数」跑一遍真实编码，防止标志拼写与编码器
//! 实际支持的选项不匹配——例如 cwebp 只认 `-sharp_yuv`，写成 `-sharp-yuv`
//! 会直接被编码器拒绝（曾出现过的缺陷）。
//!
//! 门控环境变量与 encode_ladder.rs 一致：
//! `PIXEL_ARENA_CJPEG_PATH` / `PIXEL_ARENA_CWEBP_PATH` /
//! `PIXEL_ARENA_AVIFENC_PATH` / `PIXEL_ARENA_CJXL_PATH`；
//! 跑 AVIF 还要设 `PIXEL_ARENA_AVIFDEC`（产物可解码自检走 avifdec）。

use pixel_arena_core::advanced::{
    encode_advanced_image, image_specs, AdvancedImageJob, AdvancedParamRow, AdvancedQuickMode,
    ImageEncoderSpec, ParamValueKind,
};
use pixel_arena_core::encode::EncoderOverrides;
use pixel_arena_core::naming::ConflictPolicy;
use std::path::PathBuf;

fn data(name: &str) -> String {
    format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().map(PathBuf::from)
}

fn overrides_for(spec: &ImageEncoderSpec) -> Option<EncoderOverrides> {
    let key = match spec.tool_key {
        "cjpeg" => "PIXEL_ARENA_CJPEG_PATH",
        "cwebp" => "PIXEL_ARENA_CWEBP_PATH",
        "avifenc" => "PIXEL_ARENA_AVIFENC_PATH",
        "cjxl" => "PIXEL_ARENA_CJXL_PATH",
        _ => return None,
    };
    let path = env_path(key)?;
    let mut overrides = EncoderOverrides::default();
    match spec.tool_key {
        "cjpeg" => overrides.cjpeg = Some(path),
        "cwebp" => overrides.cwebp = Some(path),
        "avifenc" => overrides.avifenc = Some(path),
        "cjxl" => overrides.cjxl = Some(path),
        _ => {}
    }
    Some(overrides)
}

/// `Some(None)` = 布尔开关（只追加标志）；`Some(Some(v))` = 带值参数；
/// `None` = 自由文本没有可靠默认值，跳过。
fn value_for(kind: &ParamValueKind) -> Option<Option<String>> {
    match kind {
        ParamValueKind::Bool => Some(None),
        ParamValueKind::Number { default, .. } => Some(Some(default.to_string())),
        ParamValueKind::Choice { default, .. } => Some(Some(default.clone())),
        ParamValueKind::Text => None,
    }
}

fn run(spec: &ImageEncoderSpec, rows: Vec<AdvancedParamRow>) -> Result<PathBuf, String> {
    let overrides = overrides_for(spec).expect("调用前已确认编码器可用");
    let out = std::env::temp_dir().join(format!("pixel-arena-adv-real-{}", std::process::id()));
    std::fs::create_dir_all(&out).map_err(|err| err.to_string())?;
    let job = AdvancedImageJob {
        format_id: spec.id.to_string(),
        lossless: false,
        mode: AdvancedQuickMode::Quality,
        quality: spec.quality_default,
        target_bytes: 0,
        rows,
    };
    let product = encode_advanced_image(
        data("photo-ref.png"),
        &job,
        &out,
        data("no-such-tools"),
        &overrides,
        ConflictPolicy::AutoAppend,
    )
    .map_err(|err| err.to_string())?;
    Ok(PathBuf::from(product.path))
}

#[test]
fn real_advanced_known_params_are_accepted_by_encoders() {
    for spec in image_specs() {
        if overrides_for(&spec).is_none() {
            eprintln!("跳过 {}：未设置对应编码器环境变量", spec.id);
            continue;
        }
        // 基础命令行（无高级参数）必须先能成功
        run(&spec, Vec::new()).unwrap_or_else(|err| panic!("{} 基础编码应成功：{err}", spec.id));

        for known in &spec.known_params {
            let Some(value) = value_for(&known.kind) else {
                eprintln!("跳过 {}/{}：自由文本参数无可靠默认值", spec.id, known.flag);
                continue;
            };
            let row = AdvancedParamRow::new(known.name, known.flag, value.as_deref());
            let product = run(&spec, vec![row]).unwrap_or_else(|err| {
                panic!(
                    "{} 的推荐参数「{}」（{}）真实编码失败：{err}",
                    spec.id, known.name, known.flag
                )
            });
            assert!(product.is_file(), "产物应落盘：{}", product.display());
        }
    }
}
