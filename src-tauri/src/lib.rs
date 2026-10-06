// Tauri 应用壳：所有应用逻辑都放在 lib.rs，main.rs 只做入口透传（tauri-v2 skill 约定，
// 保证未来若扩展到移动端时 Tauri 能替换入口点；本仓库当前只做桌面三端）。
//
// T05：跑分组与评测轮管理。核心库持全部数据模型与持久化逻辑，本文件只是薄客户端：
// 每个命令改内存工作区后立即写盘（改动即自动保存），并把最新状态整份返回给前端。
// T14：视频评测轮（原视频/跑分视频/ffmpeg 跑分）+ ffmpeg 工具下载（见 ffmpeg_setup.rs）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{ipc::Channel, Manager, State};

use pixel_arena_core::workspace::{Group, GroupKind, Round, Workspace, WorkspaceError};

mod ffmpeg_setup;
mod video_probe;
mod video_server;

/// 全局应用状态：内存中的工作区 + 工作区 JSON 文件路径 + ffmpeg 等外部工具目录。
/// Arc 让跑分这类耗时命令能把引用带进阻塞线程池（不持锁跨 await）。
struct AppState {
    workspace: Arc<Mutex<Workspace>>,
    path: Arc<PathBuf>,
    /// 编码器安装目录（应用数据目录 tools/，一站式模式首次使用时自动下载）。
    tools_dir: Arc<PathBuf>,
    /// 评测轮工作目录的父目录（应用数据目录 rounds/，一站式产物按 <rounds>/<轮 id>/ 存放）。
    rounds_dir: Arc<PathBuf>,
    /// 视频流服务（T15）：Linux 端 WebKitGTK 媒体引擎不走 asset 协议，视频元素从
    /// 127.0.0.1 回环地址拉流（见 video_server.rs）。
    video_stream: Arc<video_server::VideoStreamServer>,
}

/// IPC 命令：把核心库版本号交给前端显示。
#[tauri::command]
fn core_version() -> String {
    pixel_arena_core::version().to_string()
}

/// 一站式单档产物（onestop_encode 回传）：产物路径 + 编码参数文本。
/// 参数文本与 CLI 的进度标签同出核心库 OnestopFormat::encoding_params_text 一处，
/// 前端纳入本轮时原样写入 encoding_params（结果表「编码参数」列的数据源）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OnestopProduct {
    path: String,
    encoding_params: String,
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

/// 按 id 只读定位跑分组与评测轮（onestop_encode / round_bdrate / export_round_file
/// 三处命令共用）：组与轮分开报错，错误文案统一一版中文。
fn find_round<'a>(
    ws: &'a Workspace,
    group_id: &str,
    round_id: &str,
) -> Result<(&'a Group, &'a Round), String> {
    let group = ws
        .groups
        .iter()
        .find(|g| g.id == group_id)
        .ok_or_else(|| "跑分组不存在或已被关闭".to_string())?;
    let round = group
        .rounds
        .iter()
        .find(|r| r.id == round_id)
        .ok_or_else(|| "评测轮不存在或已被删除".to_string())?;
    Ok((group, round))
}

