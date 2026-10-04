// Tauri 应用壳：所有应用逻辑都放在 lib.rs，main.rs 只做入口透传（tauri-v2 skill 约定，
// 保证未来若扩展到移动端时 Tauri 能替换入口点；本仓库当前只做桌面三端）。

/// IPC 命令：把核心库版本号交给前端显示。
#[tauri::command]
fn core_version() -> String {
    pixel_arena_core::version().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_version])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
