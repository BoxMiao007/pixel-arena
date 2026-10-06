// 内置视频流服务（T15）：Linux 端 WebKitGTK 的媒体引擎不走 Tauri 的 asset 自定义协议
// （<video> 直接报 SRC_NOT_SUPPORTED，实测 webkit2gtk 2.52.6；<img> 不受影响，T07 的图片
// 通路不受此限）。逐帧对比的视频元素统一从本服务的本地回环 HTTP 地址拉流，三端同一实现。
//
// 安全边界：只监听 127.0.0.1、端口随机；只暴露通过 IPC 显式注册过的文件路径（id 为路径
// 哈希，无法枚举他人文件）；不支持目录列表。本机其他进程理论上可按 id 读到已注册文件，
// 与开发者本机 dev server 同一暴露级别，不构成新增风险面。实现只用 std，不引 HTTP 依赖。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct VideoStreamServer {
    port: u16,
    registry: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl VideoStreamServer {
    /// 启动流服务（随机端口、每连接一线程：视频加载只有个位数并发）。
    pub fn spawn() -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|err| format!("无法启动视频流服务: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("无法确定视频流服务端口: {err}"))?
            .port();
        let registry: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let registry_thread = registry.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let registry = registry_thread.clone();
                        std::thread::spawn(move || handle_connection(stream, registry));
                    }
                    Err(_) => continue, // 单个连接失败不影响服务
                }
            }
        });
        Ok(Self { port, registry })
    }

    /// 注册一个视频文件，返回它的回环流地址。同一文件重复注册得到同一地址（幂等）。
    pub fn register(&self, path: &Path) -> String {
        // 路径哈希做 id：不把本地路径明文放进 URL，也免去百分号编码
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        let id = format!("{:016x}", hasher.finish());
        self.registry
            .lock()
            .expect("视频流注册表锁不应中毒")
            .insert(id.clone(), path.to_path_buf());
        format!("http://127.0.0.1:{}/v/{id}", self.port)
    }
}

/// 处理单个 HTTP 请求：GET /v/<id>，支持 Range: bytes=a-b / a- / -n（媒体引擎会分段拉流）。
fn handle_connection(mut stream: TcpStream, registry: Arc<Mutex<HashMap<String, PathBuf>>>) {
    let request = match parse_request(&stream) {
        Some(request) => request,
        None => return, // 请求头读不全/不是 GET：直接断开，调用方自会重试
    };
    let path = registry
        .lock()
        .expect("视频流注册表锁不应中毒")
        .get(&request.id)
        .cloned();
    let Some(path) = path else {
        let _ = respond_simple(&stream, 404, "video not registered");
        return;
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        let _ = respond_simple(&stream, 404, "file unreadable");
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);

    // 解析 Range（区间钳制到文件范围）；无 Range 或文件为空则整文件 200
    let (status, start, end) = match request.range {
        Some(range) if len > 0 => {
            let (start, end) = resolve_range(range, len);
            (206, start, end)
        }
        _ => (200, 0, len.saturating_sub(1)),
    };

    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n{}\r\n",
        if status == 206 { "Partial Content" } else { "OK" },
        mime_for_extension(&path),
        end - start + 1,
        if status == 206 {
            format!("Content-Range: bytes {start}-{end}/{len}\r\n")
        } else {
            String::new()
        },
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    // 传输中途断开（常见：媒体引擎拿到足够数据提前关闭连接）不算错误
    let _ = stream_range(&mut file, &stream, start, end);
}

struct Request {
    id: String,
    range: Option<(Option<u64>, Option<u64>)>,
}

fn parse_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" || !target.starts_with("/v/") {
        return None;
    }
    let id = target.trim_start_matches("/v/").split('?').next()?.to_string();
    if id.is_empty() {
        return None;
    }

    let mut range = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break; // 头部结束
        }
        if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("range:") {
            range = parse_range(value.trim());
        }
    }
    Some(Request { id, range })
}

/// 解析 "bytes=a-b" / "bytes=a-" / "bytes=-n" 三种形式；无法解析返回 None。
fn parse_range(value: &str) -> Option<(Option<u64>, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    let (start_part, end_part) = spec.split_once('-')?;
    let parse = |s: &str| s.trim().parse::<u64>().ok();
    if start_part.trim().is_empty() {
        // 后缀形式 bytes=-n：要最后 n 字节
        let n = parse(end_part)?;
        Some((None, Some(n)))
    } else {
        Some((parse(start_part), parse(end_part)))
    }
}

