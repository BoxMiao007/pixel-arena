// T13 导出样例：从真实工作区文件导出评测轮报告（CSV + HTML）。
//
// 与 GUI「导出 CSV / 导出 HTML」按钮走完全相同的序列化路径（核心库
// report::export_csv / export_html，即 round_export IPC 命令的实现体），
// 用于在保存对话框不便用合成输入操作的环境里产出验收证据文件。
//
// 用法：
//   cargo run -p pixel-arena --example export_sample -- \
//     <workspace.json> <跑分组名> <评测轮名> <输出.csv> <输出.html> [生成时间]

use pixel_arena_core::workspace::Workspace;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 || args.len() > 7 {
        eprintln!(
            "用法: {} <workspace.json> <跑分组名> <评测轮名> <输出.csv> <输出.html> [生成时间]",
            args[0]
        );
        std::process::exit(2);
    }
    let workspace_path = &args[1];
    let group_name = &args[2];
    let round_name = &args[3];
    let csv_out = &args[4];
    let html_out = &args[5];
    let generated_at = args.get(6).map(String::as_str).unwrap_or("样例导出");

    let ws = Workspace::load_from_file(std::path::Path::new(workspace_path))
        .unwrap_or_else(|err| panic!("工作区加载失败: {err}"));
    let group = ws
        .groups
        .iter()
        .find(|g| g.name == *group_name)
        .unwrap_or_else(|| panic!("找不到跑分组: {group_name}"));
    let round = group
        .rounds
        .iter()
        .find(|r| r.name == *round_name)
        .unwrap_or_else(|| panic!("找不到评测轮: {round_name}"));

    let csv = pixel_arena_core::report::export_csv(&group.name, round, generated_at);
    let html = pixel_arena_core::report::export_html(&group.name, round, generated_at);
    std::fs::write(csv_out, csv).expect("写 CSV 失败");
    std::fs::write(html_out, html).expect("写 HTML 失败");
    println!("已导出: {csv_out}");
    println!("已导出: {html_out}");
}
