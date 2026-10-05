// ffmpeg 工具准备（T14）：视频跑分依赖含 libvmaf 滤镜的 ffmpeg，系统发行版自带的
// ffmpeg 多数没有（本机 Ubuntu 的 ffmpeg 8.0.1 只有 vmafmotion）。方案：首次使用时
// 把锁定版本的静态构建下载到应用数据目录 tools/ 下，校验 sha256 后解压备用；
// tools/ 里已有 ffmpeg 则直接复用。决策依据与放弃项见 docs/decisions.md 0010、0014。
//
// 锁定来源（按平台，T16 定稿）：
// - Linux：johnvansickle.com 的版本化 release（URL 不会随更新变动），官方公告的 md5
//   已交叉核对一致；
// - Windows：BtbN FFmpeg-Builds 的版本化 autobuild tag（GitHub release 资产不可变，
//   构建配置 --enable-libvmaf 已核对，全静态单文件仅依赖系统 DLL）；
// - macOS：暂无查证过含 libvmaf 的稳定版本化来源，维持中文提示（分发随后续票落实）。
// 代码内锁定 sha256，不匹配即删除重下。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 锁定的 ffmpeg 构建压缩包下载地址（按平台）。
#[cfg(target_os = "linux")]
const FFMPEG_URL: &str = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz";
#[cfg(target_os = "windows")]
const FFMPEG_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-11-30-13-12/ffmpeg-n7.1-39-g64e2864cb9-win64-gpl-7.1.zip";

/// 锁定构建压缩包的 sha256（下载后全量校验，按平台）。
#[cfg(target_os = "linux")]
const FFMPEG_TARBALL_SHA256: &str =
    "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67";
#[cfg(target_os = "windows")]
const FFMPEG_TARBALL_SHA256: &str =
    "f72c2f46c3646a5d4b457d5b7001ff96dc185111455f7866a0456f21e430555b";

/// 压缩包内顶层目录名（Linux 解压时据此定位二进制；Windows 走核心库 zip 解包无需此值）。
#[cfg(target_os = "linux")]
const ARCHIVE_TOP: &str = "ffmpeg-7.0.2-amd64-static";

/// 记录来源信息，便于排查与升级。（ffprobe 供 T15 逐帧对比取帧率/时长，与 ffmpeg 同包同版本）
#[cfg(target_os = "linux")]
const FFMPEG_SOURCE_NOTE: &str = "ffmpeg 7.0.2 amd64 static (johnvansickle.com, GPL, 含 libvmaf) + ffprobe";
#[cfg(target_os = "windows")]
const FFMPEG_SOURCE_NOTE: &str = "ffmpeg 7.1 win64-gpl static (BtbN FFmpeg-Builds autobuild-2024-11-30-13-12, 含 libvmaf) + ffprobe";

