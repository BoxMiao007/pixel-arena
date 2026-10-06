// 发布版（debug_assertions 关闭）下隐藏 Windows 控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pixel_arena_lib::run();
}
