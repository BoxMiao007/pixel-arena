// 一站式模式编码编排（T10 第一条竖切片：JPEG × MozJPEG）。
//
// 编码器分发方案（docs/decisions.md 0009）：权威参考编码器不随应用捆绑，首次使用时
// 按「编码器来源清单」（EncoderSource：版本锁定的 URL + sha256）下载到应用数据目录的
// tools/mozjpeg/<版本>/，校验通过才落盘；之后每次使用先用 sha256 验旧文件，坏了自动重下。
// 工件统一为 .tar.gz（内含 cjpeg 可执行文件），三端同一套下载/校验/解包机制，只差清单条目。
//
// 编码链路：image crate 解码原图（与跑分同一套 decode_srgb 口径）→ 写 P6 PPM 临时文件
// → 喂给 cjpeg 子进程（cjpeg 不吃 PNG/WebP，只认 PPM/PGM 等）→ 产物写到评测轮工作目录。
//
// CLI（T12）复用 encode_jpeg / install_encoder，无需新逻辑。

use crate::error::CoreError;
use crate::metrics::decode_srgb;
use sha2::{Digest, Sha256};
use std::io::{Read, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// 每平台一份的编码器来源条目：版本、下载地址、sha256、压缩包内可执行文件名。
#[derive(Debug, Clone)]
pub struct EncoderSource {
    /// 编码器版本（安装目录名的一部分）。
    pub version: String,
    /// tar.gz 工件下载地址。
    pub url: String,
    /// 工件 sha256（小写十六进制）。升级版本 = 换 URL + 换哈希，一起改。
    pub sha256: String,
    /// 工件内 cjpeg 可执行文件的文件名（按文件名匹配，容忍包内多一层目录）。
    pub member: String,
}

/// 当前平台的 MozJPEG 来源清单。没有分发的平台返回中文错误（清单条目随打包票补齐）。
pub fn mozjpeg_source() -> Result<EncoderSource, CoreError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(EncoderSource {
            version: "4.1.5".to_string(),
            // 工件由本机静态构建（无 SIMD，仅依赖 libc/libm），打包票（T16）把构建搬进 CI
            // 并上传到本项目 GitHub Release；上传前 URL 会 404，测试可用
            // PIXEL_ARENA_ENCODER_MIRROR=<目录URL> 覆盖下载主机（同名工件）。
            url: "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-linux-x86_64.tar.gz"
                .to_string(),
            sha256: "6c2795a90da52d2fe0361fc6580cf4be309bb873797acb967725fe8f98325dee".to_string(),
            member: "cjpeg".to_string(),
        }),
        (os, arch) => Err(CoreError::Encode {
            message: format!(
                "{os}-{arch} 平台暂无分发的 MozJPEG 编码器（同一套下载机制，清单条目由打包票补齐），请先用外部导入模式"
            ),
        }),
    }
}

/// 一站式入口：确保编码器就位（需要时自动下载校验），再把原图编码为指定质量的 JPEG。
///
/// 产物写到 `output_dir/<原图名>-q<quality>.jpg`（评测轮工作目录），同名覆盖（幂等）。
pub fn encode_jpeg(
    source: impl AsRef<Path>,
    quality: u8,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    validate_quality(quality)?;
    let encoder = install_encoder(&mozjpeg_source()?, tools_dir)?;
    encode_jpeg_using(encoder, source, quality, output_dir)
}

/// 用指定的编码器可执行文件把原图编码为 JPEG（`encode_jpeg` 的可注入缝，测试用）。
pub fn encode_jpeg_using(
    encoder: impl AsRef<Path>,
    source: impl AsRef<Path>,
    quality: u8,
    output_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    validate_quality(quality)?;
    let encoder = encoder.as_ref();
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();

    // 与跑分完全相同的解码口径：同一张原图，喂给编码器的像素 = 算指标时看到的像素
    let decoded = decode_srgb(source)?;
    let (width, height) = decoded.dimensions();

    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| CoreError::Encode {
            message: format!("原图路径无法确定文件名：{}", source.display()),
        })?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    // 先写临时名再重命名：编码中途失败不会留下半截 .jpg 被当成产物
    let product = output_dir.join(format!("{stem}-q{quality}.jpg"));
    let product_tmp = output_dir.join(format!("{stem}-q{quality}.jpg.tmp"));

    let result = run_encoder(encoder, quality, &decoded, width, height, &product_tmp);
    match result {
        Ok(()) => {
            std::fs::rename(&product_tmp, &product).map_err(|err| CoreError::Encode {
                message: format!("无法保存编码产物 {}：{err}", product.display()),
            })?;
            Ok(product)
        }
        Err(err) => {
            std::fs::remove_file(&product_tmp).ok(); // 清理可能的半截临时文件
            Err(err)
        }
    }
}

