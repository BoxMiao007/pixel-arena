// Tauri 应用壳：所有应用逻辑都放在 lib.rs，main.rs 只做入口透传（tauri-v2 skill 约定，
// 保证未来若扩展到移动端时 Tauri 能替换入口点；本仓库当前只做桌面三端）。
//
// T05：跑分组与评测轮管理。核心库持全部数据模型与持久化逻辑，本文件只是薄客户端：
// 每个命令改内存工作区后立即写盘（改动即自动保存），并把最新状态整份返回给前端。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use pixel_arena_core::workspace::{Workspace, WorkspaceError};

/// 全局应用状态：内存中的工作区 + 工作区 JSON 文件路径。
/// Arc 让跑分这类耗时命令能把引用带进阻塞线程池（不持锁跨 await）。
struct AppState {
    workspace: Arc<Mutex<Workspace>>,
    path: Arc<PathBuf>,
}

/// IPC 命令：把核心库版本号交给前端显示。
#[tauri::command]
fn core_version() -> String {
    pixel_arena_core::version().to_string()
}

/// 启动时从磁盘恢复工作区。文件不存在（首次启动）回落到空工作区；
/// 其余加载失败（坏 JSON、版本不支持等）如实上报，界面提示用户。
#[tauri::command]
fn workspace_load(state: State<AppState>) -> Result<Workspace, String> {
    let mut ws = state.workspace.lock().expect("工作区锁不应中毒");
    match Workspace::load_from_file(&state.path) {
        Ok(loaded) => *ws = loaded,
        Err(WorkspaceError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            *ws = Workspace::new();
        }
        Err(err) => return Err(err.to_string()),
    }
    Ok(ws.clone())
}

/// 统一的改动流程：改内存工作区 -> 立即写盘 -> 返回最新工作区。
/// 任一步失败都不返回半新半旧的状态。
fn mutate<F>(state: &AppState, change: F) -> Result<Workspace, String>
where
    F: FnOnce(&mut Workspace) -> Result<(), WorkspaceError>,
{
    let mut ws = state.workspace.lock().expect("工作区锁不应中毒");
    change(&mut ws).map_err(|err| err.to_string())?;
    ws.save_to_file(&state.path).map_err(|err| err.to_string())?;
    Ok(ws.clone())
}

#[tauri::command]
fn group_create(name: String, state: State<AppState>) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.create_group(&name).map(|_| ())
    })
}

#[tauri::command]
fn group_rename(id: String, name: String, state: State<AppState>) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.rename_group(&id, &name))
}

#[tauri::command]
fn group_close(id: String, state: State<AppState>) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.close_group(&id))
}

#[tauri::command]
fn group_activate(id: String, state: State<AppState>) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.activate_group(&id))
}

#[tauri::command]
fn round_create(
    group_id: String,
    name: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.create_round(&group_id, &name).map(|_| ())
    })
}

#[tauri::command]
fn round_rename(
    group_id: String,
    round_id: String,
    name: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.rename_round(&group_id, &round_id, &name))
}

#[tauri::command]
fn round_delete(
    group_id: String,
    round_id: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.delete_round(&group_id, &round_id))
}

#[tauri::command]
fn round_activate(
    group_id: String,
    round_id: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.activate_round(&group_id, &round_id))
}

/// IPC 命令：为评测轮选入原图（路径来自 tauri-plugin-dialog 文件对话框）。
#[tauri::command]
fn round_set_reference(
    group_id: String,
    round_id: String,
    path: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.set_round_reference(&group_id, &round_id, &path))
}

/// IPC 命令：为评测轮添加若干张跑分图（多选）。
#[tauri::command]
fn round_add_candidates(
    group_id: String,
    round_id: String,
    paths: Vec<String>,
    state: State<AppState>,
) -> Result<Workspace, String> {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    mutate(&state, |ws| ws.add_round_candidates(&group_id, &round_id, &paths))
}

/// IPC 命令：对一张跑分图跑分（前端逐张调用，每张回来就更新一行）。
/// 指标计算可能耗时（大图 SSIM 秒级），放到阻塞线程池执行，不占用异步运行时；
/// 单张失败不报错——中文原因由核心库写进行内，界面标「失败」。
#[tauri::command]
async fn round_score_candidate(
    group_id: String,
    round_id: String,
    candidate_path: String,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let workspace = state.workspace.clone();
    let path = state.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ws = workspace.lock().expect("工作区锁不应中毒");
        ws.score_round_candidate(&group_id, &round_id, &candidate_path)
            .map_err(|err| err.to_string())?;
        ws.save_to_file(&path).map_err(|err| err.to_string())?;
        Ok(ws.clone())
    })
    .await
    .map_err(|err| format!("跑分任务执行失败: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 工作区文件放应用数据目录：<系统数据目录>/<identifier>/workspace.json
            let dir = app
                .path()
                .app_data_dir()
                .expect("无法确定应用数据目录");
            std::fs::create_dir_all(&dir).expect("无法创建应用数据目录");
            app.manage(AppState {
                workspace: Arc::new(Mutex::new(Workspace::new())),
                path: Arc::new(dir.join("workspace.json")),
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            core_version,
            workspace_load,
            group_create,
            group_rename,
            group_close,
            group_activate,
            round_create,
            round_rename,
            round_delete,
            round_activate,
            round_set_reference,
            round_add_candidates,
            round_score_candidate,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
