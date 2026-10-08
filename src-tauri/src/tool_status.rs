// 工具状态与「关于」（T29-2 设置页扩展）：编码器 / ffmpeg 的来源状态检测
//（内置 / 外部 / 未配置 / 不可用）与「关于」区块数据。
//
// 状态语义（票面 #36 + 决策 D18；T29-4 捆绑语义）：
// - 外部优先：设置了路径覆盖且该文件可用 → external，检测版本一并展示；
// - 无效提示并可回退内置：覆盖路径文件缺失或探测失败 → unavailable，hint 指引
//   清空该项回退内置（保存时已被 validate 拦下，这里兜「保存之后文件被删/挪」）；
// - 未配置：没有覆盖且内置尚未就位（安装包未捆绑该编码器且无旧版 tools/ 安装 /
//   ffmpeg 待应用内下载）→ unconfigured，hint 指引官方发布页 + 外部路径（决策 0025）；
// - 内置：随安装包捆绑（resource_dir/encoders/<member>，便携 zip 裸跑时由启动期
//   解析回落 exe 同目录 encoders/，见 lib.rs resolve_bundled_encoders_dir）或已下载
//   安装到 tools/ 且探测可用 → builtin，版本行展示锁定清单版本号（票面「内置+版本号」）；
//   捆绑与 tools/ 安装同时在时以捆绑优先（与编码链 to_core_overrides 一致）。
//
// 版本探测一律运行可执行文件的 -version / --version（票面「检测结果」），不读
// 任何缓存；「关于」库版本清单只读锁定清单（EncoderSource.version + ffmpeg 版本
// 常量），不硬编码、不运行时探测（决策 D18）。

use crate::settings::Settings;
use std::path::{Path, PathBuf};

use pixel_arena_core::process::apply_no_window;

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
    /// 该编码器项目的官方发布页（https，决策 0025 单一数据源 = 核心库
    /// EncoderSource.release_page；前端经 isSafeLibraryUrl 白名单渲染超链接）。
    /// ffmpeg 走应用内下载、无发布页条目 → None。
    pub release_page: Option<String>,
    /// 中文提示（不可用原因与处理办法、未配置说明等）。
    pub hint: Option<String>,
}

/// 「关于」区块的单个库条目：库名（超链接）+ 版本 + 开源协议 + 主页。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutLibrary {
    pub name: String,
    pub version: String,
    /// 开源协议文本（编码器读 EncoderSource.license 单源；FFmpeg 为锁定 GPL 静态构建）。
    pub license: String,
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
        let mut command = std::process::Command::new(path);
        apply_no_window(&mut command);
        let output = match command.arg(flag).output() {
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
        // mozjpeg 的 cjpeg 把版本写到 stderr（stdout 为空，T29-4 实测）：成功退出且
        // stdout 无内容时回退读 stderr 首个非空行——仅限「执行成功」分支，失败退出
        // 的 stderr（如 unknown option）不当作版本
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        let line = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .or_else(|| {
                stderr_text
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
            });
        if let Some(line) = line {
            return Ok(line.to_string());
        }
        last_err = format!("{tool}（{}）执行成功但未输出版本信息", path.display());
    }
    Err(last_err)
}