fn run_encoder(
    encoder: &Path,
    quality: u8,
    decoded: &image::ImageBuffer<image::Rgb<u8>, Vec<u8>>,
    width: u32,
    height: u32,
    product_tmp: &Path,
) -> Result<(), CoreError> {
    // cjpeg 只认 PPM/PGM 等无损容器：把解码像素包成 P6 PPM 临时文件。
    // 不走 stdin 管道：要同时读 cjpeg 的 stderr，大输出下双管道互塞会死锁，临时文件最稳。
    let ppm = tempfile::NamedTempFile::new().map_err(|err| CoreError::Encode {
        message: format!("无法创建 PPM 临时文件：{err}"),
    })?;
    {
        let mut writer = BufWriter::new(ppm.as_file());
        writer
            .write_all(format!("P6\n{width} {height}\n255\n").as_bytes())
            .and_then(|_| writer.write_all(decoded.as_raw()))
            .map_err(|err| CoreError::Encode {
                message: format!("无法写入 PPM 临时文件：{err}"),
            })?;
        writer.flush().map_err(|err| CoreError::Encode {
            message: format!("无法写入 PPM 临时文件：{err}"),
        })?;
    }

    let output = Command::new(encoder)
        .arg("-quality")
        .arg(quality.to_string())
        .arg("-outfile")
        .arg(product_tmp)
        .arg(ppm.path())
        .output()
        .map_err(|err| CoreError::Encode {
            message: format!("无法启动编码器 {}：{err}", encoder.display()),
        })?;

    if !output.status.success() {
        let code = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "信号中断".to_string());
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr = if stderr.is_empty() { "（无错误输出）".to_string() } else { stderr };
        return Err(CoreError::Encode {
            message: format!("MozJPEG cjpeg 退出码 {code}：{stderr}"),
        });
    }
    if !product_tmp.exists() {
        return Err(CoreError::Encode {
            message: format!("编码器正常退出但没有生成产物文件：{}", product_tmp.display()),
        });
    }
    Ok(())
}

fn validate_quality(quality: u8) -> Result<(), CoreError> {
    if quality == 0 || quality > 100 {
        return Err(CoreError::Encode {
            message: format!("JPEG 质量 {quality} 无效，有效范围 1–100"),
        });
    }
    Ok(())
}

// ---------- 编码器安装（下载 → sha256 → 解包 → 复用） ----------

/// 确保来源清单指向的编码器已安装在 `<tools_dir>/mozjpeg/<版本>/<member>` 并返回其路径。
///
/// - 本地已有且与安装时写下的 `<member>.sha256` 吻合 → 直接复用（不联网）；
/// - 本地没有、或文件与安装时哈希不符（损坏/被改）→ 重新下载、校验、解包覆盖；
/// - 下载内容与登记 sha256 不符 → 报错且不落盘（杜绝损坏或被篡改的编码器进入执行）。
///
/// 两处哈希职责不同：来源清单的 sha256 锚定「下载的 tar.gz 工件」；
/// 安装目录里的 `<member>.sha256` 锚定「解包后的可执行文件」，供下次启动免下载校验。
pub fn install_encoder(
    encode_source: &EncoderSource,
    tools_dir: impl AsRef<Path>,
) -> Result<PathBuf, CoreError> {
    let tools_dir = tools_dir.as_ref();
    let dest_dir = tools_dir.join("mozjpeg").join(&encode_source.version);
    let dest = dest_dir.join(&encode_source.member);
    let dest_hash_sidecar = dest_dir.join(format!("{}.sha256", encode_source.member));

    if dest.is_file()
        && dest_hash_sidecar.is_file()
        && sha256_file(&dest)? == std::fs::read_to_string(&dest_hash_sidecar).unwrap_or_default().trim()
    {
        return Ok(dest);
    }

    std::fs::create_dir_all(&dest_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建编码器目录 {}：{err}", dest_dir.display()),
    })?;

    let url = resolve_url(&encode_source.url);
    let archive = download(&url)?;
    let actual = {
        use sha2::Digest;
        format!("{:x}", Sha256::digest(&archive))
    };
    if !actual.eq_ignore_ascii_case(&encode_source.sha256) {
        return Err(CoreError::Encode {
            message: format!(
                "下载的编码器 sha256 校验失败（登记 {}，实际 {actual}），已拒绝安装。来源：{url}",
                &encode_source.sha256
            ),
        });
    }

    extract_member(&archive, &encode_source.member, &dest)?;
    // 记下解包后文件的哈希，作为后续启动免下载校验的锚点
    std::fs::write(&dest_hash_sidecar, sha256_file(&dest)?).map_err(|err| CoreError::Encode {
        message: format!("无法写入编码器校验文件 {}：{err}", dest_hash_sidecar.display()),
    })?;
    Ok(dest)
}

