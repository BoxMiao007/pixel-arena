// Tauri 应用壳：所有应用逻辑都放在 lib.rs，main.rs 只做入口透传（tauri-v2 skill 约定，
// 保证未来若扩展到移动端时 Tauri 能替换入口点；本仓库当前只做桌面三端）。
//
// T05：跑分组与评测轮管理。核心库持全部数据模型与持久化逻辑，本文件只是薄客户端：
// 每个命令改内存工作区后立即写盘（改动即自动保存），并把最新状态整份返回给前端。
// T14：视频评测轮（原视频/跑分视频/ffmpeg 跑分）+ ffmpeg 工具下载（见 ffmpeg_setup.rs）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{ipc::Channel, Manager, State};

use pixel_arena_core::workspace::{Group, GroupKind, Round, Workspace, WorkspaceError};

use crate::settings::Settings;

mod ffmpeg_setup;
mod settings;
mod tool_status;
mod video_probe;
mod video_server;

/// T29-2：锁定 ffmpeg 版本号对外可见（设置页「关于」端到端测试读它核对锁定清单）。
pub use ffmpeg_setup::pinned_ffmpeg_version;

/// T29-2：设置页工具状态与「关于」的实现体（pub 供不经 Tauri 运行时端到端测试，
/// 沿 onestop_catalog_impl / export_round_file 先例）。
pub use tool_status::{about_info_impl, tool_status_impl};

/// 全局应用状态：内存中的工作区 + 工作区 JSON 文件路径 + ffmpeg 等外部工具目录。
/// Arc 让跑分这类耗时命令能把引用带进阻塞线程池（不持锁跨 await）。
struct AppState {
    workspace: Arc<Mutex<Workspace>>,
    path: Arc<PathBuf>,
    /// 编码器内置落位目录（应用数据目录 tools/，旧版本自动下载时代的既有安装继续
    /// 可用；运行期下载已移除，决策 0025）。
    tools_dir: Arc<PathBuf>,
    /// T29-4：安装包捆绑的编码器目录（<resource_dir>/encoders，只读随包分发）。
    /// 编码链定位顺序：设置覆盖 > 捆绑 resource_dir > 便携 exe 同目录 encoders/
    /// > tools/ 既有安装；都缺失 → 编码时报错指引官方发布页（决策 0025）。
    /// 目录可能不存在（未捆绑场景），所有读取都以 is_file 判定，缺失安全退化。
    /// 便携兜底解析见 [`resolve_bundled_encoders_dir`]（票 #43）。
    bundled_encoders: Arc<PathBuf>,
    /// 视频流服务（T15）：Linux 端 WebKitGTK 媒体引擎不走 asset 协议，视频元素从
    /// 127.0.0.1 回环地址拉流（见 video_server.rs）。
    video_stream: Arc<video_server::VideoStreamServer>,
    /// T23 设置中心：内存中的设置 + 设置文件路径（<app_data_dir>/settings.json，
    /// 与 workspace.json 分离）。设置只在保存时写盘，读盘只发生在启动。
    settings: Arc<Mutex<Settings>>,
    settings_path: Arc<PathBuf>,
}

/// IPC 命令：把核心库版本号交给前端显示。
#[tauri::command]
fn core_version() -> String {
    pixel_arena_core::version().to_string()
}

/// IPC 命令（T23）：读当前设置。
#[tauri::command]
fn settings_load(state: State<'_, AppState>) -> Settings {
    state.settings.lock().expect("设置锁不应中毒").clone()
}

/// IPC 命令（T23）：整体保存设置。空串路径先收成 None（清空恢复内置），
/// 再校验存在性（假路径当场报中文错误、不落盘），成功后返回保存后的设置。
#[tauri::command]
fn settings_save(settings: Settings, state: State<'_, AppState>) -> Result<Settings, String> {
    let settings = settings.normalized();
    settings.validate()?;
    settings.save_to_file(&state.settings_path)?;
    *state.settings.lock().expect("设置锁不应中毒") = settings.clone();
    Ok(settings)
}

/// IPC 命令（T29-2 设置页扩展）：检测 FFmpeg + 编码器的来源状态（内置/外部/
/// 未配置/不可用，含版本探测）。探测要跑子进程（-version），放阻塞线程池执行。
/// 前端在打开设置页与每次保存成功后调用——设置改完即重查，状态始终反映当前设置。
#[tauri::command]
async fn settings_tool_status(
    state: State<'_, AppState>,
) -> Result<Vec<tool_status::ToolStatus>, String> {
    let settings = state.settings.lock().expect("设置锁不应中毒").clone();
    let tools_dir = state.tools_dir.clone();
    let bundled = state.bundled_encoders.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(tool_status::tool_status_impl(&settings, tools_dir.as_path(), bundled.as_path()))
    })
    .await
    .map_err(|err| format!("工具状态检测任务执行失败: {err}"))?
}

/// IPC 命令（T29-2 设置页扩展）：「关于」区块数据。版本一律读锁定清单
///（决策 D18），纯内存构建，同步返回。
#[tauri::command]
fn about_info() -> tool_status::AboutInfo {
    tool_status::about_info_impl()
}

/// IPC 命令（T29-3 高级创建）：建轮前批量查一组工具键的可用性（条目编码器键 +
/// 视频侧 ffmpeg）。判定逻辑与设置页 tool_status 完全同源（tool_status_for_keys），
/// 只回请求的键、未知键跳过。探测要跑子进程（-version），放阻塞线程池执行。
#[tauri::command]
async fn advanced_encoder_status(
    keys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<tool_status::ToolStatus>, String> {
    let settings = state.settings.lock().expect("设置锁不应中毒").clone();
    let tools_dir = state.tools_dir.clone();
    let bundled = state.bundled_encoders.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(tool_status::tool_status_for_keys(
            &settings,
            tools_dir.as_path(),
            bundled.as_path(),
            &keys,
            &tool_status::probe_tool_version,
        ))
    })
    .await
    .map_err(|err| format!("编码器可用性检测任务执行失败: {err}"))?
}

