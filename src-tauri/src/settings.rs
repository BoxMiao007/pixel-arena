// 用户设置（T23 设置中心）：独立于 workspace.json 的偏好文件，存应用数据目录
// settings.json。放本 crate 而非核心库是有意的结构约束——CLI 只依赖
// pixel-arena-core，天然读不到 GUI 设置（票面验收：CLI 行为只由命令行参数决定）。
//
// 语义拍板（详见 notes/T23.md）：
// - record_state（默认开）只门控「启动恢复」：工作区加载、窗口大小、最近目录。
//   关闭时工作区照常自动保存（改动才写盘），干净启动本身不写任何恢复数据，
//   上次保存的 workspace.json 不被清空启动破坏。
// - 主题默认 dark = 现状界面（升级用户观感不变）。
// - 坏文件 fail-soft 回落默认值：设置是可重配的偏好，不能让它挡住应用启动
//  （workspace.json 才是用户数据，那边 fail-fast 如实上报）。
//
// encoder_overrides 存路径文本；空串在 normalize 时收成 None（清空 = 恢复内置）。
// 窗口大小存逻辑像素（与 DPI 无关），退出时由 lib.rs 写回、启动时恢复。

use serde::{Deserialize, Serialize};

/// 界面主题：浅色 / 深色 / 跟随系统。serde 小写落盘（反序列化即校验）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    #[default]
    Dark,
    System,
}

/// 跑分并发度档位（T24）：按逻辑核数的比例限制同时计算的跑分任务数
///（视频跑分即同时打开的 ffmpeg 进程数）。默认 half = 「默认只用一半核心留余量」；
/// 比例 → 线程数的换算在核心库 parallel::concurrency_limit（floor，夹在 [1, 核数]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoreConcurrency {
    Quarter,
    #[default]
    Half,
    ThreeQuarters,
    Full,
}

impl ScoreConcurrency {
    /// 逻辑核数占比（与 parallel::concurrency_limit 的入参对应）。
    pub fn fraction(self) -> f64 {
        match self {
            ScoreConcurrency::Quarter => 0.25,
            ScoreConcurrency::Half => 0.5,
            ScoreConcurrency::ThreeQuarters => 0.75,
            ScoreConcurrency::Full => 1.0,
        }
    }
}

/// 记住的窗口大小（逻辑像素）。只记宽高不记位置：票面范围是「窗口大小」。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

/// 产物文件名冲突策略（T30）：GUI 一站式/高级创建的产物写入行为。
/// 仅作用于 GUI 产物写入；CLI 不读 GUI 设置，恒为自动追加（决策 0017）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileConflictPolicy {
    /// 目标名已有文件时自动追加 `_1/_2`（现状默认行为，决策 D9，永不覆盖）。
    #[default]
    Auto,
    /// 写入前探测到同名冲突时弹窗询问，用户对每个冲突拍板「覆盖 / 跳过」，
    /// 可选应用到本次全部冲突。
    Ask,
}

/// 编码器可执行文件路径覆盖（None/空 = 使用内置自动安装的编码器）。
/// 键名与核心库 EncoderSource 的成员名一致；avifdec 是 AVIF 产物代片的解码器，
/// GUI 侧经既有 PIXEL_ARENA_AVIFDEC 环境变量注入机制接入，不算编码器但也在此可配。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderOverrides {
    #[serde(default)]
    pub cjpeg: Option<String>,
    #[serde(default)]
    pub cwebp: Option<String>,
    #[serde(default)]
    pub avifenc: Option<String>,
    #[serde(default)]
    pub cjxl: Option<String>,
    #[serde(default)]
    pub avifdec: Option<String>,
}

