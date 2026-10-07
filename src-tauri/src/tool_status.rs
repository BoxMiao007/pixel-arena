// 工具状态与「关于」（T29-2 设置页扩展）：编码器 / ffmpeg 的来源状态检测
//（内置 / 外部 / 未配置 / 不可用）与「关于」区块数据。
//
// 状态语义（票面 #36 + 决策 D18）：
// - 外部优先：设置了路径覆盖且该文件可用 → external，检测版本一并展示；
// - 无效提示并可回退内置：覆盖路径文件缺失或探测失败 → unavailable，hint 指引
//   清空该项回退内置（保存时已被 validate 拦下，这里兜「保存之后文件被删/挪」）；
// - 未配置：没有覆盖且内置尚未安装（编码器首次使用自动下载 / ffmpeg 待应用内下载）
//   → unconfigured；
// - 内置：内置已安装且探测可用 → builtin。
//
// 版本探测一律运行可执行文件的 -version / --version（票面「检测结果」），不读
// 任何缓存；「关于」库版本清单只读锁定清单（EncoderSource.version + ffmpeg 版本
// 常量），不硬编码、不运行时探测（决策 D18）。

use crate::settings::Settings;
use std::path::{Path, PathBuf};

/// 来源状态四态（serde 小写与前端 ToolSourceState 一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    /// 内置（tools/ 已安装且可用）。
    Builtin,
    /// 外部覆盖（有效路径优先于内置）。
    External,
    /// 未配置（无覆盖且内置尚未安装）。
    Unconfigured,
    /// 不可用（覆盖失效或内置安装损坏）。
    Unavailable,
}

/// 单个工具的状态条目（设置页编码器区 / FFmpeg 区每行一条）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// 工具键：ffmpeg / cjpeg / cwebp / avifenc / cjxl / avifdec（与设置文件键一致）。
    pub key: String,
    pub source: ToolSource,
    /// 设置中的路径覆盖（None/空 = 未配置）。
    pub override_path: Option<String>,
    /// 实际生效的可执行文件路径（覆盖或内置安装路径）。
    pub effective_path: Option<String>,
    /// 锁定清单里的内置版本（「关于」与状态行同源）。
    pub builtin_version: Option<String>,
    /// 内置是否已安装在 tools/ 下。
    pub builtin_installed: bool,
    /// 运行 -version/--version 探测到的版本首行；探测失败为 None。
    pub detected_version: Option<String>,
    /// 中文提示（不可用原因与处理办法、未配置说明等）。
    pub hint: Option<String>,
}

/// 「关于」区块的单个库条目：库名（超链接）+ 版本 + 主页。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutLibrary {
    pub name: String,
    pub version: String,
    pub url: String,
}

/// 「关于」区块数据（固定在设置页底部）：项目信息 + 引用的库版本清单。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub app_name: String,
    pub app_version: String,
    pub core_version: String,
    pub intro: String,
    pub license: String,
    pub repo_url: String,
    pub libraries: Vec<AboutLibrary>,
}

/// 探测一个工具的版本：依次尝试 --version 与 -version（编码器口味不一：
/// avifenc/cjxl 认 --version，cjpeg/cwebp/ffmpeg 认 -version），首个执行成功且
/// 有输出者胜出。返回首个非空输出行。
pub fn probe_tool_version(path: &Path, tool: &str) -> Result<String, String> {
    let mut last_err = String::new();
    for flag in ["--version", "-version"] {
        if !path.is_file() {
            return Err(format!("{tool} 路径无效：{}（文件不存在）", path.display()));
        }
        let output = match std::process::Command::new(path).arg(flag).output() {
            Ok(output) => output,
            Err(err) => {
                last_err = format!("无法执行 {tool}（{}）：{err}", path.display());
                continue;
            }
        };
        if !output.status.success() {
            last_err = format!(
                "{tool}（{}）执行失败（退出码 {}）",
                path.display(),
                output.status.code().unwrap_or(-1)
            );
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
            return Ok(line.to_string());
        }
        last_err = format!("{tool}（{}）执行成功但未输出版本信息", path.display());
    }
    Err(last_err)
}