/// ffmpeg 可执行文件的落地路径（tools_dir/ffmpeg，Windows 为 ffmpeg.exe）。
pub fn ffmpeg_path(tools_dir: &Path) -> PathBuf {
    tools_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

/// ffprobe 可执行文件的落地路径（tools_dir/ffprobe，Windows 为 ffprobe.exe）。
pub fn ffprobe_path(tools_dir: &Path) -> PathBuf {
    tools_dir.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" })
}

/// 确保 tools/ 里有可用的 ffmpeg，返回其路径。`progress` 收到面向用户的中文进度文本。
pub fn ensure_ffmpeg(
    tools_dir: &Path,
    progress: &mut dyn FnMut(String),
) -> Result<PathBuf, String> {
    let existing = ffmpeg_path(tools_dir);
    if existing.is_file() {
        return Ok(existing);
    }
    install(tools_dir, progress)?;
    Ok(ffmpeg_path(tools_dir))
}

/// 确保 tools/ 里有 ffprobe（T15 逐帧对比读帧率/时长用）。T14 时代的老安装只有 ffmpeg：
/// 此时重走一次安装流程补齐——解压清单已同时含 ffmpeg 与 ffprobe，同版本幂等覆盖。
pub fn ensure_ffprobe(
    tools_dir: &Path,
    progress: &mut dyn FnMut(String),
) -> Result<PathBuf, String> {
    let existing = ffprobe_path(tools_dir);
    if existing.is_file() {
        return Ok(existing);
    }
    install(tools_dir, progress)?;
    let installed = ffprobe_path(tools_dir);
    if installed.is_file() {
        Ok(installed)
    } else {
        Err("ffprobe 安装流程结束后仍不可见，请反馈此问题".to_string())
    }
}

#[cfg(target_os = "linux")]
fn install(tools_dir: &Path, progress: &mut dyn FnMut(String)) -> Result<PathBuf, String> {
    std::fs::create_dir_all(tools_dir).map_err(|err| format!("无法创建工具目录: {err}"))?;

    // 1. 下载到 tools/ 下的临时文件（同盘保证后续操作不跨设备）
    let tarball = tools_dir.join("ffmpeg.tar.xz.tmp");
    let result = download_tarball(&tarball, progress);
    if let Err(err) = result {
        std::fs::remove_file(&tarball).ok();
        return Err(err);
    }

    // 2. 全量 sha256 校验（供应链底线：不匹配即删除，绝不解压）
    progress("正在校验 ffmpeg 完整性…".to_string());
    let actual = sha256_hex(&tarball).map_err(|err| {
        std::fs::remove_file(&tarball).ok();
        format!("读取下载文件失败: {err}")
    })?;
    if actual != FFMPEG_TARBALL_SHA256 {
        std::fs::remove_file(&tarball).ok();
        return Err(format!(
            "下载的 ffmpeg 校验失败（sha256 不匹配），已删除。可能是网络劫持或上游构建变动，请重试或反馈",
        ));
    }

    // 3. 用系统 tar 解出 ffmpeg 与 ffprobe（T15 起）到临时子目录，再挪到最终位置（半途失败不污染 tools/）
    progress("正在解压 ffmpeg…".to_string());
    let staging = tools_dir.join(format!(".ffmpeg-install-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|err| format!("无法创建临时解压目录: {err}"))?;
    let extract = std::process::Command::new("tar")
        .args([
            "-xJf",
            &tarball.display().to_string(),
            "-C",
            &staging.display().to_string(),
            "--strip-components=1",
            &format!("{ARCHIVE_TOP}/ffmpeg"),
            &format!("{ARCHIVE_TOP}/ffprobe"),
        ])
        .output();
    let extract = match extract {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(format!(
            "解压 ffmpeg 失败（需要系统 tar 支持 xz）: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(err) => Err(format!("无法调用系统 tar: {err}")),
    };
    if let Err(err) = extract {
        std::fs::remove_dir_all(&staging).ok();
        std::fs::remove_file(&tarball).ok();
        return Err(err);
    }

    let target = ffmpeg_path(tools_dir);
    std::fs::rename(staging.join("ffmpeg"), &target).map_err(|err| {
        std::fs::remove_dir_all(&staging).ok();
        std::fs::remove_file(&tarball).ok();
        format!("无法安置 ffmpeg: {err}")
    })?;
    let probe_target = ffprobe_path(tools_dir);
    std::fs::rename(staging.join("ffprobe"), &probe_target).map_err(|err| {
        std::fs::remove_dir_all(&staging).ok();
        std::fs::remove_file(&tarball).ok();
        format!("无法安置 ffprobe: {err}")
    })?;
    std::fs::remove_dir_all(&staging).ok();
    std::fs::remove_file(&tarball).ok();

    // 4. 明确可执行权限（tar 通常已保留，补一道防呆）
    #[allow(unused_mut)]
    for binary in [&target, &probe_target] {
        if let Ok(mut perms) = std::fs::metadata(binary).map(|m| m.permissions()) {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(binary, perms);
        }
    }

    // 5. 记录来源，便于排查与将来升级版本
    let _ = std::fs::write(
        tools_dir.join("ffmpeg-source.txt"),
        format!("{FFMPEG_SOURCE_NOTE}\nurl: {FFMPEG_URL}\nsha256: {FFMPEG_TARBALL_SHA256}\n安装时间: {}\n",
            chrono_like_now()),
    );

    progress("ffmpeg 就绪".to_string());
    Ok(target)
}

#[cfg(target_os = "windows")]
fn install(tools_dir: &Path, progress: &mut dyn FnMut(String)) -> Result<PathBuf, String> {
    std::fs::create_dir_all(tools_dir).map_err(|err| format!("无法创建工具目录: {err}"))?;

    // 1. 下载 zip 到 tools/ 下的临时文件（同盘保证后续操作不跨设备）
    let zip_path = tools_dir.join("ffmpeg.zip.tmp");
    let result = download_tarball(&zip_path, progress);
    if let Err(err) = result {
        std::fs::remove_file(&zip_path).ok();
        return Err(err);
    }

    // 2. 全量 sha256 校验（供应链底线：不匹配即删除，绝不解压）
    progress("正在校验 ffmpeg 完整性…".to_string());
    let actual = sha256_hex(&zip_path).map_err(|err| {
        std::fs::remove_file(&zip_path).ok();
        format!("读取下载文件失败: {err}")
    })?;
    if actual != FFMPEG_TARBALL_SHA256 {
        std::fs::remove_file(&zip_path).ok();
        return Err(format!(
            "下载的 ffmpeg 校验失败（sha256 不匹配），已删除。可能是网络劫持或上游构建变动，请重试或反馈",
        ));
    }

    // 3. 解出 ffmpeg.exe 与 ffprobe.exe 到临时子目录，再挪到最终位置（半途失败不污染 tools/）。
    //    官方包约 150MB，整包读入内存解压（一次性安装，可接受）；BtbN 包内路径为
    //    bin/ffmpeg.exe、bin/ffprobe.exe，extract_archive_members 按文件名匹配。
    progress("正在解压 ffmpeg…".to_string());
    let archive = std::fs::read(&zip_path)
        .map_err(|err| format!("读取下载文件失败: {err}"))?;
    let staging = tools_dir.join(format!(".ffmpeg-install-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|err| format!("无法创建临时解压目录: {err}"))?;
    let extract = pixel_arena_core::encode::extract_archive_members(
        &archive,
        &["ffmpeg.exe", "ffprobe.exe"],
        &staging,
    )
    .map_err(|err| format!("解压 ffmpeg 失败: {err}"));
    if let Err(err) = extract {
        std::fs::remove_dir_all(&staging).ok();
        std::fs::remove_file(&zip_path).ok();
        return Err(err);
    }

    // 4. 安置。Windows 的 rename 不覆盖已存在文件，先删旧文件保证重装/补装幂等
    //   （ffprobe 补装场景 ffmpeg 已在位，与 Linux 的 tar 覆盖语义对齐）。
    let target = ffmpeg_path(tools_dir);
    let probe_target = ffprobe_path(tools_dir);
    let place = |staged: &Path, dest: &Path| -> Result<(), String> {
        std::fs::remove_file(dest).ok();
        std::fs::rename(staged, dest)
            .map_err(|err| format!("无法安置 ffmpeg 工具 {}：{err}", dest.display()))
    };
    if let Err(err) = place(&staging.join("ffmpeg.exe"), &target)
        .and_then(|_| place(&staging.join("ffprobe.exe"), &probe_target))
    {
        std::fs::remove_dir_all(&staging).ok();
        std::fs::remove_file(&zip_path).ok();
        return Err(err);
    }
    std::fs::remove_dir_all(&staging).ok();
    std::fs::remove_file(&zip_path).ok();

    // 5. 记录来源，便于排查与将来升级版本
    let _ = std::fs::write(
        tools_dir.join("ffmpeg-source.txt"),
        format!("{FFMPEG_SOURCE_NOTE}\nurl: {FFMPEG_URL}\nsha256: {FFMPEG_TARBALL_SHA256}\n安装时间: {}\n",
            chrono_like_now()),
    );

    progress("ffmpeg 就绪".to_string());
    Ok(target)
}

#[cfg(target_os = "macos")]
fn install(_tools_dir: &Path, _progress: &mut dyn FnMut(String)) -> Result<PathBuf, String> {
    // macOS 暂无查证过「含 libvmaf + 版本化锁定 URL + 可锚定哈希」三条件齐备的稳定来源
    //（决策 0014）：-evermeet 构建不含 libvmaf，osxexperts 无版本化锁定。分发随后续票落实。
    Err(
        "macOS 侧 ffmpeg 分发随后续票落实；当前请手动把含 libvmaf 的 ffmpeg（及 ffprobe）放到应用数据目录的 tools/ 文件夹里"
            .to_string(),
    )
}

/// 下载压缩包，边下边把「已下载 MB / 总 MB」报给 progress。
#[cfg(not(target_os = "macos"))]
fn download_tarball(tarball: &Path, progress: &mut dyn FnMut(String)) -> Result<(), String> {
    let agent = http_agent().map_err(|err| format!("初始化网络失败: {err}"))?;
    let response = agent
        .get(FFMPEG_URL)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|err| format!("下载 ffmpeg 失败: {err}"))?;

    let total = response
        .header("Content-Length")
        .and_then(|len| len.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(tarball)
        .map_err(|err| format!("无法创建下载临时文件: {err}"))?;

    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|err| format!("下载中断: {err}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buffer[..n])
            .map_err(|err| format!("写入下载文件失败: {err}"))?;
        downloaded += n as u64;
        // 每下载约 2MB 报一次进度，避免事件刷屏
        if downloaded - last_reported >= 2 * 1024 * 1024 {
            last_reported = downloaded;
            match total {
                Some(total) => progress(format!(
                    "正在下载 ffmpeg（一次性，约 {} MB）… {:.1} / {:.1} MB",
                    total / (1024 * 1024),
                    downloaded as f64 / (1024.0 * 1024.0),
                    total as f64 / (1024.0 * 1024.0)
                )),
                None => progress(format!(
                    "正在下载 ffmpeg（一次性）… {:.1} MB",
                    downloaded as f64 / (1024.0 * 1024.0)
                )),
            }
        }
    }
    Ok(())
}

/// 显式复用系统代理环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），没设则直连。
#[cfg(not(target_os = "macos"))]
fn http_agent() -> Result<ureq::Agent, String> {
    let mut builder = ureq::AgentBuilder::new();
    let proxy_env = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .filter(|value| !value.trim().is_empty());
    if let Some(proxy) = proxy_env {
        let proxy = ureq::Proxy::new(proxy.trim()).map_err(|err| format!("代理配置无效: {err}"))?;
        builder = builder.proxy(proxy);
    }
    Ok(builder.build())
}

#[cfg(not(target_os = "macos"))]
fn sha256_hex(path: &Path) -> Result<String, std::io::Error> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 本地时间戳（仅用于来源记录，格式宽松即可）。
#[cfg(not(target_os = "macos"))]
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_ffmpeg_is_reused_without_network() {
        // tools/ 里已有 ffmpeg（哪怕是个占位文件）时直接复用，不触发下载
        let dir = tempfile::tempdir().unwrap();
        let marker = ffmpeg_path(dir.path());
        std::fs::write(&marker, b"placeholder").unwrap();
        let mut messages: Vec<String> = Vec::new();
        let resolved = ensure_ffmpeg(dir.path(), &mut |msg| messages.push(msg)).unwrap();
        assert_eq!(resolved, marker);
        assert!(messages.is_empty(), "已就绪时不应有进度消息: {messages:?}");
    }

    #[test]
    fn ffmpeg_path_matches_platform() {
        let dir = Path::new("/tmp/tools");
        if cfg!(windows) {
            assert_eq!(ffmpeg_path(dir), Path::new("/tmp/tools/ffmpeg.exe").to_path_buf());
        } else {
            assert_eq!(ffmpeg_path(dir), Path::new("/tmp/tools/ffmpeg").to_path_buf());
        }
    }

    #[test]
    fn existing_ffprobe_is_reused_without_network() {
        // tools/ 里已有 ffprobe（哪怕是个占位文件）时直接复用，不触发下载
        let dir = tempfile::tempdir().unwrap();
        let marker = ffprobe_path(dir.path());
        std::fs::write(&marker, b"placeholder").unwrap();
        let mut messages: Vec<String> = Vec::new();
        let resolved = ensure_ffprobe(dir.path(), &mut |msg| messages.push(msg)).unwrap();
        assert_eq!(resolved, marker);
        assert!(messages.is_empty(), "已就绪时不应有进度消息: {messages:?}");
    }

    /// 手动跑一次真实下载安装（网络 + 约 40MB）：`cargo test -p pixel-arena -- --ignored`。
    /// 跑之前把临时 tools 目录清掉，结束后目录里应有 ffmpeg、ffprobe 与来源记录。
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "需要网络与约 40MB 下载，仅手动验证"]
    fn downloads_and_installs_ffmpeg_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut messages: Vec<String> = Vec::new();
        let resolved = ensure_ffmpeg(dir.path(), &mut |msg| messages.push(msg)).unwrap();
        assert!(resolved.is_file());
        assert!(messages.first().unwrap().contains("下载"));
        assert!(dir.path().join("ffmpeg-source.txt").is_file());
        // 校验跑分通路：-version 能执行
        let out = std::process::Command::new(&resolved).arg("-version").output().unwrap();
        assert!(out.status.success());
        // T15：ffprobe 与 ffmpeg 同包解压安置
        let probe = ffprobe_path(dir.path());
        assert!(probe.is_file());
        let out = std::process::Command::new(&probe).arg("-version").output().unwrap();
        assert!(out.status.success());
    }
}