/// 设置文件的整体形状（serde camelCase 与前端 SettingsData 一一对应）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    /// 记录状态开关：启动时是否恢复工作区/窗口大小/最近目录。默认开（保持现状）。
    #[serde(default = "default_true")]
    pub record_state: bool,
    #[serde(default)]
    pub theme: Theme,
    /// 跑分并发度（T24）：1/4、1/2、3/4、全部，默认 1/2（只用一半核心留余量）。
    #[serde(default)]
    pub score_concurrency: ScoreConcurrency,
    /// 产物文件名冲突策略（T30）：auto = 自动追加 `_1/_2`（默认，现状行为）；
    /// ask = 写入前弹窗询问。旧 settings.json 缺字段时 serde default 兜底为 auto。
    #[serde(default)]
    pub conflict_policy: FileConflictPolicy,
    /// CSV/HTML 导出对话框的默认目录；None/空 = 未设置。
    #[serde(default)]
    pub default_export_dir: Option<String>,
    /// 最近一次文件选择所在目录（原图/跑分图/视频选择对话框的默认位置）；
    /// 记录始终进行，恢复仅在 record_state 开启时生效。
    #[serde(default)]
    pub recent_dir: Option<String>,
    /// 上次退出时的窗口大小；恢复仅在 record_state 开启时生效。
    #[serde(default)]
    pub window: Option<WindowSize>,
    #[serde(default)]
    pub encoder_overrides: EncoderOverrides,
    /// FFmpeg 可执行文件路径覆盖（T29-2 设置页，决策 D1/D4）：None/空 = 使用应用内
    /// 下载到 tools/ 的内置 ffmpeg。保存时校验存在/可执行/版本可读（validate），
    /// 视频跑分与逐帧对比在每次使用时读取（改动对后续评测轮立即生效）。
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

fn default_format_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            format_version: 1,
            record_state: true,
            theme: Theme::default(),
            score_concurrency: ScoreConcurrency::default(),
            conflict_policy: FileConflictPolicy::default(),
            default_export_dir: None,
            recent_dir: None,
            window: None,
            encoder_overrides: EncoderOverrides::default(),
            ffmpeg_path: None,
        }
    }
}

impl Settings {
    /// 从磁盘读设置。文件不存在或内容损坏一律回落默认值（见模块头 fail-soft 理由）。
    pub fn load_from_file(path: &std::path::Path) -> Settings {
        match std::fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    /// 写盘（pretty JSON，与 workspace.json 同风格，用户可手读手改）。
    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self)
            .expect("Settings 序列化不会失败");
        std::fs::write(path, json).map_err(|err| format!("写入设置文件失败: {err}"))
    }

    /// 空串与纯空白收成 None（「清空恢复内置」的落盘形态）。
    pub fn normalized(mut self) -> Self {
        self.default_export_dir = normalize_path(&self.default_export_dir);
        self.recent_dir = normalize_path(&self.recent_dir);
        let over = &mut self.encoder_overrides;
        over.cjpeg = normalize_path(&over.cjpeg);
        over.cwebp = normalize_path(&over.cwebp);
        over.avifenc = normalize_path(&over.avifenc);
        over.cjxl = normalize_path(&over.cjxl);
        over.avifdec = normalize_path(&over.avifdec);
        self.ffmpeg_path = normalize_path(&self.ffmpeg_path);
        self
    }

    /// 保存前的一致性校验：非空的路径必须真实存在，错误中文且指到具体项。
    /// 存在性只在保存时查——设置之后文件被删/挪由编码/解码时的报错兜底。
    /// FFmpeg 路径额外要求「可执行 + 版本可读」（T29-2 票面：保存后立即校验，
    /// 保存成功即可放心用于视频跑分）。版本探测带 5s 有界超时（与 ffmpeg_check
    /// 同口径，issue #42：外部路径挂起时保存不再无限阻塞）。
    pub fn validate(&self) -> Result<(), String> {
        self.validate_with_probe_timeout(crate::ffmpeg_setup::DETECT_TIMEOUT)
    }

    /// [`validate`] 的探测超时注入版（issue #42）：测试注入短超时避免真等 5s。
    pub fn validate_with_probe_timeout(
        &self,
        ffmpeg_probe_timeout: std::time::Duration,
    ) -> Result<(), String> {
        let over = &self.encoder_overrides;
        for (tool, path) in [
            ("cjpeg", &over.cjpeg),
            ("cwebp", &over.cwebp),
            ("avifenc", &over.avifenc),
            ("cjxl", &over.cjxl),
            ("avifdec", &over.avifdec),
        ] {
            if let Some(path) = path {
                if !std::path::Path::new(path).is_file() {
                    return Err(format!(
                        "编码器 {tool} 的自定义路径无效：{path}（文件不存在）。\
                         请更正或在设置中清空该项（清空后恢复内置编码器）"
                    ));
                }
            }
        }
        if let Some(dir) = &self.default_export_dir {
            if !std::path::Path::new(dir).is_dir() {
                return Err(format!("默认导出目录无效：{dir}（目录不存在）"));
            }
        }
        if let Some(ffmpeg) = &self.ffmpeg_path {
            probe_executable_version_timed(
                std::path::Path::new(ffmpeg),
                "ffmpeg",
                Some(ffmpeg_probe_timeout),
            )
            .map_err(|err| {
                format!("FFmpeg 自定义路径校验失败：{err}。请更正或清空（清空后使用应用内下载的内置 ffmpeg）")
            })?;
        }
        Ok(())
    }
}