/// 单个工具的状态构建（`probe` 注入以便单测脱离真实可执行文件）。
/// `builtin` = (内置路径, 是否随安装包捆绑)；捆绑优先于 tools/ 安装。
#[allow(clippy::too_many_arguments)]
fn build_status(
    key: &str,
    override_path: Option<String>,
    builtin: Option<(PathBuf, bool)>,
    builtin_version: Option<String>,
    release_page: Option<String>,
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> ToolStatus {
    let (builtin_path, builtin_bundled) = builtin
        .map(|(path, bundled)| (Some(path), bundled))
        .unwrap_or((None, false));
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
        release_page,
        hint: None,
    };
    let Some(effective) = effective else {
        status.hint = Some(if key == "ffmpeg" {
            "视频跑分前需要 FFmpeg：可在设置页点击「应用内下载」，或指定本机已有的 ffmpeg".to_string()
        } else {
            // 决策 0025：运行期不再自动下载——指引官方发布页（条目的「官方发布页」
            // 链接与报错共用 release_page 单一数据源）+ 外部路径接入
            "内置文件缺失（可能被安全软件移除，或旧版本安装包未捆绑）：请从官方发布页下载编码器，保存后在下方指定其路径，或重新安装应用".to_string()
        });
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
            } else if builtin_bundled {
                format!("{err}。安装包捆绑的编码器似乎已损坏：请重新安装应用，或在设置页改用外部路径")
            } else {
                format!("{err}。内置安装似乎已损坏：请重新下载安装（见官方发布页），或在设置页改用外部路径")
            });
        }
    }
    status
}

/// 全部工具的状态（FFmpeg + 四个内置编码器 + avifdec 代片解码器），顺序即设置页
/// 展示顺序。`settings` 提供路径覆盖（改完保存后重调即刷新，改动立即生效）；
/// `bundled_encoders` = 安装包捆绑的编码器目录（resource_dir/encoders，T29-4），
/// 目录不存在（未捆绑场景，如裸 debug 构建）时安全退化为只查 tools/ 安装。
pub fn tool_status_impl(settings: &Settings, tools_dir: &Path, bundled_encoders: &Path) -> Vec<ToolStatus> {
    tool_status_with(settings, tools_dir, bundled_encoders, &|path, tool| {
        probe_tool_version(path, tool)
    })
}