/// IPC 命令：新建跑分组（T17 起带类型：kind = "image" | "video"，创建后不可更改，
/// 组内评测轮的类型随组锁定；workspace_load 的旧文件迁移在核心库 from_json 内完成）。
#[tauri::command]
fn group_create(name: String, kind: String, state: State<AppState>) -> Result<Workspace, String> {
    let kind = GroupKind::parse(&kind).map_err(|err| err.to_string())?;
    mutate(&state, |ws| ws.create_group(&name, kind).map(|_| ()))
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
/// `encoding_params`（可选）：与 paths 一一对应的编码参数文本，仅一站式模式传入；
/// 外部导入不传（None）——参数用户自备、工具不知晓，界面与报告显示 —。
#[tauri::command]
fn round_add_candidates(
    group_id: String,
    round_id: String,
    paths: Vec<String>,
    encoding_params: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<Workspace, String> {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    let params = encoding_params.map(|values| values.into_iter().map(Some).collect::<Vec<_>>());
    mutate(&state, |ws| {
        ws.add_round_candidates_with_params(&group_id, &round_id, &paths, params.as_deref())
    })
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

/// 一站式勾选目录（T21 单源化）：有损/无损格式清单与默认质量档全部由核心库
/// 质量优先取点驱动（基准 75 = 现行默认 60/75/90），前端 onestop.ts 启动时拉取，
/// 不再自持档位常量。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnestopFormatEntry {
    pub format: String,
    pub label: String,
}

/// 一站式勾选目录的载荷（字段名与前端 onestop.ts 的消费一一对应）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnestopCatalog {
    pub lossy_formats: Vec<OnestopFormatEntry>,
    pub qualities: Vec<u8>,
    pub lossless_formats: Vec<OnestopFormatEntry>,
}

/// 构建一站式勾选目录（pub 供不经 Tauri 运行时端到端测试，沿 export_round_file 先例）。
pub fn onestop_default_catalog() -> OnestopCatalog {
    use pixel_arena_core::encode::OnestopFormat;
    use pixel_arena_core::ladder::{quality_points, LOSSLESS_FORMATS, LOSSY_FORMATS};
    let entry = |format: OnestopFormat| OnestopFormatEntry {
        format: format.as_str().to_string(),
        label: format.display_name().to_string(),
    };
    // 默认质量档 = 各有损格式基准 75 取点的并集（升序去重）。基准 75 下四格式取点
    // 相同（60/75/90），界面共用一排质量勾选的行为不变；基准不同的取点交给 T22 拉杆。
    let mut qualities: Vec<u8> = LOSSY_FORMATS
        .iter()
        .flat_map(|format| quality_points(75, *format).expect("基准 75 合法"))
        .collect();
    qualities.sort_unstable();
    qualities.dedup();
    OnestopCatalog {
        lossy_formats: LOSSY_FORMATS.iter().map(|format| entry(*format)).collect(),
        qualities,
        lossless_formats: LOSSLESS_FORMATS
            .iter()
            .map(|format| entry(*format))
            .collect(),
    }
}

/// IPC 命令：一站式勾选目录（T21 单源化，数据源见 onestop_default_catalog）。
#[tauri::command]
fn onestop_default_ladder() -> OnestopCatalog {
    onestop_default_catalog()
}

/// IPC 命令：一站式模式按（格式, 质量）逐次生成一份跑分产物（T11 完整编码阶梯）。
///
/// 格式标识：jpeg / webp / avif / jxl（有损，quality 必填）与 png / webp-lossless /
/// jxl-lossless（无损对照组，quality 必须为 null）。产物写到应用数据目录
/// rounds/<轮 id>/；是否纳入本轮由前端在生成成功后调 round_add_candidates 决定
///（某项失败不影响其他项）。下载/安装编码器与编码都可能耗时（首次使用要联网下载），
/// 放阻塞线程池执行。
#[tauri::command]
async fn onestop_encode(
    group_id: String,
    round_id: String,
    reference_path: String,
    format: String,
    quality: Option<u8>,
    state: State<'_, AppState>,
) -> Result<OnestopProduct, String> {
    // 前置校验（持锁只做只读检查）：评测轮必须还在，且传入原图与本轮所选原图一致，
    // 防止往已删除的轮目录里写产物或给 A 轮产物挂到 B 轮原图名下。
    {
        let ws = state.workspace.lock().expect("工作区锁不应中毒");
        let (_, round) = find_round(&ws, &group_id, &round_id)?;
        if round.reference_path.as_deref() != Some(reference_path.as_str()) {
            return Err("传入的原图与本轮所选原图不一致，请重新触发一站式跑分".to_string());
        }
    }

    // 编码参数文本与产物路径一起回传（与 CLI 同出核心库 OnestopFormat 一处），
    // 前端纳入本轮时原样写入 encoding_params。格式串先过核心库解析（fail-fast）。
    let params = pixel_arena_core::encode::OnestopFormat::parse(&format)
        .map_err(|err| err.to_string())?
        .encoding_params_text(quality);

    let rounds_dir = state.rounds_dir.clone();
    let tools_dir = state.tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pixel_arena_core::encode::encode_onestop(
            &reference_path,
            &format,
            quality,
            rounds_dir.join(&round_id),
            tools_dir.as_path(),
        )
        .map(|product| OnestopProduct {
            path: product.to_string_lossy().into_owned(),
            encoding_params: params,
        })
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

/// IPC 命令（T15）：用 ffprobe 读取视频元信息（宽高/帧率/时长），逐帧对比的时间轴与
/// ±1 帧步进用。ffprobe 缺失时先走一次工具安装（与 ffmpeg 同一锁定来源，已就绪零开销），
/// 下载进度经 Channel 推给前端状态栏；探测失败返回中文错误，前端降级不禁查看。
#[tauri::command]
async fn video_probe_meta(
    path: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> Result<video_probe::VideoMeta, String> {
    let tools_dir = state.tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = ffmpeg_setup::ensure_ffprobe(&tools_dir, &mut |message| {
            let _ = on_progress.send(message);
        })?;
        video_probe::probe(&ffprobe, std::path::Path::new(&path))
    })
    .await
    .map_err(|err| format!("视频信息读取任务执行失败: {err}"))?
}

/// IPC 命令（T15）：注册视频文件到回环流服务，返回 <video> 可用的本地 HTTP 地址。
/// 这里只做登记：文件不存在/不可读由流服务响应 404，视频元素以中文提示兜底（不崩应用）。
#[tauri::command]
fn video_stream_url(path: String, state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.video_stream.register(std::path::Path::new(&path)))
}