/// 把区间语义折算为绝对字节区间（含两端）；后缀形式在这里换算。
fn resolve_range(range: (Option<u64>, Option<u64>), len: u64) -> (u64, u64) {
    match (range.0, range.1) {
        (None, Some(n)) => {
            // bytes=-n
            let n = n.min(len);
            (len - n, len - 1)
        }
        (Some(start), end) => {
            let start = start.min(len - 1);
            let end = end.unwrap_or(len - 1).min(len - 1);
            (start, end.max(start))
        }
        (None, None) => (0, len - 1),
    }
}

// 参数用「可变绑定 + 共享引用」：Write 对 &TcpStream 的实现要求绑定为 mut
fn respond_simple(mut stream: &TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        match status {
            404 => "Not Found",
            405 => "Method Not Allowed",
            _ => "OK",
        },
        body.len(),
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn stream_range(
    file: &mut std::fs::File,
    mut stream: &TcpStream,
    start: u64,
    end: u64,
) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = end - start + 1;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = buffer.len().min(remaining as usize);
        let n = file.read(&mut buffer[..want])?;
        if n == 0 {
            break; // 文件比声明的短（并发截断等）：截断响应，客户端自会容错
        }
        stream.write_all(&buffer[..n])?;
        remaining -= n as u64;
    }
    stream.flush()
}

/// 常见视频封装的 Content-Type；未知扩展名回退 octet-stream（媒体引擎靠探测兜底）。
fn mime_for_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ts") => "video/mp2t",
        Some("flv") => "video/x-flv",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn serves_registered_file_with_range_support() {
        let server = VideoStreamServer::spawn().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("clip.webm");
        std::fs::write(&file, (0u8..=255).cycle().take(1000).collect::<Vec<u8>>()).unwrap();

        let url = server.register(&file);
        let id = url.rsplit('/').next().unwrap().to_string();
        assert!(url.starts_with("http://127.0.0.1:"));

        // 整文件 200
        let (status, body) = http_get(server_port(&url), &id, None);
        assert_eq!(status, "200");
        assert_eq!(body.len(), 1000);

        // Range: bytes=100-199 → 206 + 正确切片
        let (status, body) = http_get(server_port(&url), &id, Some("bytes=100-199"));
        assert_eq!(status, "206");
        assert_eq!(body.len(), 100);
        assert_eq!(body[0], 100);

        // Range: bytes=900- → 206 到文件尾
        let (status, body) = http_get(server_port(&url), &id, Some("bytes=900-"));
        assert_eq!(status, "206");
        assert_eq!(body.len(), 100);

        // Range: bytes=-50 → 末尾 50 字节
        let (status, body) = http_get(server_port(&url), &id, Some("bytes=-50"));
        assert_eq!(status, "206");
        assert_eq!(body.len(), 50);

        // 未注册的 id → 404
        let (status, _) = http_get(server_port(&url), "deadbeefdeadbeef", None);
        assert_eq!(status, "404");
    }

    #[test]
    fn resolve_range_clamps_to_file_bounds() {
        assert_eq!(resolve_range((Some(10), Some(20)), 15), (10, 14));
        assert_eq!(resolve_range((Some(200), None), 15), (14, 14));
        assert_eq!(resolve_range((None, Some(5)), 15), (10, 14));
        assert_eq!(resolve_range((None, Some(99)), 15), (0, 14));
    }

    #[test]
    fn parse_range_handles_all_forms() {
        assert_eq!(parse_range("bytes=0-"), Some((Some(0), None)));
        assert_eq!(parse_range("bytes=10-20"), Some((Some(10), Some(20))));
        assert_eq!(parse_range("bytes=-30"), Some((None, Some(30))));
        assert_eq!(parse_range("chunked"), None);
    }

    fn server_port(url: &str) -> u16 {
        url.split(':').nth(2).unwrap().split('/').next().unwrap().parse().unwrap()
    }

    /// 极简 HTTP 客户端（测试专用）：返回状态码与响应体。
    fn http_get(port: u16, id: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let range_head = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        stream
            .write_all(
                format!(
                    "GET /v/{id} HTTP/1.1\r\nHost: 127.0.0.1\r\n{range_head}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        let mut response = Vec::new();
        BufReader::new(stream).read_to_end(&mut response).unwrap();
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&response[..split]).to_string();
        let status = head
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_string();
        (status, response[split + 4..].to_vec())
    }
}
