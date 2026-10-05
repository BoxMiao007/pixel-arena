// Tauri 应用壳：所有应用逻辑都放在 lib.rs，main.rs 只做入口透传（tauri-v2 skill 约定，
// 保证未来若扩展到移动端时 Tauri 能替换入口点；本仓库当前只做桌面三端）。
//
// T05：跑分组与评测轮管理。核心库持全部数据模型与持久化逻辑，本文件只是薄客户端：
// 每个命令改内存工作区后立即写盘（改动即自动保存），并把最新状态整份返回给前端。
// T14：视频评测轮（原视频/跑分视频/ffmpeg 跑分）+ ffmpeg 工具下载（见 ffmpeg_setup.rs）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{ipc::Channel, Manager, State};

use pixel_arena_core::workspace::{Workspace, WorkspaceError};

mod ffmpeg_setup;

/// 全局应用状态：内存中的工作区 + 工作区 JSON 文件路径 + ffmpeg 等外部工具目录。
/// Arc 让跑分这类耗时命令能把引用带进阻塞线程池（不持锁跨 await）。
struct AppState {
    workspace: Arc<Mutex<Workspace>>,
    path: Arc<PathBuf>,
    /// 编码器安装目录（应用数据目录 tools/，一站式模式首次使用时自动下载）。
    tools_dir: Arc<PathBuf>,
    /// 评测轮工作目录的父目录（应用数据目录 rounds/，一站式产物按 <rounds>/<轮 id>/ 存放）。
    rounds_dir: Arc<PathBuf>,
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

/// IPC 命令：一站式模式第一切片（T10）——用 MozJPEG 把原图编码为指定质量的 JPEG。
///
/// 产物写到应用数据目录 rounds/<轮 id>/<原图名>-q<质量>.jpg；是否纳入本轮由前端
/// 在生成成功后调 round_add_candidates 决定（某档失败不影响其他档）。
/// 下载/安装编码器与编码都可能耗时（首次使用要联网下载），放阻塞线程池执行。
#[tauri::command]
async fn onestop_encode_jpeg(
    group_id: String,
    round_id: String,
    reference_path: String,
    quality: u8,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 前置校验（持锁只做只读检查）：评测轮必须还在，且传入原图与本轮所选原图一致，
    // 防止往已删除的轮目录里写产物或给 A 轮产物挂到 B 轮原图名下。
    {
        let ws = state.workspace.lock().expect("工作区锁不应中毒");
        let round = ws
            .groups
            .iter()
            .find(|g| g.id == group_id)
            .and_then(|g| g.rounds.iter().find(|r| r.id == round_id))
            .ok_or_else(|| "评测轮不存在或已被删除".to_string())?;
        if round.reference_path.as_deref() != Some(reference_path.as_str()) {
            return Err("传入的原图与本轮所选原图不一致，请重新触发一站式跑分".to_string());
        }
    }

    let rounds_dir = state.rounds_dir.clone();
    let tools_dir = state.tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pixel_arena_core::encode::encode_jpeg(
            &reference_path,
            quality,
            rounds_dir.join(&round_id),
            tools_dir.as_path(),
        )
        .map(|product| product.to_string_lossy().into_owned())
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("编码任务执行失败: {err}"))?
}

/// IPC 命令：为评测轮选入原视频（路径来自 tauri-plugin-dialog 文件对话框）。T14。
#[tauri::command]
fn round_set_video_reference(
    group_id: String,
    round_id: String,
    path: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.set_round_video_reference(&group_id, &round_id, &path)
    })
}

/// IPC 命令：为评测轮添加若干段跑分视频（多选）。T14。
#[tauri::command]
fn round_add_video_candidates(
    group_id: String,
    round_id: String,
    paths: Vec<String>,
    state: State<AppState>,
) -> Result<Workspace, String> {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    mutate(&state, |ws| {
        ws.add_round_video_candidates(&group_id, &round_id, &paths)
    })
}

/// IPC 命令：对一段跑分视频跑分（前端逐对调用，每对回来就更新一行）。
/// ffmpeg 跑分可能耗时（长视频分钟级），放到阻塞线程池执行，不占用异步运行时；
/// 单段失败不报错——中文原因由核心库写进行内（含耗时），界面标「失败」。
/// 跑分前顺手确保 ffmpeg 就绪（已就绪零开销；正常路径下载进度由前端先调
/// video_ensure_ffmpeg 展示，这里是兜底）。
#[tauri::command]
async fn round_score_video_candidate(
    group_id: String,
    round_id: String,
    candidate_path: String,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let workspace = state.workspace.clone();
    let path = state.path.clone();
    let tools_dir = state.tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = ffmpeg_setup::ensure_ffmpeg(&tools_dir, &mut |_| {})?;
        let mut ws = workspace.lock().expect("工作区锁不应中毒");
        ws.score_round_video_candidate(&group_id, &round_id, &candidate_path, &ffmpeg)
            .map_err(|err| err.to_string())?;
        ws.save_to_file(&path).map_err(|err| err.to_string())?;
        Ok(ws.clone())
    })
    .await
    .map_err(|err| format!("视频跑分任务执行失败: {err}"))?
}

/// IPC 命令：确保视频跑分用的 ffmpeg 就绪。首次会下载锁定版本的静态构建（约 40MB，
/// 一次性），下载/校验/解压进度经 Channel 推给前端显示在状态栏；返回 ffmpeg 路径。
#[tauri::command]
async fn video_ensure_ffmpeg(
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let tools_dir = state.tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg_setup::ensure_ffmpeg(&tools_dir, &mut |message| {
            let _ = on_progress.send(message);
        })
        .map(|path| path.display().to_string())
    })
    .await
    .map_err(|err| format!("ffmpeg 准备任务执行失败: {err}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 工作区文件与外部工具放应用数据目录：<系统数据目录>/<identifier>/
            let dir = app
                .path()
                .app_data_dir()
                .expect("无法确定应用数据目录");
            std::fs::create_dir_all(&dir).expect("无法创建应用数据目录");
            let tools_dir = dir.join("tools");
            std::fs::create_dir_all(&tools_dir).expect("无法创建工具目录");
            app.manage(AppState {
                workspace: Arc::new(Mutex::new(Workspace::new())),
                path: Arc::new(dir.join("workspace.json")),
                tools_dir: Arc::new(tools_dir),
                rounds_dir: Arc::new(dir.join("rounds")),
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
            onestop_encode_jpeg,
            // T14 视频评测轮
            round_set_video_reference,
            round_add_video_candidates,
            round_score_video_candidate,
            video_ensure_ffmpeg,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
