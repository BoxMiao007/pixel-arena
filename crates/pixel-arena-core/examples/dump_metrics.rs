// 辅助工具（不属于库 API，不进测试）：打印两张图的全部指标（PSNR/SSIM/MS-SSIM/Butteraugli/SSIMULACRA2）。
// 供 scripts/ 下的交叉验证脚本与维护者手工核对使用。
//
// 用法：cargo run -p pixel-arena-core --example dump_metrics -- <原图> <跑分图>
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if args.len() != 2 {
        eprintln!("用法: cargo run -p pixel-arena-core --example dump_metrics -- <原图> <跑分图>");
        return ExitCode::from(2);
    }
    match pixel_arena_core::score_images(&args[0], &args[1]) {
        Ok(score) => {
            // %.17e 保证 f64 精度无损往返（golden.toml 与交叉验证都依赖这个精度）。
            println!("psnr={:.17e}", score.psnr);
            println!("ssim={:.17e}", score.ssim);
            println!("ms_ssim={:.17e}", score.ms_ssim);
            println!("butteraugli={:.17e}", score.butteraugli);
            println!("ssimulacra2={:.17e}", score.ssimulacra2);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
