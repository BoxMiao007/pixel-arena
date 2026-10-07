// 一站式编码阶梯补全（T11）的黑盒测试：只走公共 API，断言「给定输入文件，产生什么文件/错误」。
//
// 与 encode_jpeg.rs（T10）同一桩策略：外部编码器以桩脚本代替（离线可跑、CI 稳定），
// 真实编码器的端到端验证由 PIXEL_ARENA_CWEBP_PATH / PIXEL_ARENA_AVIFENC_PATH /
// PIXEL_ARENA_CJXL_PATH / PIXEL_ARENA_AVIFDEC 门控的本机测试承担。
// AVIF/JXL 产物的解码分派用入库样例（tests/data/photo-ref-lossless.jxl 与
// photo-ref-q85.avif）驱动：JXL 走进程内 jxl-oxide 无需外部工具，AVIF 需 avifdec 故门控。

use pixel_arena_core::encode::{
    encode_avif_using, encode_jxl_using, encode_onestop, encode_webp_using, EncoderOverrides,
};

fn data(name: &str) -> String {
    format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// 无损产物的五指标锚点：解码像素与原图逐位一致（PSNR=∞、SSIM/MS-SSIM=1、
/// Butteraugli=0、SSIMULACRA2=100，见 T04 笔记「可放心当锚点断言」）。
fn assert_lossless_anchors(
    metrics: pixel_arena_core::ImageMetrics,
) {
    assert_eq!(metrics.psnr, f64::INFINITY, "无损产物 PSNR 应为 ∞");
    assert_eq!(metrics.ssim, 1.0, "无损产物 SSIM 应为 1");
    assert_eq!(metrics.ms_ssim, 1.0, "无损产物 MS-SSIM 应为 1");
    assert_eq!(metrics.butteraugli, 0.0, "无损产物 Butteraugli 应为 0");
    assert_eq!(metrics.ssimulacra2, 100.0, "无损产物 SSIMULACRA2 应为 100");
}

// ---------- 一站式入口：格式分派 ----------

#[test]
fn unknown_format_reports_chinese_error() {
    let message = encode_onestop(
        data("photo-ref.png"),
        "gif",
        Some(75),
        std::env::temp_dir(),
        std::env::temp_dir(),
        &EncoderOverrides::default(),
        pixel_arena_core::naming::ConflictPolicy::AutoAppend,
    )
    .err()
    .expect("未知格式应报错")
    .to_string();
    assert!(message.contains("不支持的编码格式"), "错误应点名格式: {message}");
    assert!(message.contains("gif"), "错误应包含传入的格式名: {message}");
}

#[test]
fn png_product_roundtrips_losslessly_without_external_encoder() {
    // PNG 无损对照组：进程内 image crate 编码，不依赖任何外部二进制（tools_dir 随便填）
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-png-{}", std::process::id()));
    let out_dir = dir.join("out");
    let product = encode_onestop(
            data("photo-ref.png"),
            "png",
            None,
            &out_dir,
            &dir,
            &EncoderOverrides::default(),
            pixel_arena_core::naming::ConflictPolicy::AutoAppend,
        )
        .expect("PNG 产物应生成成功");
    assert!(
        product.to_string_lossy().ends_with("photo-ref_png.png"),
        "产物名规则 <原图名>_png.png: {product:?}"
    );
    assert_lossless_anchors(
        pixel_arena_core::score_images(data("photo-ref.png"), &product).expect("产物应可解码跑分"),
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn png_product_rejects_quality_fail_fast() {
    let message = encode_onestop(
        data("photo-ref.png"),
        "png",
        Some(75),
        std::env::temp_dir(),
        std::env::temp_dir(),
        &EncoderOverrides::default(),
        pixel_arena_core::naming::ConflictPolicy::AutoAppend,
    )
    .err()
    .expect("PNG 不接受质量参数")
    .to_string();
    assert!(message.contains("质量"), "错误应说明质量参数多余: {message}");
}

#[test]
fn lossless_group_rejects_quality_fail_fast() {
    // 无损组（无损 WebP / 无损 JXL）不接受质量参数：像素必须逐位一致，质量无意义
    for format in ["webp-lossless", "jxl-lossless"] {
        let message = encode_onestop(
            data("photo-ref.png"),
            format,
            Some(75),
            std::env::temp_dir(),
            std::env::temp_dir(),
            &EncoderOverrides::default(),
            pixel_arena_core::naming::ConflictPolicy::AutoAppend,
        )
        .err()
        .expect("无损格式不应接受质量参数")
        .to_string();
        assert!(message.contains("质量"), "{format}: 错误应说明质量参数多余: {message}");
    }
}

#[test]
fn lossy_quality_out_of_range_fails_fast() {
    // 质量越界在启动任何编码器之前就该报错（编码器路径故意填不存在的文件）
    for format in ["jpeg", "webp", "avif", "jxl"] {
        for bad in [0u8, 101u8] {
            let message = encode_onestop(
                data("photo-ref.png"),
                format,
                Some(bad),
                std::env::temp_dir(),
                std::env::temp_dir(),
                &EncoderOverrides::default(),
                pixel_arena_core::naming::ConflictPolicy::AutoAppend,
            )
            .err()
            .expect("越界质量应报错")
            .to_string();
            assert!(message.contains("质量"), "{format}: 错误应说明质量无效: {message}");
        }
    }
}

// ---------- 桩编码器：各格式 CLI 契约 ----------

/// 给桩脚本加可执行权限。
#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn encode_webp_using_pipes_ppm_and_writes_product() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-webp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 桩约定（cwebp 契约）：-quiet -q <质量> <输入> -o <产物>；输入 PPM 拷出供断言。
    let encoder = dir.join("fake-cwebp.sh");
    std::fs::write(
        &encoder,
        "#!/bin/sh\n[ \"$1\" = -quiet ] && [ \"$2\" = -q ] || exit 9\ncp \"$4\" \"$0.ppm-copy\"\nprintf 'FAKEWEBP' > \"$6\"\nexit 0\n",
    )
    .unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let out = encode_webp_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("编码应成功");
    assert!(
        out.to_string_lossy().ends_with("photo-ref_webp_q75.webp"),
        "产物名应含原图名与质量档: {out:?}"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"FAKEWEBP");

    // 喂给编码器的必须是 P6 PPM 且像素与原图解码一致
    let ppm = std::fs::read(dir.join("fake-cwebp.sh.ppm-copy")).unwrap();
    assert!(ppm.starts_with(b"P6\n256 256\n255\n"), "PPM 头应为 P6/256x256/255");
    assert_eq!(ppm.len() - 15, 256 * 256 * 3, "像素数据应为 8-bit RGB 三通道");

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_webp_lossless_uses_lossless_flag() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-webpll-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 桩约定：无损调用为 -quiet -lossless <输入> -o <产物>；记录完整参数供断言。
    let encoder = dir.join("fake-cwebp-ll.sh");
    std::fs::write(
        &encoder,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nprintf 'FAKEWEBP' > \"$5\"\nexit 0\n",
    )
    .unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let out = encode_webp_using(&encoder, data("photo-ref.png"), None, &out_dir)
        .expect("无损编码应成功");
    assert!(
        out.to_string_lossy().ends_with("photo-ref_webp_lossless.webp"),
        "无损 WebP 产物名规则: {out:?}"
    );
    let args = std::fs::read_to_string(dir.join("fake-cwebp-ll.sh.args")).unwrap();
    assert!(args.contains("-lossless"), "无损 WebP 必须带 -lossless: {args}");

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_avif_using_pipes_png_and_writes_product() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-avif-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 桩约定（avifenc 契约）：-q <质量> <输入 PNG> <产物>；输入拷出供断言（必须真 PNG）。
    let encoder = dir.join("fake-avifenc.sh");
    std::fs::write(
        &encoder,
        "#!/bin/sh\n[ \"$1\" = -q ] || exit 9\ncp \"$3\" \"$0.png-copy\"\nprintf 'FAKEAVIF' > \"$4\"\nexit 0\n",
    )
    .unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let out = encode_avif_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("编码应成功");
    assert!(
        out.to_string_lossy().ends_with("photo-ref_avif_q75.avif"),
        "产物名应含原图名与质量档: {out:?}"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"FAKEAVIF");

    // avifenc 只吃 PNG：喂进去的临时文件必须是真 PNG（魔数 + image crate 可解码）
    let png = std::fs::read(dir.join("fake-avifenc.sh.png-copy")).unwrap();
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "avifenc 输入应为 PNG: {:02x?}", &png[..8]);
    let img = image::ImageReader::new(std::io::Cursor::new(png))
        .with_guessed_format()
        .unwrap()
        .decode()
        .expect("喂给 avifenc 的 PNG 应可解码");
    assert_eq!((img.width(), img.height()), (256, 256));

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_jxl_using_pipes_ppm_and_writes_product() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-jxl-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 桩约定（cjxl 契约）：--quiet <输入> <产物> -q <质量>。
    let encoder = dir.join("fake-cjxl.sh");
    std::fs::write(
        &encoder,
        "#!/bin/sh\n[ \"$1\" = --quiet ] && [ \"$4\" = -q ] || exit 9\ncp \"$2\" \"$0.ppm-copy\"\nprintf 'FAKEJXL' > \"$3\"\nexit 0\n",
    )
    .unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let out = encode_jxl_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("编码应成功");
    assert!(
        out.to_string_lossy().ends_with("photo-ref_jpegxl_q75.jxl"),
        "产物名应含原图名与质量档: {out:?}"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"FAKEJXL");
    let ppm = std::fs::read(dir.join("fake-cjxl.sh.ppm-copy")).unwrap();
    assert!(ppm.starts_with(b"P6\n256 256\n255\n"), "cjxl 输入应为 P6 PPM");

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_jxl_lossless_uses_q100() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-jxlll-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // 桩约定：无损调用为 --quiet <输入> <产物> -q 100。
    let encoder = dir.join("fake-cjxl-ll.sh");
    std::fs::write(
        &encoder,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nprintf 'FAKEJXL' > \"$3\"\nexit 0\n",
    )
    .unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let out = encode_jxl_using(&encoder, data("photo-ref.png"), None, &out_dir)
        .expect("无损编码应成功");
    assert!(
        out.to_string_lossy().ends_with("photo-ref_jpegxl_lossless.jxl"),
        "无损 JXL 产物名规则: {out:?}"
    );
    let args = std::fs::read_to_string(dir.join("fake-cjxl-ll.sh.args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert!(
        args.windows(2).any(|w| w == ["-q", "100"]),
        "无损 JXL 必须用 -q 100: {args:?}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn view_proxy_for_jxl_product_is_lossless() {
    // 查看器代片：JXL 产物（WebView 解不了）旁路一份 PNG。JXL 解码走进程内 jxl-oxide，
    // 用入库的无损样例扮演产物即可离线全链路验证：代片应存在且与原图逐位一致。
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-proxy-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let product = dir.join("photo-ref-q75.jxl");
    std::fs::copy(data("photo-ref-lossless.jxl"), &product).unwrap();

    let proxy = pixel_arena_core::encode::write_view_proxy(&product).expect("代片应生成成功");
    assert_eq!(proxy, dir.join("photo-ref-q75.jxl.png"), "代片名规则 <产物>.png");
    assert_lossless_anchors(
        pixel_arena_core::score_images(data("photo-ref.png"), &proxy).expect("代片应可解码跑分"),
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn encode_failure_surfaces_exit_code_and_stderr() {
    let dir = std::env::temp_dir().join(format!("pixel-arena-t11-fail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let encoder = dir.join("fake-cwebp.sh");
    std::fs::write(&encoder, "#!/bin/sh\necho '编码器炸了' >&2\nexit 3\n").unwrap();
    make_executable(&encoder);

    let out_dir = dir.join("out");
    let message = encode_webp_using(&encoder, data("photo-ref.png"), Some(60), &out_dir)
        .err()
        .expect("非零退出应报错")
        .to_string();
    assert!(message.contains("编码器炸了"), "stderr 应透传: {message}");
    assert!(!out_dir.join("photo-ref_webp_q60.webp").exists(), "失败不得留下产物文件");
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- 编码器安装（运行期下载）已移除（T32，决策 0025） ----------
// 原多成员工件（libavif = avifenc + avifdec）下载/解包测试随机制删除；avifdec 的
// 定位改经 PIXEL_ARENA_AVIFDEC 环境变量注入（decode.rs），缺成员报错由 ffmpeg
// 应用内安装共用 extract_archive_members 的测试覆盖。

// ---------- 解码分派（产物要能被 score_images 跑分） ----------

#[test]
fn lossless_jxl_product_decodes_to_anchor_metrics() {
    // 入库的无损 JXL 样例：解码分派走 jxl-oxide（进程内，无需外部工具），
    // 解码像素应与原图逐位一致 → 全锚点。这是 AVIF/JXL 解码分派的行为锚。
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), data("photo-ref-lossless.jxl"))
        .expect("无损 JXL 应可解码跑分");
    assert_lossless_anchors(metrics);
}

#[test]
fn real_avif_product_decodes_when_avifdec_provided() {
    let Ok(decoder) = std::env::var("PIXEL_ARENA_AVIFDEC") else {
        eprintln!("跳过：未设置 PIXEL_ARENA_AVIFDEC（真实 avifdec 解码在本机执行）");
        return;
    };
    let _ = decoder; // 解码器路径由 decode_srgb 经同名环境变量读取
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), data("photo-ref-q85.avif"))
        .expect("AVIF 产物应可解码跑分");
    assert!(metrics.psnr > 30.0, "q85 AVIF 的 PSNR 应在合理区间: {}", metrics.psnr);
    assert!(metrics.ssim > 0.85, "q85 AVIF 的 SSIM 应在合理区间: {}", metrics.ssim);
}

// ---------- 真实编码器端到端（本机手动触发，CI 离线自动跳过） ----------

#[test]
fn real_webp_end_to_end_when_provided() {
    let Ok(encoder) = std::env::var("PIXEL_ARENA_CWEBP_PATH") else {
        eprintln!("跳过：未设置 PIXEL_ARENA_CWEBP_PATH");
        return;
    };
    let out_dir = std::env::temp_dir().join(format!("pixel-arena-t11-real-webp-{}", std::process::id()));
    let out = encode_webp_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("真实编码应成功");
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), &out).expect("产物应可解码跑分");
    assert!(metrics.psnr > 25.0, "q75 的 PSNR 应在合理区间: {}", metrics.psnr);
    let product_size = std::fs::metadata(&out).unwrap().len();
    assert!(product_size < std::fs::metadata(data("photo-ref.png")).unwrap().len() / 2);
    std::fs::remove_dir_all(&out_dir).ok();
}

#[test]
fn real_avif_end_to_end_when_provided() {
    let Ok(encoder) = std::env::var("PIXEL_ARENA_AVIFENC_PATH") else {
        eprintln!("跳过：未设置 PIXEL_ARENA_AVIFENC_PATH");
        return;
    };
    let out_dir = std::env::temp_dir().join(format!("pixel-arena-t11-real-avif-{}", std::process::id()));
    let out = encode_avif_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("真实编码应成功");
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), &out).expect("产物应可解码跑分");
    assert!(metrics.psnr > 25.0, "q75 的 PSNR 应在合理区间: {}", metrics.psnr);
    std::fs::remove_dir_all(&out_dir).ok();
}

