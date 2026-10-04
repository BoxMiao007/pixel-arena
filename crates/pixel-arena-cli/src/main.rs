// CLI 空壳：T01 只要求能编译运行、--version 输出核心库版本。
// score 批量跑分子命令属于 T03，届时再引入参数解析库。

use std::process::ExitCode;

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--version" | "-V") => {
            println!("pixel-arena-cli {}", pixel_arena_core::version());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("用法: pixel-arena-cli --version");
            eprintln!("score 批量跑分命令尚未实现（T03）。");
            ExitCode::from(2)
        }
    }
}