/// IPC 命令（T29-4）：FFmpeg 检测（`ffmpeg -version`，5s 超时）。主界面警告条与
/// 创建测评轮入口警告的数据源；定位口径与视频跑分同源（有效外部路径优先 → 内置
/// 落位），纯只读不下载。结果不做缓存——设置页改动关闭后前端重调即刷新。
/// 探测要跑子进程，放阻塞线程池执行。
#[tauri::command]
async fn ffmpeg_check(state: State<'_, AppState>) -> Result<ffmpeg_setup::FFmpegDetection, String> {
    let tools_dir = state.tools_dir.clone();
    let custom_ffmpeg = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .ffmpeg_path
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ffmpeg_setup::detect_ffmpeg(
            tools_dir.as_path(),
            custom_ffmpeg.as_deref(),
        ))
    })
    .await
    .map_err(|err| format!("FFmpeg 检测任务执行失败: {err}"))?
}

/// IPC 命令（T29-4）：应用内下载 ffmpeg（锁定版本源 + sha256 校验，复用
/// ffmpeg_setup 既有安装流程）。T29-4 起这是唯一的下载入口，仅设置页调用；
/// 后台线程执行，下载/校验/解压进度经 Channel 推给设置页状态行。
#[tauri::command]
async fn ffmpeg_download(
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
    .map_err(|err| format!("ffmpeg 下载任务执行失败: {err}"))?
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

/// 产物编码命令回包（T30 冲突询问协议）：done = 产物已生成；conflict = 「询问」
/// 策略下目标名与已有文件冲突、尚未写入任何文件——前端弹窗拍板后带
/// `conflictDecision: "overwrite"` 重调（「跳过」则不再重调）。
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum OnestopOutcome {
    Done { product: OnestopProduct },
    Conflict { proposed_name: String },
}

/// 高级创建编码命令回包（协议同 [`OnestopOutcome]`）。
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum AdvancedOutcome {
    Done { product: pixel_arena_core::advanced::AdvancedProduct },
    Conflict { proposed_name: String },
}

/// 解析前端回传的冲突决定（T30）：None = 首次调用；"overwrite" = 用户拍板覆盖；
/// 「跳过」由前端直接不再重调，不经后端。未知值报中文错误（fail-fast）。
fn parse_conflict_decision(raw: Option<&str>) -> Result<bool, String> {
    match raw {
        None => Ok(false),
        Some("overwrite") => Ok(true),
        Some(other) => Err(format!("未知的冲突决定：{other}")),
    }
}

/// 「询问」策略的写入前冲突预检（T30）：设置策略为 ask 且用户尚未拍板覆盖时，
/// 探测目标名是否与已有文件冲突（口径同核心库 unique_file_name，大小写不敏感）；
/// 有冲突即返回 Some(目标名)（此时未写入任何文件），无冲突/无需询问返回 None。
fn product_conflict_probe(
    settings: &Settings,
    overwrite: bool,
    proposed_name: String,
    product_dir: &Path,
) -> Result<Option<String>, String> {
    if overwrite {
        return Ok(None);
    }
    if settings.conflict_policy != settings::FileConflictPolicy::Ask {
        return Ok(None);
    }
    let conflicted = pixel_arena_core::naming::file_name_conflicts(product_dir, &proposed_name)
        .map_err(|err| err.to_string())?;
    Ok(conflicted.then_some(proposed_name))
}

/// 预检通过后的核心库冲突策略：「询问」+ 已拍板覆盖 → Overwrite（确切名落位），
/// 其余（自动追加策略、或询问无冲突）→ AutoAppend（现状行为）。
fn core_conflict_policy(overwrite: bool) -> pixel_arena_core::naming::ConflictPolicy {
    if overwrite {
        pixel_arena_core::naming::ConflictPolicy::Overwrite
    } else {
        pixel_arena_core::naming::ConflictPolicy::AutoAppend
    }
}

#[cfg(test)]
mod conflict_protocol_tests {
    use super::*;

    #[test]
    fn outcome_serializes_kind_tag_and_camel_case_fields() {
        // T30 前端契约：tag=kind（done/conflict），字段 camelCase（proposedName）
        let done = OnestopOutcome::Done {
            product: OnestopProduct {
                path: "/tmp/a.png".to_string(),
                encoding_params: "PNG 无损".to_string(),
            },
        };
        let json = serde_json::to_string(&done).unwrap();
        assert!(json.contains("\"kind\":\"done\""), "{json}");
        // done 的产物嵌在 product 字段下（前端 OnestopEncodeOutcome 按此取值）
        assert!(
            json.contains("\"product\":{\"path\":\"/tmp/a.png\",\"encodingParams\":\"PNG 无损\"}"),
            "{json}"
        );

        let conflict = OnestopOutcome::Conflict {
            proposed_name: "a_png.png".to_string(),
        };
        let json = serde_json::to_string(&conflict).unwrap();
        assert_eq!(json, r#"{"kind":"conflict","proposedName":"a_png.png"}"#);
    }

    #[test]
    fn conflict_decision_rejects_unknown_values() {
        assert!(!parse_conflict_decision(None).unwrap());
        assert!(parse_conflict_decision(Some("overwrite")).unwrap());
        assert!(parse_conflict_decision(Some("跳过")).is_err());
    }
}

#[cfg(test)]
mod portable_encoders_tests {
    use super::*;

    /// 在目录里造一个假捆绑成员（内容无所谓，消费端只看 is_file）。
    fn make_member(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let member = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        let path = dir.join(&member);
        std::fs::write(&path, b"placeholder").unwrap();
        path
    }

    #[test]
    fn resource_dir_with_members_wins() {
        // resource_dir/encoders 有效捆绑：即使 exe 同目录也有 encoders/ 也以 resource_dir 优先
        let resource = tempfile::tempdir().unwrap();
        let exe = tempfile::tempdir().unwrap();
        let resource_encoders = resource.path().join("encoders");
        make_member(&resource_encoders, "cjpeg");
        make_member(&exe.path().join("encoders"), "cjpeg");
        let resolved = resolve_bundled_encoders_dir(Some(&resource_encoders), Some(exe.path()));
        assert_eq!(resolved, resource_encoders);
    }

    #[test]
    fn portable_exe_dir_fallback_when_resource_missing() {
        // 票 #43 主场景：resource_dir 无捆绑成员（Err 或目录为空都算），exe 同目录
        // encoders/ 有成员 → 便携 zip 解压形态命中
        let resource = tempfile::tempdir().unwrap();
        let exe = tempfile::tempdir().unwrap();
        let portable_encoders = exe.path().join("encoders");
        make_member(&portable_encoders, "cjxl");
        // resource_dir 解析失败（None）
        let resolved = resolve_bundled_encoders_dir(None, Some(exe.path()));
        assert_eq!(resolved, portable_encoders);
        // resource_dir 存在但没有成员（目录/空目录）
        let resolved = resolve_bundled_encoders_dir(Some(&resource.path().join("encoders")), Some(exe.path()));
        assert_eq!(resolved, portable_encoders);
    }

    #[test]
    fn both_missing_returns_nonexistent_sentinel() {
        // 两处都没有编码器：返回标记性不存在路径（消费端 is_file 判定退化到 tools/）
        let resource = tempfile::tempdir().unwrap();
        let exe = tempfile::tempdir().unwrap();
        let resolved = resolve_bundled_encoders_dir(
            Some(&resource.path().join("encoders")),
            Some(exe.path()),
        );
        assert!(!resolved.is_file(), "哨兵路径不应命中任何文件：{}", resolved.display());
        // 单独验证 exe 同目录没有 encoders/ 时也不会误判（目录存在但无成员）
        std::fs::create_dir_all(exe.path().join("encoders")).unwrap();
        let resolved = resolve_bundled_encoders_dir(None, Some(exe.path()));
        assert!(!resolved.is_file());
    }

    #[test]
    fn sentinel_path_is_same_as_legacy_fallback_shape() {
        // 哨兵路径与旧 fallback 同形（相对不存在路径），消费端行为不变
        let resolved = resolve_bundled_encoders_dir(None, None);
        assert_eq!(resolved, PathBuf::from(".不存在的捆绑目录"));
    }
}

/// 启动时从磁盘恢复工作区。文件不存在（首次启动）回落到空工作区；
/// 其余加载失败（坏 JSON、版本不支持等）如实上报，界面提示用户。
/// T23：记录状态关闭时做干净启动——不读 workspace.json、返回空工作区；
/// 空工作区不会写盘（写盘只发生在改动），上次保存的数据原样保留。
#[tauri::command]
fn workspace_load(state: State<AppState>) -> Result<Workspace, String> {
    let mut ws = state.workspace.lock().expect("工作区锁不应中毒");
    if !state.settings.lock().expect("设置锁不应中毒").record_state {
        *ws = Workspace::new();
        return Ok(ws.clone());
    }
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
/// fb3/issue #28：建组自动附带一个同类型评测轮（核心库 create_group_with_round）。
#[tauri::command]
fn group_create(name: String, kind: String, state: State<AppState>) -> Result<Workspace, String> {
    let kind = GroupKind::parse(&kind).map_err(|err| err.to_string())?;
    mutate(&state, |ws| ws.create_group_with_round(&name, kind).map(|_| ()))
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

/// IPC 命令（T29-3）：写轮级备注（视频高级创建确认后把编码器配置摘要与命令行
/// 落进新轮，配置不白丢）。note 传 null / 空白 = 清空。
#[tauri::command]
fn round_set_note(
    group_id: String,
    round_id: String,
    note: Option<String>,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| ws.set_round_note(&group_id, &round_id, note.as_deref()))
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

/// 批量跑分的进度事件（T24）：N/M 推给前端状态栏（completed 单调递增到 total）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreProgress {
    completed: u32,
    total: u32,
}

/// 按当前设置的并发度档位换算线程上限（核心库统一换算：floor 核数×比例，
/// 夹在 [1, 逻辑核数]；默认 half = 只用一半核心留余量）。
fn score_concurrency_limit(state: &AppState) -> usize {
    let fraction = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .score_concurrency
        .fraction();
    pixel_arena_core::parallel::concurrency_limit(fraction)
}

/// 把核心库进度回调（已完成数, 总数）转发到 IPC Channel（图片与视频两个整轮
/// 跑分命令共用，审查修复 C10）。推送失败静默：Channel 随前端重挂等场景可能
/// 已关闭，进度只是展示，不影响跑分本身。
fn forward_score_progress(channel: &Channel<ScoreProgress>, completed: usize, total: usize) {
    let _ = channel.send(ScoreProgress {
        completed: completed as u32,
        total: total as u32,
    });
}

/// IPC 命令（T24）：对评测轮的全部跑分图整轮并行跑分（一次 IPC 提交整轮）。
/// 并发度来自设置（默认一半逻辑核），进度经 Channel 推给前端（N/M）；
/// 单张失败不报错——中文原因由核心库写进行内，界面标「失败」。
#[tauri::command]
async fn round_score_candidates(
    group_id: String,
    round_id: String,
    on_progress: Channel<ScoreProgress>,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let max_concurrency = score_concurrency_limit(&state);
    let workspace = state.workspace.clone();
    let path = state.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ws = workspace.lock().expect("工作区锁不应中毒");
        ws.score_round_candidates_parallel(&group_id, &round_id, max_concurrency, &|completed,
                                                                                    total| {
            forward_score_progress(&on_progress, completed, total);
        })
        .map_err(|err| err.to_string())?;
        ws.save_to_file(&path).map_err(|err| err.to_string())?;
        Ok(ws.clone())
    })
    .await
    .map_err(|err| format!("跑分任务执行失败: {err}"))?
}

/// IPC 命令（T18）：从评测轮移除一张跑分图（胶囊上的 × 单独移除）。
/// 同步命令：只改内存列表并写盘，无耗时计算。
#[tauri::command]
fn round_remove_candidate(
    group_id: String,
    round_id: String,
    candidate_path: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.remove_round_candidate(&group_id, &round_id, &candidate_path)
    })
}

