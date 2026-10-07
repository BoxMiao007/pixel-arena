// 手工验证一站式编码链路（T10）：编码一张图为 JPEG。编码器按「内置落位
// tools/<名>/<版本>/<member>」解析，缺失时报中文错误并指引官方发布页（T32 起不再
// 运行期下载）。与 examples/dump_metrics.rs 同为手工核对工具。
//
// 用法：
//   cargo run -p pixel-arena-core --example encode_jpeg_sample -- <原图> <质量> [输出目录] [工具目录]
use pixel_arena_core::encode::encode_jpeg;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: encode_jpeg_sample <原图> <质量> [输出目录] [工具目录]");
        std::process::exit(2);
    }
    let source = &args[1];
    let quality: u8 = args[2].parse().expect("质量应为数字");
    let out_dir = args
        .get(3)
        .map(String::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixel-arena-sample-enc").to_string_lossy().into_owned());
    let tools_dir = args
        .get(4)
        .map(String::from)
        .unwrap_or_else(|| std::env::temp_dir().join("pixel-arena-sample-tools").to_string_lossy().into_owned());

    match encode_jpeg(source, quality, &out_dir, &tools_dir) {
        Ok(product) => println!("{}", product.display()),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
