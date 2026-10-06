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
            default_export_dir: None,
            recent_dir: None,
            window: None,
            encoder_overrides: EncoderOverrides::default(),
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
        self
    }

    /// 保存前的一致性校验：非空的路径必须真实存在，错误中文且指到具体项。
    /// 存在性只在保存时查——设置之后文件被删/挪由编码/解码时的报错兜底。
    pub fn validate(&self) -> Result<(), String> {
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
        Ok(())
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
}
