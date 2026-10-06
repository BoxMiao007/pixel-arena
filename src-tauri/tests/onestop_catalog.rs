// 一站式勾选目录（T21 单源化）的端到端测试：不经 Tauri 运行时，直接调
// pixel_arena_lib::onestop_default_catalog（与 IPC 命令同一实现体）。
// 钉住 GUI 勾选区清单与默认档位：与核心库质量优先取点一致（基准 75 = 现行默认
// 60/75/90），即「数据源切到核心库、界面行为不变」的外部行为锚点。

use pixel_arena_lib::{onestop_default_catalog, onestop_quality_ladder_impl, onestop_size_search_impl};

#[test]
fn onestop_catalog_基准75_清单与默认档位与现行默认阶梯一致() {
    let catalog = onestop_default_catalog();

    let lossy: Vec<(&str, &str)> = catalog
        .lossy_formats
        .iter()
        .map(|entry| (entry.format.as_str(), entry.label.as_str()))
        .collect();
    assert_eq!(
        lossy,
        [("jpeg", "JPEG"), ("webp", "WebP"), ("avif", "AVIF"), ("jxl", "JPEG XL")],
        "有损格式清单（顺序与显示名）应与现行勾选区一致"
    );

    assert_eq!(
        catalog.qualities,
        vec![60, 75, 90],
        "默认质量档应与现行默认阶梯（基准 75 取点）一致"
    );

    let lossless: Vec<(&str, &str)> = catalog
        .lossless_formats
        .iter()
        .map(|entry| (entry.format.as_str(), entry.label.as_str()))
        .collect();
    assert_eq!(
        lossless,
        [
            ("png", "PNG"),
            ("webp-lossless", "无损 WebP"),
            ("jxl-lossless", "无损 JXL"),
        ],
        "无损对照组清单应与现行勾选区一致"
    );
}

// ---------- T22：质量优先取点（onestop_quality_ladder_impl） ----------

#[test]
fn onestop_quality_ladder_基准75_与现行默认阶梯完全一致() {
    let ladder = onestop_quality_ladder_impl(75).expect("基准 75 合法");
    let actual: Vec<(&str, Option<u8>)> = ladder
        .iter()
        .map(|item| (item.format.as_str(), item.quality))
        .collect();
    assert_eq!(
        actual,
        vec![
            ("jpeg", Some(60)),
            ("jpeg", Some(75)),
            ("jpeg", Some(90)),
            ("webp", Some(60)),
            ("webp", Some(75)),
            ("webp", Some(90)),
            ("avif", Some(60)),
            ("avif", Some(75)),
            ("avif", Some(90)),
            ("jxl", Some(60)),
            ("jxl", Some(75)),
            ("jxl", Some(90)),
            ("png", None),
            ("webp-lossless", None),
            ("jxl-lossless", None),
        ],
        "质量优先阶梯 = 有损 4 格式 × 3 点 + 无损对照组（核心库单一实现）"
    );
    assert_eq!(ladder[0].label, "JPEG q60");
    assert_eq!(ladder[11].label, "JPEG XL q90");
    assert_eq!(ladder[13].label, "无损 WebP");
}

#[test]
fn onestop_quality_ladder_任意基准_每有损格式至少3点且无损组固定在列() {
    for baseline in [0u8, 1, 40, 99, 100] {
        let ladder = onestop_quality_ladder_impl(baseline).expect("基准合法");
        for format in ["jpeg", "webp", "avif", "jxl"] {
            let count = ladder
                .iter()
                .filter(|item| item.format == format)
                .count();
            assert!(count >= 3, "基准 {baseline} 的 {format} 应至少 3 点，实际 {count}");
        }
        let lossless: Vec<&str> = ladder
            .iter()
            .filter(|item| item.quality.is_none())
            .map(|item| item.format.as_str())
            .collect();
        assert_eq!(lossless, ["png", "webp-lossless", "jxl-lossless"]);
    }
}

#[test]
fn onestop_quality_ladder_基准越界_中文报错() {
    let message = onestop_quality_ladder_impl(101).unwrap_err();
    assert!(message.contains("基准质量 101 无效"), "错误应点名基准值：{message}");
}

// ---------- T22：大小优先（onestop_size_search_impl） ----------

#[test]
fn onestop_size_search_无损格式_中文报错不探测() {
    // 无损对照组不参与大小搜索：应在任何探测编码之前 fail-fast
    let message = onestop_size_search_impl(
        "/tmp/不存在.png",
        "png",
        1024,
        std::path::Path::new("/tmp"),
        &Default::default(),
    )
        .unwrap_err();
    assert!(message.contains("无损格式"), "错误应说明无损不参与搜索：{message}");
    assert!(message.contains("不参与目标大小搜索"), "{message}");
}

#[test]
fn onestop_size_search_未知格式_中文报错() {
    let message = onestop_size_search_impl(
        "/tmp/不存在.png",
        "bogus",
        1024,
        std::path::Path::new("/tmp"),
        &Default::default(),
    )
        .unwrap_err();
    assert!(message.contains("不支持的编码格式"), "{message}");
}