/// IPC 命令（审查修复 B6/US22）：给一张跑分图设置/清除备注（大小优先不可达标注）。
/// 备注随评测轮持久化，重启后结果表与导出仍能显示。同步命令，走既有 mutate。
#[tauri::command]
fn round_set_candidate_note(
    group_id: String,
    round_id: String,
    candidate_path: String,
    note: Option<String>,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.set_round_candidate_note(&group_id, &round_id, &candidate_path, note.as_deref())
    })
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
pub fn onestop_catalog_impl() -> OnestopCatalog {
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

/// IPC 命令：一站式勾选目录（T21 单源化，数据源见 onestop_catalog_impl；
/// 审查修复 C8：原名 onestop_default_ladder 名不副实——载荷是格式清单目录，
/// 不是阶梯，改名 onestop_catalog）。
#[tauri::command]
fn onestop_catalog() -> OnestopCatalog {
    onestop_catalog_impl()
}

/// 一站式阶梯项（onestop_quality_ladder 回传）：格式 + 质量（无损组为 null）+ 进度显示名。
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LadderItemDto {
    pub format: String,
    pub quality: Option<u8>,
    pub label: String,
}

/// 构建质量优先编码阶梯（T22）：统一基准 0–100 → 核心库 quality_ladder 取点
///（每格式 ≥3 点 + 无损对照组，核心库单一实现）。pub 供不经 Tauri 运行时端到端
/// 测试（沿 onestop_catalog_impl 先例）。
pub fn onestop_quality_ladder_impl(baseline: u8) -> Result<Vec<LadderItemDto>, String> {
    pixel_arena_core::ladder::quality_ladder(baseline)
        .map(|items| {
            items
                .into_iter()
                .map(|item| LadderItemDto {
                    format: item.format,
                    quality: item.quality,
                    label: item.label,
                })
                .collect()
        })
        .map_err(|err| err.to_string())
}

/// IPC 命令：质量优先取点（T22）。前端拉杆 change 时调用，重渲染阶梯预览并在
/// 触发一站式跑分时展开生成清单。纯计算，同步返回。
#[tauri::command]
fn onestop_quality_ladder(baseline: u8) -> Result<Vec<LadderItemDto>, String> {
    onestop_quality_ladder_impl(baseline)
}

/// 大小优先搜索的一个质量点：质量 + 探测到的实际产物大小（字节）。
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SizePointDto {
    pub quality: u8,
    pub bytes: u64,
}

/// 大小优先单格式搜索结果（onestop_size_search 回传，字段与前端 onestop.ts 消费一致）。
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SizeSearchDto {
    pub format: String,
    pub target_bytes: u64,
    /// 逼近目标选中的质量点（不可达时为最小/最高质量点）。
    pub hit: SizePointDto,
    /// 不可达标注（核心库 annotation_note 中文单一来源，与 CLI note 列同源）；可达为 null。
    pub note: Option<String>,
    /// 命中点 + 邻近补点（升序 ≥3 点，US23 保 BD-rate 率失真曲线），每点带实测大小。
    pub points: Vec<SizePointDto>,
}

/// 大小优先单格式搜索的实现体（pub 供不经 Tauri 运行时测试）。探测编码到暂存目录
/// 即弃（沿 CLI 大小优先先例），产物落盘仍由前端随后逐档调 onestop_encode 完成。
/// 编码器覆盖随调用传入：探测与正式产物（onestop_encode）必须出自同一编码器，
/// 否则「搜出的大小」对不上「真实产物」（审查修复 A1）。
pub fn onestop_size_search_impl(
    reference: &str,
    format: &str,
    target_bytes: u64,
    tools_dir: &std::path::Path,
    overrides: &pixel_arena_core::encode::EncoderOverrides,
) -> Result<SizeSearchDto, String> {
    let format = pixel_arena_core::encode::OnestopFormat::parse(format)
        .map_err(|err| err.to_string())?;
    // 无损对照组大小固定、不参与搜索（前端不会传，fail-fast 兜底；
    // 文案与核心库探测缝同出 OnestopFormat::require_lossy 单一来源）
    format.require_lossy().map_err(|err| err.to_string())?;
    let scratch = tempfile::tempdir().map_err(|err| format!("无法创建探测暂存目录：{err}"))?;
    let result = pixel_arena_core::ladder::size_search(format, target_bytes, &mut |quality| {
        pixel_arena_core::encode::probe_onestop_size(
            reference,
            format,
            quality,
            scratch.path(),
            tools_dir,
            overrides,
        )
    })
    .map_err(|err| err.to_string())?;
    // 标注文本先取（借用 result），format 的 String 再 move 出来
    let note = result.annotation_note();
    let format = result.format.clone();
    Ok(SizeSearchDto {
        format,
        target_bytes: result.target_bytes,
        hit: SizePointDto {
            quality: result.hit.quality,
            bytes: result.hit.bytes,
        },
        note,
        points: result
            .points
            .iter()
            .map(|point| SizePointDto {
                quality: point.quality,
                bytes: point.bytes,
            })
            .collect(),
    })
}

/// IPC 命令：大小优先单格式逼近搜索（T22）。前端对每个勾选的有损格式逐次调用，
/// 每次调用天然形成进度；探测可能真实编码多次（约 2+log2(99) 次/格式），放阻塞
/// 线程池执行。前置校验与 onestop_encode 一致：轮必须存在且原图一致。
#[tauri::command]
async fn onestop_size_search(
    group_id: String,
    round_id: String,
    reference_path: String,
    format: String,
    target_bytes: u64,
    state: State<'_, AppState>,
) -> Result<SizeSearchDto, String> {
    {
        let ws = state.workspace.lock().expect("工作区锁不应中毒");
        let (_, round) = find_round(&ws, &group_id, &round_id)?;
        if round.reference_path.as_deref() != Some(reference_path.as_str()) {
            return Err("传入的原图与本轮所选原图不一致，请重新触发一站式跑分".to_string());
        }
    }
    let tools_dir = state.tools_dir.clone();
    // T23：设置中心的编码器覆盖同样作用于大小优先探测——探测与 onestop_encode 的
    // 正式产物必须出自同一编码器（审查修复 A1）
    let overrides = to_core_overrides(
        &state.settings.lock().expect("设置锁不应中毒").encoder_overrides,
        state.bundled_encoders.as_path(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        onestop_size_search_impl(&reference_path, &format, target_bytes, tools_dir.as_path(), &overrides)
    })
    .await
    .map_err(|err| format!("大小优先搜索任务执行失败: {err}"))?
}


/// IPC 命令：一站式模式按（格式, 质量）逐次生成一份跑分产物（T11 完整编码阶梯）。
/// 格式标识：jpeg / webp / avif / jxl（有损，quality 必填）与 png / webp-lossless /
/// jxl-lossless（无损对照组，quality 必须为 null）。产物写到原图所在目录的
/// 「Pixel Arena」文件夹（T29-1，决策 D5：已存在直接复用，不可写报中文错误，用户可
/// 中止或更换位置）；是否纳入本轮由前端在生成成功后调 round_add_candidates 决定
///（某项失败不影响其他项）。下载/安装编码器与编码都可能耗时（首次使用要联网下载），
/// 放阻塞线程池执行。
#[tauri::command]
async fn onestop_encode(
    group_id: String,
    round_id: String,
    reference_path: String,
    format: String,
    quality: Option<u8>,
    conflict_decision: Option<String>,
    state: State<'_, AppState>,
) -> Result<OnestopOutcome, String> {
    // 前置校验（持锁只做只读检查）：评测轮必须还在，且传入原图与本轮所选原图一致，
    // 防止给 A 轮产物挂到 B 轮原图名下。
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

    // T29-1（决策 D5）：产物输出到原图旁的「Pixel Arena」文件夹，不再写应用数据
    // 隔离目录；目录在编码前建好并探针可写性（不可写当场报错，用户可中止/更换）。
    let product_dir = pixel_arena_core::naming::product_output_dir(Path::new(&reference_path))
        .map_err(|err| err.to_string())?;
    pixel_arena_core::naming::ensure_output_dir_writable(&product_dir).map_err(|err| err.to_string())?;

    // T30 冲突询问：设置策略为「询问」且尚未拍板时，写入前探测目标名冲突——
    // 有冲突回 Conflict（未写入任何文件），等前端弹窗拍板后带决定重调
    let overwrite = parse_conflict_decision(conflict_decision.as_deref())?;
    let settings = state.settings.lock().expect("设置锁不应中毒").clone();
    if let Some(proposed_name) = product_conflict_probe(
        &settings,
        overwrite,
        pixel_arena_core::encode::onestop_product_name(&reference_path, &format, quality)
            .map_err(|err| err.to_string())?,
        &product_dir,
    )? {
        return Ok(OnestopOutcome::Conflict { proposed_name });
    }

    let tools_dir = state.tools_dir.clone();
    // T23：设置中心的编码器路径覆盖随命令带入（None 项走内置自动安装路径）
    let overrides = to_core_overrides(&settings.encoder_overrides, state.bundled_encoders.as_path());
    let conflict = core_conflict_policy(overwrite);
    tauri::async_runtime::spawn_blocking(move || {
        pixel_arena_core::encode::encode_onestop(
            &reference_path,
            &format,
            quality,
            product_dir,
            tools_dir.as_path(),
            &overrides,
            conflict,
        )
        .map(|product| OnestopOutcome::Done {
            product: OnestopProduct {
                path: product.to_string_lossy().into_owned(),
                encoding_params: params,
            },
        })
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("编码任务执行失败: {err}"))?
}

// ---------- 高级创建（T29-3，决策 D10–D14/D19/D20） ----------

/// IPC 命令：高级创建的图片编码器规格清单（质量范围 / 无损能力 / 推荐参数，
/// 全部来自核心库静态规格表，纯内存同步返回）。
#[tauri::command]
fn advanced_image_catalog() -> Vec<pixel_arena_core::advanced::ImageEncoderSpec> {
    pixel_arena_core::advanced::image_specs()
}

/// 高级创建的视频编码器目录（advanced_video_catalog 回传）：ffmpeg 可用性 +
/// `ffmpeg -encoders` 动态枚举的编码器名 + 四条静态映射规格（决策 D12–D14）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedVideoCatalog {
    pub ffmpeg_available: bool,
    pub ffmpeg_path: Option<String>,
    pub ffmpeg_error: Option<String>,
    pub encoder_names: Vec<String>,
    pub specs: Vec<pixel_arena_core::advanced::VideoEncoderSpec>,
}

/// 视频编码器目录的实现体（pub 供不经 Tauri 运行时测试）：ffmpeg 定位与一站式
/// 同源（设置页外部路径优先，缺省内置安装）；枚举失败不阻塞面板——规格四条照常
/// 可选，只是表外名称拿不到。
pub fn advanced_video_catalog_impl(
    tools_dir: &Path,
    custom_ffmpeg: Option<&str>,
) -> AdvancedVideoCatalog {
    let specs = pixel_arena_core::advanced::video_specs();
    match ffmpeg_setup::resolve_ffmpeg(tools_dir, custom_ffmpeg) {
        Ok(ffmpeg) => {
            let encoder_names = match std::process::Command::new(&ffmpeg)
                .arg("-hide_banner")
                .arg("-encoders")
                .output()
            {
                Ok(output) if output.status.success() => {
                    pixel_arena_core::advanced::parse_ffmpeg_encoders(&String::from_utf8_lossy(
                        &output.stdout,
                    ))
                }
                _ => Vec::new(),
            };
            AdvancedVideoCatalog {
                ffmpeg_available: true,
                ffmpeg_path: Some(ffmpeg.display().to_string()),
                ffmpeg_error: None,
                encoder_names,
                specs,
            }
        }
        Err(err) => AdvancedVideoCatalog {
            ffmpeg_available: false,
            ffmpeg_path: None,
            ffmpeg_error: Some(err),
            encoder_names: Vec::new(),
            specs,
        },
    }
}

/// IPC 命令：高级创建的视频编码器目录（决策 D14 动态枚举 + 静态映射表）。枚举要
/// 跑 `ffmpeg -encoders` 子进程，放阻塞线程池执行。
#[tauri::command]
async fn advanced_video_catalog(state: State<'_, AppState>) -> Result<AdvancedVideoCatalog, String> {
    let tools_dir = state.tools_dir.clone();
    let custom_ffmpeg = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .ffmpeg_path
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(advanced_video_catalog_impl(tools_dir.as_path(), custom_ffmpeg.as_deref()))
    })
    .await
    .map_err(|err| format!("视频编码器目录任务执行失败: {err}"))?
}