/// 单个工具的状态构建（`probe` 注入以便单测脱离真实可执行文件）。
#[allow(clippy::too_many_arguments)]
fn build_status(
    key: &str,
    override_path: Option<String>,
    builtin_path: Option<PathBuf>,
    builtin_version: Option<String>,
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> ToolStatus {
    let builtin_installed = builtin_path.as_deref().is_some_and(Path::is_file);
    let trimmed = override_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let effective = trimmed.clone().or_else(|| {
        builtin_path
            .as_ref()
            .filter(|path| path.is_file())
            .map(|path| path.display().to_string())
    });
    let mut status = ToolStatus {
        key: key.to_string(),
        source: ToolSource::Unconfigured,
        override_path: trimmed.clone(),
        effective_path: effective.clone(),
        builtin_version,
        builtin_installed,
        detected_version: None,
        hint: None,
    };
    let Some(effective) = effective else {
        status.hint = Some("尚未安装：首次使用时自动下载，也可在设置页手动触发安装".to_string());
        return status;
    };
    let path = PathBuf::from(&effective);
    match probe(&path, key) {
        Ok(version) => {
            status.detected_version = Some(version);
            status.source = if trimmed.is_some() {
                ToolSource::External
            } else {
                ToolSource::Builtin
            };
        }
        Err(err) => {
            status.source = ToolSource::Unavailable;
            status.hint = Some(if trimmed.is_some() {
                format!("{err}。请更正该路径，或清空该项回退内置")
            } else {
                format!("{err}。内置安装似乎已损坏，使用时会自动重新下载覆盖")
            });
        }
    }
    status
}

/// 全部工具的状态（FFmpeg + 四个内置编码器 + avifdec 代片解码器），顺序即设置页
/// 展示顺序。`settings` 提供路径覆盖（改完保存后重调即刷新，改动立即生效）。
pub fn tool_status_impl(settings: &Settings, tools_dir: &Path) -> Vec<ToolStatus> {
    tool_status_with(
        settings,
        tools_dir,
        &|path, tool| probe_tool_version(path, tool),
    )
}

/// [`tool_status_impl`] 的 probe 注入版（pub 供不经 Tauri 运行时测试）。
pub fn tool_status_with(
    settings: &Settings,
    tools_dir: &Path,
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> Vec<ToolStatus> {
    use crate::ffmpeg_setup;
    use pixel_arena_core::{decode, encode};

    // 内置编码器安装路径：tools/<name>/<version>/<member>（与核心库安装布局一致）
    let builtin_encoder_path = |source: &Result<encode::EncoderSource, _>, member: &str| {
        source.as_ref().ok().map(|src| {
            tools_dir
                .join(&src.name)
                .join(&src.version)
                .join(if cfg!(windows) {
                    format!("{member}.exe")
                } else {
                    member.to_string()
                })
        })
    };
    let version_of = |source: &Result<encode::EncoderSource, _>| {
        source.as_ref().ok().map(|src| src.version.clone())
    };

    let mozjpeg = encode::mozjpeg_source();
    let webp = encode::webp_source();
    let avif = encode::avif_source();
    let jxl = encode::jxl_source();

    let mut statuses = vec![build_status(
        "ffmpeg",
        settings.ffmpeg_path.clone(),
        Some(ffmpeg_setup::ffmpeg_path(tools_dir)),
        Some(ffmpeg_setup::pinned_ffmpeg_version().to_string()),
        probe,
    )];
    let encoder = |key: &str,
                   over: Option<&String>,
                   source: &Result<encode::EncoderSource, _>,
                   member: &str| {
        build_status(
            key,
            over.cloned(),
            builtin_encoder_path(source, member),
            version_of(source),
            probe,
        )
    };
    let over = &settings.encoder_overrides;
    statuses.push(encoder("cjpeg", over.cjpeg.as_ref(), &mozjpeg, "cjpeg"));
    statuses.push(encoder("cwebp", over.cwebp.as_ref(), &webp, "cwebp"));
    statuses.push(encoder("avifenc", over.avifenc.as_ref(), &avif, "avifenc"));
    statuses.push(encoder("cjxl", over.cjxl.as_ref(), &jxl, "cjxl"));
    statuses.push(build_status(
        "avifdec",
        over.avifdec.clone(),
        decode::avif_decoder_path(tools_dir),
        version_of(&avif),
        probe,
    ));
    statuses
}

/// 指定工具键的子集状态（T29-3 高级创建建轮前的批量可用性校验：前端把条目的
/// 编码器键收集成一组传进来，只回这些键的状态，键序按请求序、未知键跳过）。
/// 复用 [`tool_status_with`] 的单条构建逻辑，语义（外部优先 / 四态判定）与设置页
/// 完全同源。
pub fn tool_status_for_keys(
    settings: &Settings,
    tools_dir: &Path,
    keys: &[String],
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> Vec<ToolStatus> {
    let all = tool_status_with(settings, tools_dir, probe);
    keys.iter()
        .filter_map(|key| all.iter().find(|status| &status.key == key).cloned())
        .collect()
}

/// 「关于」区块数据（决策 D18）：项目信息 + 引用的库版本清单，版本一律读锁定清单
///（EncoderSource.version + ffmpeg 版本常量），库名超链接到各自项目主页。
pub fn about_info_impl() -> AboutInfo {
    use pixel_arena_core::encode;
    let library = |name: &str, source: &Result<encode::EncoderSource, _>, url: &str| {
        source
            .as_ref()
            .ok()
            .map(|src| AboutLibrary {
                name: name.to_string(),
                version: src.version.clone(),
                url: url.to_string(),
            })
    };
    let mut libraries = Vec::new();
    let mozjpeg = encode::mozjpeg_source();
    let webp = encode::webp_source();
    let avif = encode::avif_source();
    let jxl = encode::jxl_source();
    if let Some(entry) = library("MozJPEG", &mozjpeg, "https://github.com/mozilla/mozjpeg") {
        libraries.push(entry);
    }
    if let Some(entry) = library("libwebp", &webp, "https://developers.google.com/speed/webp") {
        libraries.push(entry);
    }
    if let Some(entry) = library("libavif", &avif, "https://github.com/AOMediaCodec/libavif") {
        libraries.push(entry);
    }
    if let Some(entry) = library("libjxl", &jxl, "https://github.com/libjxl/libjxl") {
        libraries.push(entry);
    }
    libraries.push(AboutLibrary {
        name: "FFmpeg".to_string(),
        version: crate::ffmpeg_setup::pinned_ffmpeg_version().to_string(),
        url: "https://ffmpeg.org".to_string(),
    });
    AboutInfo {
        app_name: "Pixel Arena".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        core_version: pixel_arena_core::version().to_string(),
        intro: "多标签页评测工作台：对比不同图片/视频编码格式的画质与压缩效率。"
            .to_string(),
        license: "MIT".to_string(),
        repo_url: "https://github.com/BoxMiao007/pixel-arena".to_string(),
        libraries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    /// 假探测：文件存在即视为可用并回显版本；名字含 "silent" 模拟「存在但探测失败」；
    /// 不存在报中文路径错误。
    fn fake_probe(path: &Path, tool: &str) -> Result<String, String> {
        if !path.is_file() {
            return Err(format!("{tool} 路径无效：{}（文件不存在）", path.display()));
        }
        if path.display().to_string().contains("silent") {
            return Err(format!("{tool} 执行失败"));
        }
        Ok(format!("{tool} version 1.2.3"))
    }

    fn tools_with_builtin(name: &str, version: &str, member: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name).join(version).join(member);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"placeholder").unwrap();
        (dir, path)
    }

    #[test]
    fn unconfigured_when_no_override_and_builtin_missing() {
        let dir = tempfile::tempdir().unwrap();
        let statuses = tool_status_with(&Settings::default(), dir.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unconfigured);
        assert!(!cjpeg.builtin_installed);
        assert!(cjpeg.hint.as_deref().unwrap().contains("自动下载"));
        assert_eq!(cjpeg.effective_path, None);
        // 锁定清单版本照报（关于与状态行同源）
        assert!(cjpeg.builtin_version.is_some(), "cjpeg 应带内置锁定版本");
    }

    #[test]
    fn builtin_when_installed_and_probe_ok() {
        let src = pixel_arena_core::encode::mozjpeg_source().unwrap();
        let (dir, path) = tools_with_builtin(&src.name, &src.version, "cjpeg");
        let statuses = tool_status_with(&Settings::default(), dir.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Builtin, "{:?}", cjpeg);
        assert_eq!(cjpeg.effective_path.as_deref(), Some(path.to_str().unwrap()));
        assert_eq!(cjpeg.detected_version.as_deref(), Some("cjpeg version 1.2.3"));
    }

    #[test]
    fn external_override_wins_and_reports_version() {
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("my-cjpeg-ok");
        std::fs::write(&custom, b"placeholder").unwrap();
        let mut settings = Settings::default();
        settings.encoder_overrides.cjpeg = Some(custom.to_string_lossy().into_owned());
        let statuses = tool_status_with(&settings, dir.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::External, "外部有效路径应优先");
        assert_eq!(cjpeg.detected_version.as_deref(), Some("cjpeg version 1.2.3"));
        assert_eq!(cjpeg.hint, None, "可用时无需提示");
    }

    #[test]
    fn missing_override_file_is_unavailable_with_fallback_hint() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.encoder_overrides.cjpeg = Some("/不存在/cjpeg".to_string());
        let statuses = tool_status_with(&settings, dir.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unavailable);
        let hint = cjpeg.hint.as_deref().unwrap();
        assert!(hint.contains("清空"), "应指引清空回退内置: {hint}");
        assert!(hint.contains("内置"), "{hint}");
    }

    #[test]
    fn broken_override_file_is_unavailable_with_fallback_hint() {
        // 文件在但探测失败（不可执行/无版本输出）：同样不可用 + 回退提示
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("silent-cjpeg");
        std::fs::write(&custom, b"placeholder").unwrap();
        let mut settings = Settings::default();
        settings.encoder_overrides.cjpeg = Some(custom.to_string_lossy().into_owned());
        let statuses = tool_status_with(&settings, dir.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unavailable);
        assert!(cjpeg.hint.as_deref().unwrap().contains("清空"));
    }

    #[test]
    fn broken_builtin_install_is_unavailable() {
        // 内置已安装但探测失败（安装损坏）：不可用，提示会自动重下
        let src = pixel_arena_core::encode::webp_source().unwrap();
        let (dir, _path) = tools_with_builtin(&src.name, &src.version, "cwebp");
        let failing = |_: &Path, tool: &str| -> Result<String, String> {
            Err(format!("{tool} 执行失败"))
        };
        let statuses = tool_status_with(&Settings::default(), dir.path(), &failing);
        let cwebp = statuses.iter().find(|s| s.key == "cwebp").unwrap();
        assert_eq!(cwebp.source, ToolSource::Unavailable);
        let hint = cwebp.hint.as_deref().unwrap();
        assert!(hint.contains("重新下载"), "内置损坏应说明会自动重下: {hint}");
    }

    #[test]
    fn ffmpeg_status_reads_settings_override_and_pinned_version() {
        let dir = tempfile::tempdir().unwrap();
        let statuses = tool_status_with(&Settings::default(), dir.path(), &fake_probe);
        let ffmpeg = statuses.iter().find(|s| s.key == "ffmpeg").unwrap();
        assert_eq!(ffmpeg.source, ToolSource::Unconfigured);
        assert_eq!(
            ffmpeg.builtin_version.as_deref(),
            Some(crate::ffmpeg_setup::pinned_ffmpeg_version()),
            "ffmpeg 条目应读锁定版本常量"
        );
    }

    #[test]
    fn status_order_is_ffmpeg_then_encoders_then_avifdec() {
        let dir = tempfile::tempdir().unwrap();
        let statuses = tool_status_with(&Settings::default(), dir.path(), &fake_probe);
        let keys: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(
            keys,
            ["ffmpeg", "cjpeg", "cwebp", "avifenc", "cjxl", "avifdec"]
        );
    }

    // ---------- T29-3：高级创建建轮前的批量可用性校验 ----------

    #[test]
    fn tool_status_for_keys_returns_only_requested_keys_in_request_order() {
        let dir = tempfile::tempdir().unwrap();
        let keys = ["cjxl".to_string(), "ffmpeg".to_string(), "cwebp".to_string()];
        let statuses = tool_status_for_keys(&Settings::default(), dir.path(), &keys, &fake_probe);
        let got: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(got, ["cjxl", "ffmpeg", "cwebp"], "键序按请求序，只含请求键");
    }

    #[test]
    fn tool_status_for_keys_keeps_unavailability_semantics() {
        // 与设置页同源：外部路径失效 → unavailable + 指引；未配置（内置未装）→
        // unconfigured（编码器首次使用自动下载，建轮前不算不可用）
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.encoder_overrides.cjpeg = Some("/不存在/cjpeg".to_string());
        let keys = ["cjpeg".to_string(), "avifenc".to_string()];
        let statuses = tool_status_for_keys(&settings, dir.path(), &keys, &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unavailable);
        assert!(cjpeg.hint.as_deref().unwrap().contains("清空"));
        let avifenc = statuses.iter().find(|s| s.key == "avifenc").unwrap();
        assert_eq!(avifenc.source, ToolSource::Unconfigured);
    }

    #[test]
    fn tool_status_for_keys_skips_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let keys = ["cwebp".to_string(), "不是工具".to_string()];
        let statuses = tool_status_for_keys(&Settings::default(), dir.path(), &keys, &fake_probe);
        let got: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(got, ["cwebp"], "未知键跳过不报错");
    }
}
