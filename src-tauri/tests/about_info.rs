// 「关于」区块（T29-2 设置页扩展）的端到端测试：不经 Tauri 运行时，直接调
// pixel_arena_lib::about_info_impl（与 IPC 命令同一实现体）。
// 钉住票面要求：项目信息齐全 + 引用的库版本清单「读锁定清单不硬编码」
//（决策 D18：版本与 EncoderSource.version / ffmpeg 版本常量同源）。

use pixel_arena_lib::about_info_impl;

#[test]
fn about_info_项目信息齐全且面向用户() {
    let info = about_info_impl();
    assert_eq!(info.app_name, "Pixel Arena");
    assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"), "应用版本应取自 crate 元数据");
    assert_eq!(info.core_version, pixel_arena_core::version().to_string());
    assert!(!info.intro.is_empty(), "简介不能为空");
    assert_eq!(info.license, "MIT", "与 LICENSE 文件一致");
    assert_eq!(info.repo_url, "https://github.com/BoxMiao007/pixel-arena");
}

#[test]
fn about_info_库清单覆盖四个编码器与_ffmpeg_版本读锁定清单() {
    let info = about_info_impl();
    let expected: Vec<(&str, String)> = vec![
        ("MozJPEG", pixel_arena_core::encode::mozjpeg_source().unwrap().version),
        ("libwebp", pixel_arena_core::encode::webp_source().unwrap().version),
        ("libavif", pixel_arena_core::encode::avif_source().unwrap().version),
        ("libjxl", pixel_arena_core::encode::jxl_source().unwrap().version),
        ("FFmpeg", pixel_arena_lib::pinned_ffmpeg_version().to_string()),
    ];
    let actual: Vec<(&str, &str)> = info
        .libraries
        .iter()
        .map(|lib| (lib.name.as_str(), lib.version.as_str()))
        .collect();
    let expected_refs: Vec<(&str, &str)> = expected
        .iter()
        .map(|(name, version)| (*name, version.as_str()))
        .collect();
    assert_eq!(actual, expected_refs, "库清单（名称+版本、顺序）应与锁定清单一致");
}

#[test]
fn about_info_库名链接都是可跳转的主页地址() {
    let info = about_info_impl();
    assert!(!info.libraries.is_empty());
    for lib in &info.libraries {
        assert!(
            lib.url.starts_with("https://"),
            "「{}」的主页链接必须是 https：{}",
            lib.name,
            lib.url
        );
    }
}