/// 运行 `<可执行文件> -version` 探测版本（T29-2）：成功返回输出的首个非空行。
/// 「可执行」与「版本可读」一并验证——能跑起来且有输出才算可用。
/// 设置页保存校验（FFmpeg）与 ffmpeg_setup 检测共用同一实现；`timeout` 为 None
/// 时阻塞等待到底，Some 时超时杀进程报中文错误（票面 5s 上限，防止挂起的
/// 可执行文件把检测/保存卡死）。tool_status 的编码器探测口径不同
///（--version/-version 双试、stdout 空回退读 stderr、单次失败续试下一标志），
/// 独立实现在 [`crate::tool_status::probe_tool_version`]。
pub fn probe_executable_version_timed(
    path: &std::path::Path,
    tool: &str,
    timeout: Option<std::time::Duration>,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    // 探测在 spawn 前加 Windows「不弹终端窗口」处理（issue #42）。
    use pixel_arena_core::process::apply_no_window;
    if !path.is_file() {
        return Err(format!("{tool} 路径无效：{}（文件不存在）", path.display()));
    }
    let mut command = Command::new(path);
    apply_no_window(&mut command);
    let mut child = command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("无法执行 {tool}（{}）：{err}", path.display()))?;
    let deadline = timeout.map(|limit| std::time::Instant::now() + limit);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 超时文案是 FFmpeg 检测专用（当前唯一带超时的调用方），保留原文
                    // 避免检测口径漂移
                    return Err(format!(
                        "FFmpeg 检测超时（{} 秒无响应），该路径可能不是可用的 ffmpeg。请在设置页更正路径或应用内下载",
                        timeout.expect("超时分支必有 timeout").as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(err) => return Err(format!("{tool} 进程状态读取失败：{err}")),
        }
    }
    // 进程已退出（循环确认过）：先读管道残余输出再收尸，避免管道满的罕见死锁窗口
    //（-version 输出只有几行，正常路径远不会触及上限）
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let status = child
        .wait()
        .map_err(|err| format!("{tool} 进程收尾失败：{err}"))?;
    if !status.success() {
        return Err(format!(
            "{tool}（{}）执行失败（退出码 {}），请确认它是对应工具的可执行文件",
            path.display(),
            status.code().unwrap_or(-1)
        ));
    }
    match stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
        Some(line) => Ok(line.to_string()),
        None => Err(format!(
            "{tool}（{}）执行成功但未输出版本信息，无法确认可用性",
            path.display()
        )),
    }
}

