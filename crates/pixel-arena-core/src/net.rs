// 共享的网络下载与文件哈希：编码器安装（encode.rs）与应用壳的 ffmpeg 安装
// （src-tauri ffmpeg_setup.rs）原是两份同构实现（决策 0009/0010 各写一遍），
// 下沉到核心库统一——系统代理复用、大小上限、分块读流、sha256 校验同一套口径。
// 下载失败只给简短原因（ureq 的 Status 错误文本自带完整 URL），由调用方包上
// 各自场景的上下文（「下载编码器失败…」/「下载 ffmpeg 失败…」）。

use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// 分块大小（下载与文件哈希共用；哈希侧沿用原 ffmpeg 实现的 64KB 块）。
const CHUNK_BYTES: usize = 64 * 1024;

/// 带系统代理复用与大小上限的 HTTP GET：响应体按块交给 sink（由调用方决定
/// 进内存还是落盘），每块回调 progress（已下载字节数, 总字节数——Content-Length
/// 缺失时为 None），返回总字节数。超过 max_bytes 即失败（防劫持/误配把巨物
/// 拉满内存或磁盘）；请求超时 600s（原编码器 300s / ffmpeg 600s 统一取宽松值）。
pub fn download(
    url: &str,
    max_bytes: u64,
    progress: &mut dyn FnMut(u64, Option<u64>),
    sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
) -> Result<u64, String> {
    let mut builder = ureq::AgentBuilder::new();
    // 优先复用系统代理（HTTPS_PROXY / ALL_PROXY 等），网络受限环境不配置就走直连
    let proxy_env = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.trim().is_empty()));
    if let Some(proxy) = proxy_env {
        let proxy = ureq::Proxy::new(&proxy)
            .map_err(|err| format!("代理地址无效（{proxy}）：{err}"))?;
        builder = builder.proxy(proxy);
    }
    let response = builder
        .build()
        .get(url)
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|err| match &err {
            // ureq 的 Status 错误文本自带完整 URL，与调用方外层重复；只留状态码
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?;
    let total = response
        .header("Content-Length")
        .and_then(|len| len.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut buffer = [0u8; CHUNK_BYTES];
    let mut downloaded: u64 = 0;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|err| format!("下载中断：{err}"))?;
        if n == 0 {
            return Ok(downloaded);
        }
        downloaded += n as u64;
        if downloaded > max_bytes {
            return Err(format!("下载内容超过大小上限（{max_bytes} 字节），已中止"));
        }
        sink(&buffer[..n]).map_err(|err| format!("写入下载数据失败：{err}"))?;
        progress(downloaded, total);
    }
}

/// 文件内容的 sha256 十六进制串（编码器与 ffmpeg 安装共用同一校验口径）。
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0u8; CHUNK_BYTES];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 起一个本地 HTTP 假服务器：对每个连接回同样的 8 字节正文（可应答多次）。
    fn serve_body(body: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut head = Vec::new();
                let mut chunk = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    head.extend_from_slice(&chunk[..n]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(body);
            }
        });
        format!("http://{addr}/tool.tar.gz")
    }

    /// 超过大小上限：整体失败、错误可读；sink 不得收到超出上限的数据。
    #[test]
    fn download_rejects_body_over_limit() {
        let url = serve_body(b"12345678");
        let mut received: Vec<u8> = Vec::new();
        let err = download(
            &url,
            4,
            &mut |_, _| {},
            &mut |chunk| {
                received.extend_from_slice(chunk);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(err.contains("大小上限"), "超限应明确报错：{err}");
        assert!(received.len() <= 4, "超出上限的字节不应交给 sink：{received:?}");
    }

    /// 正常路径：sink 收全正文、总字节数正确、进度按块回调。
    #[test]
    fn download_streams_body_and_reports_progress() {
        let url = serve_body(b"12345678");
        let mut received: Vec<u8> = Vec::new();
        let mut progress_calls = 0;
        let mut last_downloaded = 0;
        let total = download(
            &url,
            64,
            &mut |downloaded, reported_total| {
                progress_calls += 1;
                last_downloaded = downloaded;
                assert_eq!(reported_total, Some(8), "Content-Length 应传给进度回调");
            },
            &mut |chunk| {
                received.extend_from_slice(chunk);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(total, 8);
        assert_eq!(received, b"12345678");
        assert!(progress_calls > 0 && last_downloaded == 8);
    }

    #[test]
    fn sha256_file_matches_known_vector() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, b"abc").unwrap();
        // sha256("abc") 的公开测试向量
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(sha256_file(&dir.path().join("missing")).is_err());
    }
}
