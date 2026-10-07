// 产物命名与输出目录（T29-1）的黑盒测试：只走公共 API。
//
// 命名格式（需求 9，决策 D6–D9）：{原图名}_{编码器小写}_q<值>|lossless[_{(自定义参数)}].{扩展名}
// 需求 9 示例名、需求 10 边界（特殊字符/超长/参数值含空格/冲突）都在这里钉死。

use pixel_arena_core::encode::OnestopFormat;
use pixel_arena_core::naming::{
    product_file_name, product_output_dir, unique_file_name, PRODUCT_DIR_NAME, QualitySegment,
};
use std::path::Path;

/// 纯函数便捷封装：命名失败直接 panic（失败场景单独成测）。
fn name(stem: &str, encoder: &str, quality: QualitySegment, params: &[&str], ext: &str) -> String {
    product_file_name(stem, encoder, quality, params, ext).expect("命名应成功")
}

// ---------- 基础格式：质量段（决策 D7/D8） ----------

#[test]
fn requirement_9_example_name_is_pinned() {
    // 需求 9 的示例：自定义参数段放括号里，参数词用空格连接
    assert_eq!(
        name(
            "image123",
            "avif",
            QualitySegment::Lossy(60),
            &["-y", "420", "--sharpyuv", "-s", "4"],
            "avif",
        ),
        "image123_avif_q60_(-y 420 --sharpyuv -s 4).avif"
    );
}

#[test]
fn lossy_without_params_uses_q_segment() {
    assert_eq!(name("photo", "webp", QualitySegment::Lossy(75), &[], "webp"), "photo_webp_q75.webp");
    assert_eq!(name("photo", "jpeg", QualitySegment::Lossy(60), &[], "jpg"), "photo_jpeg_q60.jpg");
}

#[test]
fn lossless_uses_lossless_segment_for_all_lossy_capable_encoders() {
    assert_eq!(name("photo", "webp", QualitySegment::Lossless, &[], "webp"), "photo_webp_lossless.webp");
    assert_eq!(name("photo", "avif", QualitySegment::Lossless, &[], "avif"), "photo_avif_lossless.avif");
    assert_eq!(name("photo", "jpegxl", QualitySegment::Lossless, &[], "jxl"), "photo_jpegxl_lossless.jxl");
}

#[test]
fn png_has_no_quality_segment() {
    assert_eq!(name("photo", "png", QualitySegment::None, &[], "png"), "photo_png.png");
}

// ---------- 编码器短名映射（无空格：jpegxl 而非 jpeg xl） ----------

#[test]
fn encoder_short_names_and_extensions_are_lowercase_without_spaces() {
    let cases = [
        ("jpeg", "jpeg", "jpg"),
        ("webp", "webp", "webp"),
        ("avif", "avif", "avif"),
        ("jxl", "jpegxl", "jxl"),
        ("png", "png", "png"),
        ("webp-lossless", "webp", "webp"),
        ("jxl-lossless", "jpegxl", "jxl"),
    ];
    for (raw, encoder, ext) in cases {
        let format = OnestopFormat::parse(raw).expect("格式应可解析");
        assert_eq!(format.encoder_short_name(), encoder, "{raw} 的编码器短名");
        assert!(!format.encoder_short_name().contains(' '), "{raw} 短名不应含空格");
        assert_eq!(format.extension(), ext, "{raw} 的扩展名");
    }
}

// ---------- 自定义参数段：POSIX shell 单词引用 ----------

#[test]
fn param_value_with_space_is_quoted_in_name() {
    assert_eq!(
        name("photo", "avif", QualitySegment::Lossy(60), &["--title", "my photo"], "avif"),
        "photo_avif_q60_(--title 'my photo').avif"
    );
}

#[cfg(unix)]
#[test]
fn param_segment_copied_out_of_name_runs_in_shell_verbatim() {
    // 「复制后可直接执行」：把产物名括号里的参数段拼给 sh -c，解析出的单词必须
    // 与原始参数逐一相等（无引号词与空格值两种代表场景）
    let cases: [&[&str]; 2] = [
        &["-y", "420", "--sharpyuv", "-s", "4"],
        &["--title", "my photo"],
    ];
    for words in cases {
        let file_name = name("photo", "avif", QualitySegment::Lossy(60), words, "avif");
        let start = file_name.find('(').expect("应有参数段") + 1;
        let end = file_name.rfind(')').expect("参数段应闭合");
        let segment = &file_name[start..end];
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s\\n' {segment}"))
            .output()
            .expect("sh 应可执行");
        assert!(output.status.success());
        let parsed: Vec<&str> = std::str::from_utf8(&output.stdout)
            .expect("stdout 应是 UTF-8")
            .lines()
            .collect();
        assert_eq!(parsed, words, "参数段经 shell 解析应还原原始单词：{segment}");
    }
}

#[test]
fn param_value_with_filename_forbidden_char_is_minimally_replaced() {
    // 已知取舍：POSIX 引号字符里只有 `'` 是 Windows 文件名合法字符，参数值本身
    // 含 `'`/`"` 时为保「文件名永远合法」做最小替换，该字符处不再保持 shell 还原
    assert_eq!(
        name("photo", "avif", QualitySegment::Lossy(60), &["--comment", "it's fine"], "avif"),
        "photo_avif_q60_(--comment 'it'_''s fine').avif"
    );
}

// ---------- 同名冲突（决策 D9：自动 _1/_2，不覆盖，大小写不敏感） ----------