fn normalize_path(raw: &Option<String>) -> Option<String> {
    match raw {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_current_behavior() {
        let settings = Settings::default();
        assert!(settings.record_state, "记录状态默认开：保持现状恢复行为");
        assert_eq!(settings.theme, Theme::Dark, "主题默认深色 = 现状界面");
        assert_eq!(settings.default_export_dir, None);
        assert_eq!(settings.recent_dir, None);
        assert_eq!(settings.window, None);
        assert_eq!(settings.encoder_overrides, EncoderOverrides::default());
        assert_eq!(
            settings.conflict_policy,
            FileConflictPolicy::Auto,
            "冲突策略默认自动追加 = 现状行为"
        );
    }

    #[test]
    fn conflict_policy_defaults_to_auto_and_parses_two_choices() {
        // 默认 auto = 现状行为不变（票面验收 1）；两选合法，未知值拒绝
        assert_eq!(
            serde_json::from_str::<FileConflictPolicy>("\"auto\"").unwrap(),
            FileConflictPolicy::Auto
        );
        assert_eq!(
            serde_json::from_str::<FileConflictPolicy>("\"ask\"").unwrap(),
            FileConflictPolicy::Ask
        );
        assert!(serde_json::from_str::<FileConflictPolicy>("\"覆盖\"").is_err());
        // 旧 settings.json 没有 conflictPolicy 字段：serde default 兜底，无需迁移
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.conflict_policy, FileConflictPolicy::Auto);
    }

    #[test]
    fn conflict_policy_roundtrips_camel_case() {
        let settings = Settings {
            conflict_policy: FileConflictPolicy::Ask,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"conflictPolicy\":\"ask\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn serde_uses_camel_case_roundtrip() {
        let settings = Settings {
            default_export_dir: Some("/tmp/导出".to_string()),
            window: Some(WindowSize {
                width: 1200.0,
                height: 800.0,
            }),
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"defaultExportDir\":\"/tmp/导出\""), "{json}");
        assert!(json.contains("\"recordState\":true"), "{json}");
        assert!(json.contains("\"theme\":\"dark\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // 旧版/手写的精简文件：缺字段全部兜默认
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        // fail-soft：坏设置文件回落默认值，不挡启动（理由见模块头）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ 不是 json").unwrap();
        assert_eq!(Settings::load_from_file(&path), Settings::default());
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("不存在.json");
        assert_eq!(Settings::load_from_file(&path), Settings::default());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            record_state: false,
            theme: Theme::System,
            recent_dir: Some("/home/user/图片".to_string()),
            encoder_overrides: EncoderOverrides {
                cjpeg: Some("/opt/bin/cjpeg".to_string()),
                ..Default::default()
            },
            ..Settings::default()
        };
        settings.save_to_file(&path).expect("保存应成功");
        let loaded = Settings::load_from_file(&path);
        assert_eq!(loaded, settings);
    }

    #[test]
    fn normalize_turns_empty_strings_into_none() {
        let settings = Settings {
            default_export_dir: Some("  ".to_string()),
            recent_dir: Some("".to_string()),
            encoder_overrides: EncoderOverrides {
                cjpeg: Some(" /opt/bin/cjpeg ".to_string()),
                cwebp: Some(String::new()),
                ..Default::default()
            },
            ..Settings::default()
        }
        .normalized();
        assert_eq!(settings.default_export_dir, None);
        assert_eq!(settings.recent_dir, None);
        assert_eq!(
            settings.encoder_overrides.cjpeg.as_deref(),
            Some("/opt/bin/cjpeg"),
            "路径应去首尾空白"
        );
        assert_eq!(settings.encoder_overrides.cwebp, None);
    }

    #[test]
    fn validate_rejects_missing_encoder_path_with_locatable_error() {
        let settings = Settings {
            encoder_overrides: EncoderOverrides {
                cjpeg: Some("/不存在/fake-cjpeg".to_string()),
                ..Default::default()
            },
            ..Settings::default()
        };
        let message = settings.validate().unwrap_err();
        assert!(message.contains("cjpeg"), "应点名编码器: {message}");
        assert!(message.contains("/不存在/fake-cjpeg"), "应包含路径: {message}");
        assert!(message.contains("清空"), "应说明清空可恢复内置: {message}");
    }

    #[test]
    fn validate_rejects_missing_export_dir() {
        let settings = Settings {
            default_export_dir: Some("/不存在/的目录".to_string()),
            ..Settings::default()
        };
        let message = settings.validate().unwrap_err();
        assert!(message.contains("默认导出目录"), "{message}");
        assert!(message.contains("/不存在/的目录"), "{message}");
    }

    #[test]
    fn validate_accepts_empty_and_existing_paths() {
        // 全空 = 默认行为，合法
        Settings::default().validate().expect("默认设置应合法");
        // 真实存在的文件与目录合法
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("cjpeg");
        std::fs::write(&file, b"").unwrap();
        let settings = Settings {
            default_export_dir: Some(dir.path().to_string_lossy().into_owned()),
            encoder_overrides: EncoderOverrides {
                cjpeg: Some(file.to_string_lossy().into_owned()),
                ..Default::default()
            },
            ..Settings::default()
        };
        settings.validate().expect("存在的路径应合法");
    }

    #[test]
    fn theme_deserializes_three_choices_rejects_others() {
        // serde 反序列化即校验：三选合法，其余拒绝
        assert_eq!(
            serde_json::from_str::<Theme>("\"light\"").unwrap(),
            Theme::Light
        );
        assert_eq!(
            serde_json::from_str::<Theme>("\"system\"").unwrap(),
            Theme::System
        );
        assert!(serde_json::from_str::<Theme>("\"蓝\"").is_err());
    }

    #[test]
    fn score_concurrency_defaults_to_half_and_parses_four_choices() {
        // 默认 1/2 = 「默认只用一半核心留余量」（票面要求）
        assert_eq!(
            Settings::default().score_concurrency,
            ScoreConcurrency::Half
        );
        assert_eq!(
            serde_json::from_str::<ScoreConcurrency>("\"quarter\"").unwrap(),
            ScoreConcurrency::Quarter
        );
        assert_eq!(
            serde_json::from_str::<ScoreConcurrency>("\"threequarters\"").unwrap(),
            ScoreConcurrency::ThreeQuarters
        );
        assert_eq!(
            serde_json::from_str::<ScoreConcurrency>("\"full\"").unwrap(),
            ScoreConcurrency::Full
        );
        // 未知档位拒绝（反序列化即校验，坏值不静默吞掉）
        assert!(serde_json::from_str::<ScoreConcurrency>("\"十成\"").is_err());
    }

    #[test]
    fn score_concurrency_fraction_matches_tiers() {
        assert_eq!(ScoreConcurrency::Quarter.fraction(), 0.25);
        assert_eq!(ScoreConcurrency::Half.fraction(), 0.5);
        assert_eq!(ScoreConcurrency::ThreeQuarters.fraction(), 0.75);
        assert_eq!(ScoreConcurrency::Full.fraction(), 1.0);
    }

    #[test]
    fn missing_score_concurrency_field_falls_back_to_half() {
        // 旧 settings.json 没有该字段：serde default 兜底为 half，无需迁移
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(
            settings.score_concurrency,
            ScoreConcurrency::Half,
            "缺字段应兜底为默认档 1/2"
        );
    }

    // ---------- T29-2：FFmpeg 路径覆盖（保存时校验存在/可执行/版本可读） ----------

    #[test]
    fn ffmpeg_path_defaults_to_none_and_roundtrips_camel_case() {
        // 旧设置文件没有 ffmpegPath 字段：兜底 None（内置 ffmpeg），向后兼容
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.ffmpeg_path, None);
        let settings = Settings {
            ffmpeg_path: Some("/opt/bin/ffmpeg".to_string()),
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"ffmpegPath\":\"/opt/bin/ffmpeg\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ffmpeg_path.as_deref(), Some("/opt/bin/ffmpeg"));
    }

    #[test]
    fn ffmpeg_path_empty_string_normalizes_to_none() {
        let settings = Settings {
            ffmpeg_path: Some("  ".to_string()),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(settings.ffmpeg_path, None, "空串 = 清空覆盖，恢复内置 ffmpeg");
    }

    #[test]
    fn validate_rejects_missing_ffmpeg_path_with_locatable_error() {
        let settings = Settings {
            ffmpeg_path: Some("/不存在/fake-ffmpeg".to_string()),
            ..Settings::default()
        };
        let message = settings.validate().unwrap_err();
        assert!(message.contains("FFmpeg"), "错误应点名 FFmpeg: {message}");
        assert!(message.contains("/不存在/fake-ffmpeg"), "应包含路径: {message}");
        assert!(message.contains("清空"), "应说明清空可回退内置: {message}");
    }

    #[cfg(unix)]
    #[test]
    fn validate_rejects_ffmpeg_without_readable_version() {
        // 存在但不可执行/无版本输出：保存必须被拦下（票面「可执行/版本可读」）
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("ffmpeg");
        std::fs::write(&fake, "不是可执行文件").unwrap();
        let settings = Settings {
            ffmpeg_path: Some(fake.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        let message = settings.validate().unwrap_err();
        assert!(message.contains("FFmpeg 自定义路径校验失败"), "{message}");
    }

    /// 写测试用假可执行脚本。写完 fsync + 短缓冲再返回：
    /// WSL/CI 上 close 后立刻 exec 偶发 ETXTBSY（Text file busy），fsync 推掉回写可关掉竞态窗口。
    #[cfg(unix)]
    fn write_exec(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::File::open(&path).and_then(|f| f.sync_all()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        path
    }

    #[cfg(unix)]
    #[test]
    fn validate_accepts_ffmpeg_with_readable_version() {
        // 能执行且输出版本：校验通过（用 shell 脚本冒充 ffmpeg，-version 输出一行）
        let dir = tempfile::tempdir().unwrap();
        let fake = write_exec(dir.path(), "ffmpeg", "#!/bin/sh\necho \"ffmpeg version 7.0.2-test\"\n");
        let settings = Settings {
            ffmpeg_path: Some(fake.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        settings.validate().expect("版本可读的 ffmpeg 应通过校验");
    }

    #[cfg(unix)]
    #[test]
    fn probe_executable_version_returns_first_output_line() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_exec(dir.path(), "tool", "#!/bin/sh\necho \"\"\necho \"tool version 1.2.3\"\n");
        let version = probe_executable_version_timed(&fake, "tool", None).unwrap();
        assert_eq!(version, "tool version 1.2.3", "应返回首个非空输出行");
        // 执行失败（非零退出）报中文错误
        let bad = write_exec(dir.path(), "bad", "#!/bin/sh\nexit 3\n");
        let message = probe_executable_version_timed(&bad, "tool", None).unwrap_err();
        assert!(message.contains("执行失败"), "{message}");
        assert!(message.contains("退出码 3"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn validate_times_out_unresponsive_ffmpeg_within_injected_limit() {
        // 挂起不退出的假 ffmpeg（issue #42：外部路径挂起曾把保存卡死）：
        // 注入 200ms 超时必须返回中文超时错误，且远小于默认 5s——与
        // ffmpeg_setup::detect_times_out_unresponsive_executable 同一测试模式。
        let dir = tempfile::tempdir().unwrap();
        let fake = write_exec(dir.path(), "ffmpeg", "#!/bin/sh\nsleep 30\n");
        let settings = Settings {
            ffmpeg_path: Some(fake.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        let started = std::time::Instant::now();
        let message = settings
            .validate_with_probe_timeout(std::time::Duration::from_millis(200))
            .unwrap_err();
        assert!(message.contains("超时"), "{message}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "注入超时应立即返回，不应等满默认 5s"
        );
    }
}
