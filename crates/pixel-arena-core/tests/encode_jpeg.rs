// 一站式编码编排（T10）的黑盒测试：只走公共 API，断言「给定输入文件，产生什么文件/错误」。
//
// 编码器以桩脚本代替真实 MozJPEG（离线可跑、CI 稳定）；真实 MozJPEG 的端到端
// 验证由环境变量 PIXEL_ARENA_CJPEG_PATH 门控的本机测试承担（见 T10 笔记）。
// 桩编码器用 shell 脚本实现，故涉及子进程的用例仅 POSIX 可跑。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use pixel_arena_core::encode::{encode_jpeg_using, install_encoder, EncoderSource};

fn data(name: &str) -> String {
    format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))
}

// ---------- 编码主流程 ----------

#[cfg(unix)]
fn write_stub_encoder(path: &std::path::Path) {
    // 桩约定：$1=-quality $2=质量值 $3=-outfile $4=产物路径 $5=输入 PPM 路径。
    // 行为：把 PPM 拷到 <脚本路径>.ppm-copy（供断言喂进了什么），把固定字节写进产物。
    std::fs::write(
        path,
        "#!/bin/sh\ncp \"$5\" \"$0.ppm-copy\"\nprintf 'FAKEJPEG' > \"$4\"\nexit 0\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn encode_jpeg_using_pipes_ppm_and_writes_product() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-encode-ok-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let encoder = dir.join("fake-cjpeg.sh");
    write_stub_encoder(&encoder);
    let ppm_copy = dir.join("fake-cjpeg.sh.ppm-copy");

    // photo-ref.png：256x256 照片样例（黄金基准样例之一）
    let out_dir = dir.join("out");
    let out = encode_jpeg_using(
        &encoder,
        data("photo-ref.png"),
        75,
        &out_dir,
    )
    .expect("编码应成功");
    let out_str = out.to_string_lossy().into_owned();
    assert!(out_str.ends_with("photo-ref_jpeg_q75.jpg"), "产物名应含原图名与质量档: {out_str}");

    // 产物内容 = 桩编码器写入的字节（我们不做二次加工）
    assert_eq!(std::fs::read(&out).unwrap(), b"FAKEJPEG");

    // 喂给编码器的必须是 P6 PPM，且像素与原图解码一致（256x256 8-bit RGB）
    let mut ppm = Vec::new();
    std::fs::File::open(&ppm_copy).unwrap().read_to_end(&mut ppm).unwrap();
    let header_end = ppm
        .windows(4)
        .position(|w| w == b"255\n")
        .map(|i| i + 4)
        .expect("应有 maxval 行");
    let header = String::from_utf8_lossy(&ppm[..header_end]).into_owned();
    assert!(header.starts_with("P6\n256 256\n255\n"), "PPM 头应为 P6/256x256/255: {header:?}");
    assert_eq!(ppm.len() - header_end, 256 * 256 * 3, "像素数据应为 8-bit RGB 三通道");

    // 重复编码同档不再覆盖（T29-1 决策 D9）：冲突自动追加 _1，旧产物原样保留
    let again = encode_jpeg_using(&encoder, data("photo-ref.png"), 75, &out_dir).expect("重复编码应成功");
    assert_eq!(again, out_dir.join("photo-ref_jpeg_q75_1.jpg"), "冲突产物应追加 _1");
    assert_eq!(std::fs::read(&again).unwrap(), b"FAKEJPEG");
    assert!(out.is_file(), "旧产物不得被覆盖");

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_failure_surfaces_exit_code_and_stderr_in_chinese_error() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-encode-fail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let encoder = dir.join("fake-cjpeg.sh");
    std::fs::write(&encoder, "#!/bin/sh\necho '编码器炸了' >&2\nexit 3\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&encoder, std::fs::Permissions::from_mode(0o755)).unwrap();

    let out_dir = dir.join("out");
    let message = encode_jpeg_using(&encoder, data("photo-ref.png"), 60, &out_dir)
        .err()
        .expect("非零退出应报错")
        .to_string();
    assert!(message.contains("编码器炸了"), "stderr 应透传: {message}");
    assert!(message.contains('3'), "退出码应在错误里: {message}");
    // 不留半截产物
    assert!(!out_dir.join("photo-ref_jpeg_q60.jpg").exists(), "失败不得留下产物文件");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn quality_out_of_range_fails_fast_without_running_encoder() {
    // 编码器路径指向不存在的可执行文件：若实现先启动子进程就会得到「无法启动」类错误
    for bad in [0u8, 101u8] {
        let message = encode_jpeg_using("/绝不存在/的/cjpeg", data("photo-ref.png"), bad, std::env::temp_dir())
            .err()
            .expect("越界质量应报错")
            .to_string();
        assert!(message.contains("质量"), "错误应说明质量无效: {message}");
    }
}

#[test]
fn missing_source_file_reports_chinese_io_error() {
    // 质量合法、编码器随便填：原图读不了要在启动编码器之前报错
    let message = encode_jpeg_using("/绝不存在/的/cjpeg", "/不存在/原图.png", 75, std::env::temp_dir())
        .err()
        .expect("原图不存在应报错")
        .to_string();
    assert!(message.contains("无法读取"), "应是中文 IO 错误: {message}");
}

// ---------- 编码器安装（下载 → sha256 校验 → 解包 → 复用） ----------

/// 起一个只服务指定字节的本地 HTTP 服务器，返回（base URL, 请求计数）。
/// 每个连接读掉请求头后回一个 200 + Content-Length，随即关闭。
fn serve_bytes(body: &'static [u8]) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_for_thread = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            hits_for_thread.fetch_add(1, Ordering::SeqCst);
            // 读掉请求头（读到 \r\n\r\n 或流结束为止）
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
            let _ = stream.flush();
        }
    });
    (format!("http://{addr}"), hits)
}