#[test]
fn free_name_is_returned_as_is() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        unique_file_name(dir.path(), "photo_webp_q60.webp").expect("无冲突应原样返回"),
        "photo_webp_q60.webp"
    );
}

#[test]
fn conflict_appends_counter_instead_of_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("photo_webp_q60.webp"), b"x").unwrap();
    assert_eq!(
        unique_file_name(dir.path(), "photo_webp_q60.webp").expect("应追加 _1"),
        "photo_webp_q60_1.webp"
    );
    std::fs::write(dir.path().join("photo_webp_q60_1.webp"), b"x").unwrap();
    assert_eq!(
        unique_file_name(dir.path(), "photo_webp_q60.webp").expect("应追加 _2"),
        "photo_webp_q60_2.webp"
    );
}

#[test]
fn conflict_check_is_case_insensitive() {
    // Windows/macOS 文件系统大小写不敏感：三端统一按不敏感去重
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("PHOTO_WEBP_Q60.WEBP"), b"x").unwrap();
    assert_eq!(
        unique_file_name(dir.path(), "photo_webp_q60.webp").expect("大小写不同也算冲突"),
        "photo_webp_q60_1.webp"
    );
}

#[test]
fn missing_directory_counts_as_no_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("不存在");
    assert_eq!(
        unique_file_name(&absent, "photo_png.png").expect("目录不存在应视为无冲突"),
        "photo_png.png"
    );
}

// ---------- 特殊字符（最小替换）与保留设备名 ----------

#[test]
fn forbidden_chars_are_replaced_one_for_one() {
    // Windows 禁字符 < > : " / \ | ? * 逐字符替换为 _（最小替换，不做多余清洗）
    assert_eq!(
        name("a<b>c:\"d/e\\f|g?h*i", "webp", QualitySegment::Lossy(60), &[], "webp"),
        "a_b_c__d_e_f_g_h_i_webp_q60.webp"
    );
}

#[test]
fn control_chars_are_replaced_and_trailing_space_dot_stripped() {
    assert_eq!(name("a\u{1}b", "webp", QualitySegment::Lossy(60), &[], "webp"), "a_b_webp_q60.webp");
    assert_eq!(name("name. ", "webp", QualitySegment::Lossy(60), &[], "webp"), "name_webp_q60.webp");
}

#[test]
fn windows_reserved_device_names_get_underscore_prefix() {
    assert_eq!(name("CON", "webp", QualitySegment::Lossy(60), &[], "webp"), "_CON_webp_q60.webp");
    assert_eq!(name("com1", "png", QualitySegment::None, &[], "png"), "_com1_png.png");
}

// ---------- 超长名称：先截 stem 再拼后缀（保留编码器+质量+扩展名） ----------

#[test]
fn overlong_stem_is_truncated_at_char_boundary_keeping_suffix() {
    // 200 个「长」（600 字节）远超预算；后缀 _webp_q60.webp 占 14 字节，
    // stem 预算 241 字节 → 按 char 边界截到 80 个三字节字符（240 字节）
    let product = name(&"长".repeat(200), "webp", QualitySegment::Lossy(60), &[], "webp");
    assert!(product.len() <= 255, "全名不得超过 255 字节：{} 字节", product.len());
    assert_eq!(product, format!("{}{}", "长".repeat(80), "_webp_q60.webp"));
    assert!(product.ends_with("_webp_q60.webp"), "编码器小写+质量+扩展名必须保留");
}

// ---------- 输出目录（决策 D5） ----------

#[test]
fn product_dir_is_pixel_arena_next_to_source() {
    let dir = product_output_dir(Path::new("/photos/raw/img.png")).expect("应取到原图目录");
    assert_eq!(dir, Path::new("/photos/raw").join(PRODUCT_DIR_NAME));
    assert_eq!(PRODUCT_DIR_NAME, "Pixel Arena");
}

#[test]
fn product_dir_without_parent_reports_chinese_error() {
    let message = product_output_dir(Path::new("img.png"))
        .err()
        .expect("无目录部分的路径应报错")
        .to_string();
    assert!(message.contains("无法确定原图所在目录"), "错误应可定位：{message}");
}

#[test]
fn output_dir_writability_is_probed_with_chinese_error() {
    // 已存在直接复用、不存在则创建：探针即写即删
    let dir = tempfile::tempdir().unwrap();
    let arena = dir.path().join("Pixel Arena");
    pixel_arena_core::naming::ensure_output_dir_writable(&arena).expect("可写目录应通过");
    assert!(arena.is_dir(), "目录不存在时应被创建");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let readonly = dir.path().join("只读");
        std::fs::create_dir_all(&readonly).unwrap();
        std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o555)).unwrap();
        // root 对只读目录照样可写（CI/容器场景）：探针真写进去就跳过断言
        let probe = readonly.join(".pixel-arena-写测试");
        if std::fs::write(&probe, b"").is_ok() {
            std::fs::remove_file(&probe).ok();
            eprintln!("跳过：当前用户对只读目录仍可写（root），无法模拟不可写");
        } else {
            let message = pixel_arena_core::naming::ensure_output_dir_writable(&readonly)
                .err()
                .expect("只读目录应报不可写")
                .to_string();
            assert!(message.contains("不可写"), "错误应点名不可写：{message}");
            assert!(message.contains("中止") && message.contains("更换"), "错误应给出中止/更换出路：{message}");
        }
        std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