/// IPC 命令：高级创建按单个编码任务生成一份跑分产物。与 onestop_encode 同一套
/// 前置校验（轮存在 + 原图一致）与产物输出目录（原图旁「Pixel Arena」文件夹）；
/// 参数合并 / 同标志冲突在核心库 fail-fast（坏参数不联网不编码）。产物由前端
/// round_add_candidates（带 encodingParams）纳入本轮。
#[tauri::command]
async fn advanced_encode(
    group_id: String,
    round_id: String,
    reference_path: String,
    job: pixel_arena_core::advanced::AdvancedImageJob,
    conflict_decision: Option<String>,
    state: State<'_, AppState>,
) -> Result<AdvancedOutcome, String> {
    // 前置校验（持锁只做只读检查）：与 onestop_encode 同一口径
    {
        let ws = state.workspace.lock().expect("工作区锁不应中毒");
        let (_, round) = find_round(&ws, &group_id, &round_id)?;
        if round.reference_path.as_deref() != Some(reference_path.as_str()) {
            return Err("传入的原图与本轮所选原图不一致，请重新触发高级创建".to_string());
        }
    }
    // T29-1（决策 D5）：产物输出到原图旁的「Pixel Arena」文件夹，编码前建好并探针可写性
    let product_dir = pixel_arena_core::naming::product_output_dir(Path::new(&reference_path))
        .map_err(|err| err.to_string())?;
    pixel_arena_core::naming::ensure_output_dir_writable(&product_dir).map_err(|err| err.to_string())?;

    // T30 冲突询问：与 onestop_encode 同一协议。目标名经核心库 advanced_product_name
    // 计算（大小优先模式会先跑逼近搜索——写入前拿到确切名的必要成本，见其文档）。
    let overwrite = parse_conflict_decision(conflict_decision.as_deref())?;
    let settings = state.settings.lock().expect("设置锁不应中毒").clone();
    let tools_dir = state.tools_dir.clone();
    let overrides = to_core_overrides(&settings.encoder_overrides, state.bundled_encoders.as_path());
    // 预检名字在阻塞线程池算（大小优先的逼近搜索要跑探测编码）；所需的引用数据
    // 克隆进去，原值留给下方编码任务复用
    let proposed = {
        let reference_path = reference_path.clone();
        let tools_dir = tools_dir.clone();
        let overrides = overrides.clone();
        let job = job.clone();
        tauri::async_runtime::spawn_blocking(move || {
            pixel_arena_core::advanced::advanced_product_name(
                &reference_path,
                &job,
                tools_dir.as_path(),
                &overrides,
            )
            .map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("产物名计算任务执行失败: {err}"))??
    };
    if let Some(proposed_name) =
        product_conflict_probe(&settings, overwrite, proposed, &product_dir)?
    {
        return Ok(AdvancedOutcome::Conflict { proposed_name });
    }

    let conflict = core_conflict_policy(overwrite);
    tauri::async_runtime::spawn_blocking(move || {
        pixel_arena_core::advanced::encode_advanced_image(
            &reference_path,
            &job,
            product_dir,
            tools_dir.as_path(),
            &overrides,
            conflict,
        )
        .map(|product| AdvancedOutcome::Done { product })
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("高级创建编码任务执行失败: {err}"))?
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

/// IPC 命令（T18）：从评测轮移除一段跑分视频（胶囊上的 × 单独移除）。
#[tauri::command]
fn round_remove_video_candidate(
    group_id: String,
    round_id: String,
    candidate_path: String,
    state: State<AppState>,
) -> Result<Workspace, String> {
    mutate(&state, |ws| {
        ws.remove_round_video_candidate(&group_id, &round_id, &candidate_path)
    })
}

/// IPC 命令（T24）：对评测轮的全部跑分视频整轮并行跑分（一次 IPC 提交整轮）。
/// 同时打开的 ffmpeg 进程数受设置的同一并发上限约束（票面要求）；进度经 Channel
/// 推给前端（N/M）；单段失败不报错——中文原因由核心库写进行内（含耗时）。
/// T29-4：ffmpeg 未配置（未下载且无外部路径）时 resolve_ffmpeg 直接报中文错误
/// 指引设置页，不再自动下载（下载入口仅设置页）。
#[tauri::command]
async fn round_score_video_candidates(
    group_id: String,
    round_id: String,
    on_progress: Channel<ScoreProgress>,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let max_concurrency = score_concurrency_limit(&state);
    let workspace = state.workspace.clone();
    let path = state.path.clone();
    let tools_dir = state.tools_dir.clone();
    // T29-2：设置页的 FFmpeg 路径覆盖随命令读入（外部优先），改动对后续跑分立即生效
    let custom_ffmpeg = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .ffmpeg_path
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = ffmpeg_setup::resolve_ffmpeg(&tools_dir, custom_ffmpeg.as_deref())?;
        let mut ws = workspace.lock().expect("工作区锁不应中毒");
        ws.score_round_video_candidates_parallel(
            &group_id,
            &round_id,
            &ffmpeg,
            max_concurrency,
            &|completed, total| forward_score_progress(&on_progress, completed, total),
        )
        .map_err(|err| err.to_string())?;
        ws.save_to_file(&path).map_err(|err| err.to_string())?;
        Ok(ws.clone())
    })
    .await
    .map_err(|err| format!("视频跑分任务执行失败: {err}"))?
}

/// IPC 命令（T15）：用 ffprobe 读取视频元信息（宽高/帧率/时长），逐帧对比的时间轴与
/// ±1 帧步进用。T29-4：ffprobe 未配置时 resolve_ffprobe 返回中文错误（不再自动
/// 下载），前端降级禁用逐帧对比，不崩应用。
#[tauri::command]
async fn video_probe_meta(
    path: String,
    on_progress: Channel<String>,
    state: State<'_, AppState>,
) -> Result<video_probe::VideoMeta, String> {
    let tools_dir = state.tools_dir.clone();
    // T29-2：FFmpeg 路径覆盖同样作用于 ffprobe 定位（优先取外部 ffmpeg 同目录的
    // ffprobe，同目录没有则回落内置安装），保证探测与跑分用的是同一套外部工具
    let custom_ffmpeg = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .ffmpeg_path
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        // on_progress 通道保留（前端 invoke 仍传 onProgress）：定位不产生进度消息，
        // 历史占位，待 IPC 契约一并清理时移除
        let _ = on_progress;
        let ffprobe = ffmpeg_setup::resolve_ffprobe(&tools_dir, custom_ffmpeg.as_deref())?;
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

/// 票 #43 便携兜底：目录里是否存在任一捆绑编码器成员（五成员同进同出，由
/// bundle-encoders.* 整体就位，故「任一存在」即可认定该目录是有效捆绑目录；
/// 平台后缀按编译目标判断）。
fn has_encoder_members(dir: &Path) -> bool {
    ["cjpeg", "cwebp", "avifenc", "avifdec", "cjxl"].iter().any(|name| {
        let member = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        dir.join(member).is_file()
    })
}

/// 票 #43 便携兜底：捆绑编码器目录解析。优先级（整目录二选一，逐成员消费端
/// 不变）：resource_dir/encoders（NSIS/MSI 等安装形态）> exe 同目录 encoders/
///（便携 zip 解压形态）> 返回标记性不存在路径（消费端 is_file 判定安全退化，
/// 再落到 tools/ 既有安装）。Windows 裸跑 resource_dir 的实际落点无法在本机
/// 实测，故无论其命中与否都保留该回落；两个路径均由调用方注入，单测不依赖
/// 真实 exe 位置。
fn resolve_bundled_encoders_dir(
    resource_encoders: Option<&Path>,
    exe_dir: Option<&Path>,
) -> PathBuf {
    if let Some(dir) = resource_encoders.filter(|dir| has_encoder_members(dir)) {
        return dir.to_path_buf();
    }
    if let Some(portable) = exe_dir
        .map(|dir| dir.join("encoders"))
        .filter(|dir| has_encoder_members(dir))
    {
        return portable;
    }
    PathBuf::from(".不存在的捆绑目录")
}

/// T23：设置里的编码器覆盖 → 核心库 EncoderOverrides（一次性编码调用携带，
/// 不做进程级全局状态；CLI 侧恒为默认值，行为只由命令行参数决定）。
/// T29-4 捆绑语义：覆盖为空的项优先解析安装包捆绑的编码器
///（bundled/encoders/<member>，只读随包分发），捆绑也缺失才留 None（核心库按
/// tools/ 既有落位解析，都没有则报错指引官方发布页，决策 0025）。捆绑与 tools/
/// 同时存在时捆绑优先，与设置页状态徽标（tool_status）口径一致。
/// bundled_encoders 已由 [`resolve_bundled_encoders_dir`] 做 portable 兜底（票 #43）。
fn to_core_overrides(
    over: &settings::EncoderOverrides,
    bundled_encoders: &Path,
) -> pixel_arena_core::encode::EncoderOverrides {
    let member = |name: &str| -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    };
    // 覆盖（非空文本）优先；否则捆绑文件存在即用捆绑
    let resolve = |raw: &Option<String>, name: &str| -> Option<PathBuf> {
        if let Some(path) = raw.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            return Some(PathBuf::from(path));
        }
        let bundled = bundled_encoders.join(member(name));
        bundled.is_file().then_some(bundled)
    };
    pixel_arena_core::encode::EncoderOverrides {
        cjpeg: resolve(&over.cjpeg, "cjpeg"),
        cwebp: resolve(&over.cwebp, "cwebp"),
        avifenc: resolve(&over.avifenc, "avifenc"),
        cjxl: resolve(&over.cjxl, "cjxl"),
    }
}