/// 打一个 tar.gz：内含 nested/<member>，内容 = content，权限 755。
fn tar_gz(member: &str, content: &[u8]) -> Vec<u8> {
    let mut tar_builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    tar_builder.append_data(&mut header, member, content).unwrap();
    let tar_bytes = tar_builder.into_inner().unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&tar_bytes).unwrap();
    gz.finish().unwrap()
}

fn source_for(url: String, sha256: String, member: &'static str) -> EncoderSource {
    EncoderSource {
        name: "mozjpeg".to_string(),
        version: "test".to_string(),
        url,
        sha256,
        member: member.to_string(),
    }
}

#[test]
fn install_encoder_downloads_verifies_installs_and_reuses() {
    let script = b"#!/bin/sh\nprintf 'FAKEJPEG' > \"$4\"\n";
    let archive = tar_gz("mozjpeg-test/cjpeg", script);
    let expected_sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&archive))
    };
    let (base, hits) = serve_bytes(Box::leak(archive.into_boxed_slice()));
    let source = source_for(format!("{base}/mozjpeg-test.tar.gz"), expected_sha, "cjpeg");

    let tools = std::env::temp_dir().join(format!("pixel-arena-tools-{}", std::process::id()));
    let installed = install_encoder(&source, &tools).expect("安装应成功");

    // 落位：<tools>/mozjpeg/<version>/<member>
    assert_eq!(
        installed,
        tools.join("mozjpeg").join("test").join("cjpeg"),
        "安装路径规则: {installed:?}"
    );
    assert_eq!(std::fs::read(&installed).unwrap(), script, "安装内容 = 压缩包内的成员文件");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0, "安装出的编码器必须可执行: mode={mode:o}");
    }

    // 二次调用：本地哈希校验通过，直接复用，不再发起下载
    let again = install_encoder(&source, &tools).expect("二次安装应成功");
    assert_eq!(again, installed);
    assert_eq!(hits.load(Ordering::SeqCst), 1, "第二次安装不应重新下载");

    std::fs::remove_dir_all(&tools).ok();
}

#[test]
fn install_encoder_rejects_corrupted_download() {
    // 压缩包真身是 A，来源清单里登记的是 B 的哈希 → 校验必须失败且不落盘
    let archive = tar_gz("mozjpeg-test/cjpeg", b"real-bytes");
    let wrong_sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(b"something-else"))
    };
    let (base, hits) = serve_bytes(Box::leak(archive.into_boxed_slice()));
    let source = source_for(format!("{base}/mozjpeg-test.tar.gz"), wrong_sha, "cjpeg");

    let tools = std::env::temp_dir().join(format!("pixel-arena-tools-corrupt-{}", std::process::id()));
    let message = install_encoder(&source, &tools).err().expect("哈希不符应报错").to_string();
    assert!(message.contains("sha256"), "错误应点名 sha256 校验: {message}");
    assert!(!tools.join("mozjpeg").join("test").join("cjpeg").exists(), "校验失败不得安装");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(&tools).ok();
}

#[test]
fn install_encoder_reports_missing_member() {
    let archive = tar_gz("other/file.txt", b"not the encoder");
    let sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&archive))
    };
    let (base, _hits) = serve_bytes(Box::leak(archive.into_boxed_slice()));
    let source = source_for(format!("{base}/mozjpeg-test.tar.gz"), sha, "cjpeg");

    let tools = std::env::temp_dir().join(format!("pixel-arena-tools-nomember-{}", std::process::id()));
    let message = install_encoder(&source, &tools).err().expect("缺成员应报错").to_string();
    assert!(message.contains("cjpeg"), "错误应点名缺的成员: {message}");
    std::fs::remove_dir_all(&tools).ok();
}

// ---------- 真实 MozJPEG 端到端（本机手动触发，CI 离线自动跳过） ----------

#[test]
fn real_mozjpeg_end_to_end_when_provided() {
    let Ok(encoder) = std::env::var("PIXEL_ARENA_CJPEG_PATH") else {
        eprintln!("跳过：未设置 PIXEL_ARENA_CJPEG_PATH（真实 MozJPEG 端到端在本机执行）");
        return;
    };
    let out_dir = std::env::temp_dir().join(format!("pixel-arena-real-{}", std::process::id()));
    let out = encode_jpeg_using(&encoder, data("photo-ref.png"), 75, &out_dir).expect("真实编码应成功");

    // 产物能被自家解码链路读回，尺寸一致，指标落在 q75 合理区间
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), &out).expect("产物应可解码跑分");
    assert_eq!(metrics.ssim, metrics.ssim, "SSIM 不应为 NaN");
    assert!(metrics.ssim > 0.5, "q75 的 SSIM 应在中段以上: {}", metrics.ssim);
    assert!(metrics.psnr > 25.0, "q75 的 PSNR 应在合理区间: {}", metrics.psnr);
    // 压缩效率：JPEG 产物应明显小于未压缩 PNG
    let product_size = std::fs::metadata(&out).unwrap().len();
    let reference_size = std::fs::metadata(data("photo-ref.png")).unwrap().len();
    assert!(product_size < reference_size / 2, "q75 产物应不到原图一半: {product_size} vs {reference_size}");

    std::fs::remove_dir_all(&out_dir).ok();
}