/// IPC 命令（T13）：计算评测轮的 BD-rate 汇总，供结果区汇总表展示。
/// 与导出报告（round_export）调用核心库同一函数，保证界面与导出一致。
/// 纯内存计算（分组、拟合、积分），同步返回即可。
#[tauri::command]
fn round_bdrate(
    group_id: String,
    round_id: String,
    state: State<AppState>,
) -> Result<pixel_arena_core::bdrate::BdrateSummary, String> {
    let ws = state.workspace.lock().expect("工作区锁不应中毒");
    let (_, round) = find_round(&ws, &group_id, &round_id)?;
    Ok(pixel_arena_core::bdrate::summarize_round(round))
}

/// IPC 命令（T13）：把评测轮结果导出为报告文件。kind = "csv" | "html"；
/// path 来自前端 tauri-plugin-dialog 的保存对话框；generated_at 由前端生成传入，
/// 报告里只作展示。文件写入失败（路径不可写等）返回中文错误。
#[tauri::command]
fn round_export(
    group_id: String,
    round_id: String,
    kind: String,
    path: String,
    generated_at: String,
    state: State<AppState>,
) -> Result<String, String> {
    let ws = state.workspace.lock().expect("工作区锁不应中毒");
    export_round_file(&ws, &group_id, &round_id, &kind, &path, &generated_at)
}

/// 评测轮报告导出的实现体（T13）：定位组与轮 → 核心库序列化 → 写文件。
/// 抽成独立函数是为了不经 Tauri 运行时即可端到端测试（tests/export.rs）；
/// 与 round_bdrate 命令共用核心库同一份数据源，保证导出与界面一致。
pub fn export_round_file(
    ws: &Workspace,
    group_id: &str,
    round_id: &str,
    kind: &str,
    path: &str,
    generated_at: &str,
) -> Result<String, String> {
    let (group, round) = find_round(ws, group_id, round_id)?;

    let content = match kind {
        "csv" => pixel_arena_core::report::export_csv(&group.name, round, generated_at),
        "html" => pixel_arena_core::report::export_html(&group.name, round, generated_at),
        other => return Err(format!("不支持的导出格式: {other}（支持 csv / html）")),
    };
    std::fs::write(path, content).map_err(|err| format!("写入导出文件失败: {err}"))?;
    Ok(path.to_string())
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
            // T11：AVIF 产物的解码工具 avifdec 与 avifenc 同工件安装。启动时把确定性
            // 安装路径注入环境变量（已设置时尊重调用方覆盖），核心库解码入口按它分派
            //（首次生成 AVIF 时自动安装，之后重启即可直接跑分/显示；进程启动早期一次性
            // 设置，无并发写环境变量）。
            if std::env::var_os("PIXEL_ARENA_AVIFDEC").is_none() {
                if let Some(avifdec) = pixel_arena_core::decode::avif_decoder_path(&tools_dir) {
                    std::env::set_var("PIXEL_ARENA_AVIFDEC", avifdec);
                }
            }
            let video_stream = video_server::VideoStreamServer::spawn()
                .expect("视频流服务启动失败");
            app.manage(AppState {
                workspace: Arc::new(Mutex::new(Workspace::new())),
                path: Arc::new(dir.join("workspace.json")),
                tools_dir: Arc::new(tools_dir),
                rounds_dir: Arc::new(dir.join("rounds")),
                video_stream: Arc::new(video_stream),
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
            onestop_encode,
            // T21 单源化：一站式勾选目录（格式清单与默认质量档同出核心库取点）
            onestop_default_ladder,
            // T14 视频评测轮
            round_set_video_reference,
            round_add_video_candidates,
            round_score_video_candidate,
            video_ensure_ffmpeg,
            // T15 视频逐帧对比（ffprobe 元信息 + 回环流服务）
            video_probe_meta,
            video_stream_url,
            // T13 BD-rate 汇总与报告导出
            round_bdrate,
            round_export,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