#[test]
fn real_jxl_end_to_end_when_provided() {
    let Ok(encoder) = std::env::var("PIXEL_ARENA_CJXL_PATH") else {
        eprintln!("跳过：未设置 PIXEL_ARENA_CJXL_PATH");
        return;
    };
    let out_dir = std::env::temp_dir().join(format!("pixel-arena-t11-real-jxl-{}", std::process::id()));
    let out = encode_jxl_using(&encoder, data("photo-ref.png"), Some(75), &out_dir)
        .expect("真实编码应成功");
    let metrics = pixel_arena_core::score_images(data("photo-ref.png"), &out).expect("产物应可解码跑分");
    assert!(metrics.psnr > 25.0, "q75 的 PSNR 应在合理区间: {}", metrics.psnr);
    std::fs::remove_dir_all(&out_dir).ok();
}

// ---------- 大小优先的探测缝（T21）：probe_onestop_size ----------

/// 预置桩 cwebp：复用检查只看「成员文件存在 + sidecar 哈希吻合」，桩被调用时把
/// 入库的真实 WebP 样例拷成产物（与 CLI run 测试同一桩策略，离线确定性）。
fn preseed_stub_cwebp(tools: &std::path::Path, fixture_webp: &str) {
    use sha2::{Digest, Sha256};
    let dir = tools.join("libwebp").join("1.6.0");
    std::fs::create_dir_all(&dir).unwrap();
    let encoder = dir.join("cwebp");
    // 参数契约（encode_webp_using）：$1=-quiet $2=-q $3=质量 $4=输入 $5=-o $6=产物临时文件
    std::fs::write(&encoder, format!("#!/bin/sh\ncp '{fixture_webp}' \"$6\"\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&encoder, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let digest = format!("{:x}", Sha256::digest(std::fs::read(&encoder).unwrap()));
    std::fs::write(dir.join("cwebp.sha256"), digest).unwrap();
}

#[test]
fn probe_onestop_size_返回产物字节数_复用已装编码器() {
    let fixture = data("photo-dis.webp");
    let tools = tempfile::tempdir().unwrap();
    preseed_stub_cwebp(tools.path(), &fixture);
    let scratch = tempfile::tempdir().unwrap();

    let bytes = pixel_arena_core::encode::probe_onestop_size(
        data("photo-ref.png"),
        pixel_arena_core::encode::OnestopFormat::Webp,
        75,
        scratch.path(),
        tools.path(),
        &Default::default(),
    )
    .expect("探测应成功");

    let fixture_bytes = std::fs::metadata(&fixture).unwrap().len();
    assert_eq!(bytes, fixture_bytes, "探测应回传桩产物（入库样例）的字节数");
}

#[test]
fn probe_onestop_size_无损格式不参与搜索_中文报错() {
    let scratch = tempfile::tempdir().unwrap();
    let message = pixel_arena_core::encode::probe_onestop_size(
        data("photo-ref.png"),
        pixel_arena_core::encode::OnestopFormat::Png,
        75,
        scratch.path(),
        scratch.path(),
        &Default::default(),
    )
    .err()
    .expect("无损格式应拒绝探测")
    .to_string();
    assert!(message.contains("无损"), "错误应说明无损格式不参与：{message}");
}
