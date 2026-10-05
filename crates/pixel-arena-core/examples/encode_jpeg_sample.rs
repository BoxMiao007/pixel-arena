// 手工验证一站式编码链路（T10）：编码一张图为 JPEG，编码器缺失时自动走
// 「下载 → sha256 校验 → 安装」机制。与 examples/dump_metrics.rs 同为手工核对工具。
//
// 用法：
//   cargo run -p pixel-arena-core --example encode_jpeg_sample -- <原图> <质量> [输出目录] [工具目录]
// 离线测试分发机制（镜像覆盖下载主机，工件同名）：
//   PIXEL_ARENA_ENCODER_MIRROR=http://127.0.0.1:8010 cargo run ...
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