/// T23：把 AVIF 代片解码器（avifdec）的定位注入 PIXEL_ARENA_AVIFDEC 环境变量
///（decode.rs 按它分派）。优先级：设置中心自定义路径 > 安装包捆绑的 avifdec
///（T29-4）> tools/ 内置安装路径。启动与每次保存设置后调用；decode 侧逐次读取
/// 环境变量，改动即时生效。
fn apply_avifdec_env(state: &AppState) {
    let custom = state
        .settings
        .lock()
        .expect("设置锁不应中毒")
        .encoder_overrides
        .avifdec
        .clone();
    if let Some(path) = custom {
        std::env::set_var("PIXEL_ARENA_AVIFDEC", path);
        return;
    }
    // 未设置覆盖：先看安装包捆绑的 avifdec（只在真实存在时注入——资源目录不存在
    // 的场景安全退化），再保持既有行为——内置安装路径存在时注入（已注入则不动）
    if std::env::var_os("PIXEL_ARENA_AVIFDEC").is_some() {
        return;
    }
    let bundled = state
        .bundled_encoders
        .join(if cfg!(windows) { "avifdec.exe" } else { "avifdec" });
    if bundled.is_file() {
        std::env::set_var("PIXEL_ARENA_AVIFDEC", bundled);
        return;
    }
    if let Some(avifdec) = pixel_arena_core::decode::avif_decoder_path(state.tools_dir.as_path()) {
        std::env::set_var("PIXEL_ARENA_AVIFDEC", avifdec);
    }
}