/// 下载地址解析：PIXEL_ARENA_ENCODER_MIRROR 环境变量可把下载主机换成镜像目录
/// （拼上原工件文件名），用于离线/内网环境与本票的分发机制测试。
fn resolve_url(url: &str) -> String {
    match std::env::var("PIXEL_ARENA_ENCODER_MIRROR") {
        Ok(mirror) if !mirror.trim().is_empty() => {
            let file = url.rsplit('/').next().unwrap_or(url);
            format!("{}/{}", mirror.trim_end_matches('/'), file)
        }
        _ => url.to_string(),
    }
}

fn download(url: &str) -> Result<Vec<u8>, CoreError> {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(300));
    // 优先复用系统代理（HTTPS_PROXY 等），网络受限环境不配置就走直连
    let proxy_env = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()));
    if let Some(proxy) = proxy_env {
        match ureq::Proxy::new(&proxy) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(_) => return Err(CoreError::Encode {
                message: format!("代理地址无效（{proxy}），无法下载编码器"),
            }),
        }
    }
    let response = builder
        .build()
        .get(url)
        .call()
        .map_err(|err| {
            // ureq 的 Status 错误文本自带完整 URL，与外层重复；只留状态码与简短原因
            let reason = match &err {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                other => other.to_string(),
            };
            CoreError::Encode {
                message: format!("下载 MozJPEG 编码器失败（{url}）：{reason}"),
            }
        })?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(64 * 1024 * 1024) // 防御：工件上限 64MB，超出即异常
        .read_to_end(&mut bytes)
        .map_err(|err| CoreError::Encode {
            message: format!("下载 MozJPEG 编码器中断（{url}）：{err}"),
        })?;
    Ok(bytes)
}

fn extract_member(archive: &[u8], member: &str, dest: &Path) -> Result<(), CoreError> {
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().map_err(|err| CoreError::Encode {
        message: format!("编码器压缩包无法读取：{err}"),
    })? {
        let mut entry = entry.map_err(|err| CoreError::Encode {
            message: format!("编码器压缩包无法读取：{err}"),
        })?;
        let name = entry.path().map_err(|err| CoreError::Encode {
            message: format!("编码器压缩包无法读取：{err}"),
        })?;
        // 按文件名匹配（清单只登记 member 文件名），容忍包内带一层版本目录
        if name.file_name().map(|n| n == member).unwrap_or(false) {
            entry.unpack(dest).map_err(|err| CoreError::Encode {
                message: format!("无法解出编码器 {}：{err}", dest.display()),
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755)).map_err(
                    |err| {
                        CoreError::Encode {
                            message: format!("无法设置编码器执行权限：{err}"),
                        }
                    },
                )?;
            }
            return Ok(());
        }
    }
    Err(CoreError::Encode {
        message: format!("编码器压缩包里找不到 {member}，工件与来源清单不符"),
    })
}

fn sha256_file(path: &Path) -> Result<String, CoreError> {
    let mut file = std::fs::File::open(path).map_err(|err| CoreError::Encode {
        message: format!("无法读取已安装的编码器 {}：{err}", path.display()),
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| CoreError::Encode {
            message: format!("无法读取已安装的编码器 {}：{err}", path.display()),
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