/// [`tool_status_impl`] 的 probe 注入版（pub 供不经 Tauri 运行时测试）。
pub fn tool_status_with(
    settings: &Settings,
    tools_dir: &Path,
    bundled_encoders: &Path,
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> Vec<ToolStatus> {
    use crate::ffmpeg_setup;
    use pixel_arena_core::{decode, encode};

    // 内置编码器安装路径：捆绑（resource_dir/encoders/<member>，T29-4）优先，
    // 捆绑缺失回落 tools/<name>/<version>/<member>（与核心库安装布局一致）
    let builtin_encoder_path = |source: &Result<encode::EncoderSource, _>, member: &str| {
        source.as_ref().ok().map(|src| {
            let member = if cfg!(windows) {
                format!("{member}.exe")
            } else {
                member.to_string()
            };
            let bundled = bundled_encoders.join(&member);
            if bundled.is_file() {
                (bundled, true)
            } else {
                (
                    tools_dir.join(&src.name).join(&src.version).join(member),
                    false,
                )
            }
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
        Some((ffmpeg_setup::ffmpeg_path(tools_dir), false)),
        Some(ffmpeg_setup::pinned_ffmpeg_version().to_string()),
        // ffmpeg 不捆绑、走应用内下载（决策 0014/D1），无编码器发布页条目
        None,
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
            source.as_ref().ok().map(|src| src.release_page.clone()),
            probe,
        )
    };
    let over = &settings.encoder_overrides;
    statuses.push(encoder("cjpeg", over.cjpeg.as_ref(), &mozjpeg, "cjpeg"));
    statuses.push(encoder("cwebp", over.cwebp.as_ref(), &webp, "cwebp"));
    statuses.push(encoder("avifenc", over.avifenc.as_ref(), &avif, "avifenc"));
    statuses.push(encoder("cjxl", over.cjxl.as_ref(), &jxl, "cjxl"));
    // avifdec：捆绑目录优先，回落 tools/ 的确定性安装路径（平台无清单时无内置路径）
    let avifdec_bundled = bundled_encoders.join(if cfg!(windows) { "avifdec.exe" } else { "avifdec" });
    let avifdec_builtin = if avifdec_bundled.is_file() {
        Some((avifdec_bundled, true))
    } else {
        decode::avif_decoder_path(tools_dir).map(|path| (path, false))
    };
    statuses.push(build_status(
        "avifdec",
        over.avifdec.clone(),
        avifdec_builtin,
        version_of(&avif),
        // avifdec 与 avifenc 同属 libavif：发布页同源（决策 0025）
        avif.as_ref().ok().map(|src| src.release_page.clone()),
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
    bundled_encoders: &Path,
    keys: &[String],
    probe: &dyn Fn(&Path, &str) -> Result<String, String>,
) -> Vec<ToolStatus> {
    let all = tool_status_with(settings, tools_dir, bundled_encoders, probe);
    keys.iter()
        .filter_map(|key| all.iter().find(|status| &status.key == key).cloned())
        .collect()
}

/// 「关于」区块数据（决策 D18 + 0025）：项目信息 + 引用的库版本清单，版本一律读锁定
/// 来源（EncoderSource.version + ffmpeg 版本常量），库链接用来源清单的官方发布页
///（release_page 单一数据源，与核心库缺失报错、设置页编码器条目链接共用）。
pub fn about_info_impl() -> AboutInfo {
    use pixel_arena_core::encode;
    let library = |name: &str, source: &Result<encode::EncoderSource, _>| {
        source
            .as_ref()
            .ok()
            .map(|src| AboutLibrary {
                name: name.to_string(),
                version: src.version.clone(),
                license: src.license.clone(),
                url: src.release_page.clone(),
            })
    };
    let mut libraries = Vec::new();
    let mozjpeg = encode::mozjpeg_source();
    let webp = encode::webp_source();
    let avif = encode::avif_source();
    let jxl = encode::jxl_source();
    if let Some(entry) = library("MozJPEG", &mozjpeg) {
        libraries.push(entry);
    }
    if let Some(entry) = library("libwebp", &webp) {
        libraries.push(entry);
    }
    if let Some(entry) = library("libavif", &avif) {
        libraries.push(entry);
    }
    if let Some(entry) = library("libjxl", &jxl) {
        libraries.push(entry);
    }
    libraries.push(AboutLibrary {
        name: "FFmpeg".to_string(),
        version: crate::ffmpeg_setup::pinned_ffmpeg_version().to_string(),
        // 锁定的三端静态构建均为 GPL 变体（与 ffmpeg_setup 来源注口径一致，含 libvmaf）
        license: "GPL".to_string(),
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

    /// 写测试用假可执行脚本。写完 fsync + 短缓冲再返回：
    /// WSL/CI 上 close 后立刻 exec 偶发 ETXTBSY（Text file busy），fsync 推掉回写可关掉竞态窗口。
    #[cfg(unix)]
    fn write_exec(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::File::open(&path).and_then(|f| f.sync_all()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        path
    }

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
        let statuses = tool_status_with(&Settings::default(), dir.path(), Path::new("/未捆绑"), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unconfigured);
        assert!(!cjpeg.builtin_installed);
        assert!(
            cjpeg.hint.as_deref().unwrap().contains("官方发布页"),
            "未配置 hint 应指引官方发布页（决策 0025）：{:?}",
            cjpeg.hint
        );
        assert_eq!(
            cjpeg.release_page.as_deref(),
            Some("https://github.com/mozilla/mozjpeg/releases"),
            "编码器条目应带官方发布页（单一数据源）"
        );
        let ffmpeg = statuses.iter().find(|s| s.key == "ffmpeg").unwrap();
        assert_eq!(ffmpeg.release_page, None, "ffmpeg 走应用内下载，无发布页条目");
        assert_eq!(cjpeg.effective_path, None);
        // 锁定清单版本照报（关于与状态行同源）
        assert!(cjpeg.builtin_version.is_some(), "cjpeg 应带内置锁定版本");
    }

    #[test]
    fn builtin_when_installed_and_probe_ok() {
        let src = pixel_arena_core::encode::mozjpeg_source().unwrap();
        let (dir, path) = tools_with_builtin(&src.name, &src.version, "cjpeg");
        let statuses = tool_status_with(&Settings::default(), dir.path(), Path::new("/未捆绑"), &fake_probe);
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
        let statuses = tool_status_with(&settings, dir.path(), Path::new("/未捆绑"), &fake_probe);
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
        let statuses = tool_status_with(&settings, dir.path(), Path::new("/未捆绑"), &fake_probe);
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
        let statuses = tool_status_with(&settings, dir.path(), Path::new("/未捆绑"), &fake_probe);
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
        let statuses = tool_status_with(&Settings::default(), dir.path(), Path::new("/未捆绑"), &failing);
        let cwebp = statuses.iter().find(|s| s.key == "cwebp").unwrap();
        assert_eq!(cwebp.source, ToolSource::Unavailable);
        let hint = cwebp.hint.as_deref().unwrap();
        assert!(hint.contains("重新下载"), "内置损坏应指引重新下载安装: {hint}");
    }

    #[test]
    fn ffmpeg_status_reads_settings_override_and_pinned_version() {
        let dir = tempfile::tempdir().unwrap();
        let statuses = tool_status_with(&Settings::default(), dir.path(), Path::new("/未捆绑"), &fake_probe);
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
        let statuses = tool_status_with(&Settings::default(), dir.path(), Path::new("/未捆绑"), &fake_probe);
        let keys: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(
            keys,
            ["ffmpeg", "cjpeg", "cwebp", "avifenc", "cjxl", "avifdec"]
        );
    }

    // ---------- T29-4：版本探测读得到 mozjpeg 风格的 stderr 版本输出 ----------

    #[cfg(unix)]
    #[test]
    fn probe_tool_version_reads_stderr_when_stdout_empty() {
        // mozjpeg cjpeg 实测口径：--version 失败退出；-version 成功但版本写 stderr
        let dir = tempfile::tempdir().unwrap();
        let fake = write_exec(
            dir.path(),
            "cjpeg",
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"unknown option\" >&2; exit 1; fi\necho \"mozjpeg version 4.1.5\" >&2\nexit 0\n",
        );
        let version = probe_tool_version(&fake, "cjpeg").unwrap();
        assert_eq!(version, "mozjpeg version 4.1.5");
    }

    #[cfg(unix)]
    #[test]
    fn probe_tool_version_skips_stderr_of_failed_runs() {
        // 失败退出的 stderr 不是版本（unknown option / 报错），不能当作探测结果
        let dir = tempfile::tempdir().unwrap();
        let fake = write_exec(dir.path(), "broken", "#!/bin/sh\necho \"报错信息\" >&2\nexit 2\n");
        let message = probe_tool_version(&fake, "broken").unwrap_err();
        assert!(message.contains("执行失败"), "{message}");
    }

    // ---------- T29-3：高级创建建轮前的批量可用性校验 ----------

    #[test]
    fn tool_status_for_keys_returns_only_requested_keys_in_request_order() {
        let dir = tempfile::tempdir().unwrap();
        let keys = ["cjxl".to_string(), "ffmpeg".to_string(), "cwebp".to_string()];
        let statuses = tool_status_for_keys(&Settings::default(), dir.path(), Path::new("/未捆绑"), &keys, &fake_probe);
        let got: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(got, ["cjxl", "ffmpeg", "cwebp"], "键序按请求序，只含请求键");
    }

    #[test]
    fn tool_status_for_keys_keeps_unavailability_semantics() {
        // 与设置页同源：外部路径失效 → unavailable + 指引；未配置（内置未装）→
        // unconfigured（T32 起建轮前由前端 availabilityErrors 报错红标）
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.encoder_overrides.cjpeg = Some("/不存在/cjpeg".to_string());
        let keys = ["cjpeg".to_string(), "avifenc".to_string()];
        let statuses = tool_status_for_keys(&settings, dir.path(), Path::new("/未捆绑"), &keys, &fake_probe);
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
        let statuses = tool_status_for_keys(&Settings::default(), dir.path(), Path::new("/未捆绑"), &keys, &fake_probe);
        let got: Vec<&str> = statuses.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(got, ["cwebp"], "未知键跳过不报错");
    }

    // ---------- T29-4：安装包捆绑编码器 → 「内置 + 版本号」 ----------

    #[test]
    fn bundled_encoder_reports_builtin_with_pinned_version() {
        // 捆绑目录里有 cjpeg：状态为「内置」，版本行读锁定清单（票面「内置+版本号」）
        let bundled = tempfile::tempdir().unwrap();
        let member = if cfg!(windows) { "cjpeg.exe" } else { "cjpeg" };
        std::fs::write(bundled.path().join(member), b"x").unwrap();
        let tools = tempfile::tempdir().unwrap();
        let statuses =
            tool_status_with(&Settings::default(), tools.path(), bundled.path(), &fake_probe);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Builtin, "{:?}", cjpeg);
        assert!(cjpeg.builtin_installed);
        assert_eq!(
            cjpeg.effective_path.as_deref(),
            Some(bundled.path().join(member).to_str().unwrap()),
            "生效路径应指向捆绑文件"
        );
        assert!(cjpeg.hint.is_none(), "可用时无需提示");
    }

    #[test]
    fn bundled_missing_falls_back_to_tools_install() {
        // 捆绑目录没有该成员（未捆绑/裸构建）：回落 tools/ 安装路径，语义不变
        let bundled = tempfile::tempdir().unwrap();
        let src = pixel_arena_core::encode::webp_source().unwrap();
        let (tools, path) = tools_with_builtin(&src.name, &src.version, "cwebp");
        let statuses =
            tool_status_with(&Settings::default(), tools.path(), bundled.path(), &fake_probe);
        let cwebp = statuses.iter().find(|s| s.key == "cwebp").unwrap();
        assert_eq!(cwebp.source, ToolSource::Builtin);
        assert_eq!(cwebp.effective_path.as_deref(), Some(path.to_str().unwrap()));
    }

    #[test]
    fn broken_bundled_encoder_hints_reinstall_or_external() {
        // 捆绑文件存在但探测失败：不可用，提示重装应用或改外部路径（不能说「自动重下」——
        // 资源目录只读，下载路径回不到捆绑目录）
        let bundled = tempfile::tempdir().unwrap();
        std::fs::write(bundled.path().join("cjpeg"), b"x").unwrap();
        let tools = tempfile::tempdir().unwrap();
        let failing = |_: &Path, tool: &str| -> Result<String, String> {
            Err(format!("{tool} 执行失败"))
        };
        let statuses = tool_status_with(&Settings::default(), tools.path(), bundled.path(), &failing);
        let cjpeg = statuses.iter().find(|s| s.key == "cjpeg").unwrap();
        assert_eq!(cjpeg.source, ToolSource::Unavailable);
        let hint = cjpeg.hint.as_deref().unwrap();
        assert!(hint.contains("重新安装"), "{hint}");
        assert!(hint.contains("外部路径"), "{hint}");
    }

    #[test]
    fn unconfigured_hint_directs_to_settings_or_download() {
        // 全空（未捆绑 + 未安装）：ffmpeg 指引设置页下载/指定路径；编码器说明内置缺失可补装
        let tools = tempfile::tempdir().unwrap();
        let statuses =
            tool_status_with(&Settings::default(), tools.path(), tools.path(), &fake_probe);
        let ffmpeg = statuses.iter().find(|s| s.key == "ffmpeg").unwrap();
        let hint = ffmpeg.hint.as_deref().unwrap();
        assert!(hint.contains("应用内下载"), "{hint}");
        let cjxl = statuses.iter().find(|s| s.key == "cjxl").unwrap();
        assert_eq!(cjxl.source, ToolSource::Unconfigured);
        assert!(cjxl.hint.as_deref().unwrap().contains("内置文件缺失"), "{:?}", cjxl.hint);
    }
}