/// T23：记录状态开启时，按设置恢复主窗口大小（逻辑像素，与 DPI 无关）。
/// 只恢复宽高不恢复位置（票面范围是「窗口大小」）；关闭时保持配置里的默认尺寸。
fn restore_window_size(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let (record_state, window_size) = {
        let settings = state.settings.lock().expect("设置锁不应中毒");
        (settings.record_state, settings.window)
    };
    if !record_state {
        return;
    }
    if let (Some(window), Some(size)) = (app.get_webview_window("main"), window_size) {
        let _ = window.set_size(tauri::LogicalSize::new(size.width, size.height));
    }
}

/// T23：把当前主窗口大小记进设置文件（逻辑像素，与 DPI 无关；仅记录状态开启、
/// 窗口未最大化时）。读-改-写 settings.json，只动 window 字段，值没变不重写。
/// 记录时机挂窗口 Resized 事件持续记录而非退出时一次性记录：实测（WSLg/X11）关窗
/// 会触发致命 X 错误（BadDrawable），GDK 直接终止进程，事件循环收不到任何关闭
/// 事件（CloseRequested/ExitRequested 均不达）；Resized 事件则始终可达，且顺带
/// 兜住崩溃退出。Windows/macOS 上关窗事件正常，CloseRequested 兜底写一次终值。
fn record_window_size(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if !state.settings.lock().expect("设置锁不应中毒").record_state {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(physical) = window.inner_size() else {
        return;
    };
    let logical = physical.to_logical::<f64>(scale);
    // 最小尺寸下限兜底：防止最小化/异常尺寸（配置里 minWidth 800）被记成普通尺寸
    if logical.width < 100.0 || logical.height < 100.0 {
        return;
    }
    let new_size = Some(settings::WindowSize {
        width: logical.width,
        height: logical.height,
    });
    let mut settings = state.settings.lock().expect("设置锁不应中毒").clone();
    if settings.window == new_size {
        return;
    }
    settings.window = new_size;
    if let Err(err) = settings.save_to_file(&state.settings_path) {
        // 记窗口大小失败不炸主流程，但要能在 stderr 定位（设置文件不可写等）
        eprintln!("记录窗口大小到 settings.json 失败：{err}");
        return;
    }
    *state.settings.lock().expect("设置锁不应中毒") = settings;
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
            // T23：加载设置（坏文件 fail-soft 回默认，见 settings.rs 模块头）。
            // avifdec 覆盖在 apply_avifdec_env 里处理：设置了自定义路径则盖过上面的注入。
            let settings = Settings::load_from_file(&dir.join("settings.json"));
            let video_stream = video_server::VideoStreamServer::spawn()
                .expect("视频流服务启动失败");
            // T29-4：安装包捆绑的编码器目录（tauri.conf.json bundle.resources 打包，
            // 本地/裸构建可能不存在，读取处均以 is_file 判定安全退化）。
            // 票 #43：resource_dir/encoders 缺成员时回落 exe 同目录 encoders/
            //（便携 zip 解压形态），两个候选目录任一有效即用。
            let resource_encoders = app.path().resource_dir().ok().map(|dir| dir.join("encoders"));
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf));
            let bundled_encoders = resolve_bundled_encoders_dir(
                resource_encoders.as_deref(),
                exe_dir.as_deref(),
            );
            app.manage(AppState {
                workspace: Arc::new(Mutex::new(Workspace::new())),
                path: Arc::new(dir.join("workspace.json")),
                tools_dir: Arc::new(tools_dir),
                bundled_encoders: Arc::new(bundled_encoders),
                video_stream: Arc::new(video_stream),
                settings: Arc::new(Mutex::new(settings.clone())),
                settings_path: Arc::new(dir.join("settings.json")),
            });
            apply_avifdec_env(app.state::<AppState>().inner());
            // 记录状态开启时恢复上次窗口大小（关闭 = 配置里的默认尺寸）
            restore_window_size(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            core_version,
            // T23 设置中心
            settings_load,
            settings_save,
            // T29-2 设置页扩展：工具状态检测与「关于」
            settings_tool_status,
            about_info,
            workspace_load,
            group_create,
            group_rename,
            group_close,
            group_activate,
            round_create,
            round_rename,
            // T29-3：轮级备注（视频高级创建确认后落地配置）
            round_set_note,
            round_delete,
            round_activate,
            round_set_reference,
            round_add_candidates,
            round_remove_candidate,
            // US22：大小优先不可达标注持久化
            round_set_candidate_note,
            // T24 整轮并行跑分（并发度来自设置中心）
            round_score_candidates,
            onestop_encode,
            // T21 单源化：一站式勾选目录（格式清单与默认质量档同出核心库取点）
            onestop_catalog,
            // T22：质量优先取点与大小优先逼近搜索
            onestop_quality_ladder,
            onestop_size_search,
            // T29-3 高级创建：图片/视频编码器目录与按任务编码
            advanced_image_catalog,
            advanced_video_catalog,
            advanced_encode,
            // T29-3 高级创建：建轮前批量查编码器可执行文件可用性（AC5）
            advanced_encoder_status,
            // T14 视频评测轮
            round_set_video_reference,
            round_add_video_candidates,
            round_remove_video_candidate,
            round_score_video_candidates,
            // T29-4：FFmpeg 检测（主界面警告）与应用内下载（下载入口仅设置页）
            ffmpeg_check,
            ffmpeg_download,
            // T15 视频逐帧对比（ffprobe 元信息 + 回环流服务）
            video_probe_meta,
            video_stream_url,
            // T13 BD-rate 汇总与报告导出
            round_bdrate,
            round_export,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败")
        .run(|app, event| {
            // T23：窗口大小随变化持续记回设置（记录状态开启时），下次启动恢复。
            // 挂 Resized 而非关闭类事件的实测依据见 record_window_size 的注释；
            // CloseRequested 兜底在关窗事件正常 platforms（Windows/macOS）写终值。
            if let tauri::RunEvent::WindowEvent { event, .. } = event {
                match event {
                    tauri::WindowEvent::Resized(_) => record_window_size(app),
                    tauri::WindowEvent::CloseRequested { .. } => record_window_size(app),
                    _ => {}
                }
            }
        });
}
