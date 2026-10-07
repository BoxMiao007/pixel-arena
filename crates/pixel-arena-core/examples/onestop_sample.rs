// 手工验证完整编码阶梯链路（T11）：按格式把一张原图编码为跑分产物；编码器按内置
// 落位解析，缺失时报中文错误并指引官方发布页（T32 起不再运行期下载）。AVIF/JXL
// 产物会自检解码并旁路 PNG 代片。与 examples/encode_jpeg_sample.rs / dump_metrics.rs
// 同为手工核对工具。
//
// 用法（质量留空表示无损组格式）：
//   cargo run -p pixel-arena-core --example onestop_sample -- <原图> <格式> [质量] [输出目录] [工具目录]
//   格式：jpeg / webp / avif / jxl / png / webp-lossless / jxl-lossless
use pixel_arena_core::encode::{encode_onestop, EncoderOverrides};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: onestop_sample <原图> <格式> [质量] [输出目录] [工具目录]");
        std::process::exit(2);
    }
    let source = &args[1];
    let format = args[2].clone();
    let quality = args.get(3).and_then(|value| value.parse::<u8>().ok());
    let out_dir = args
        .get(4)
        .map(String::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixel-arena-sample-enc").to_string_lossy().into_owned());
    let tools_dir = args
        .get(5)
        .map(String::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixel-arena-sample-tools").to_string_lossy().into_owned());

    // AVIF 产物的解码/代片要 avifdec：GUI 在启动时注入环境变量，CLI/示例按同一约定
    // 从工具目录推导确定性路径（已设置时尊重调用方的覆盖）。
    if std::env::var_os("PIXEL_ARENA_AVIFDEC").is_none() {
        if let Some(decoder) = pixel_arena_core::decode::avif_decoder_path(&tools_dir) {
            std::env::set_var("PIXEL_ARENA_AVIFDEC", decoder);
        }
    }

    match encode_onestop(
        source,
        &format,
        quality,
        &out_dir,
        &tools_dir,
        &EncoderOverrides::default(),
        pixel_arena_core::naming::ConflictPolicy::AutoAppend,
    ) {
        Ok(product) => println!("{}", product.display()),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
