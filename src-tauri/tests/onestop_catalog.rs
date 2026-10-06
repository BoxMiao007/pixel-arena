// 一站式勾选目录（T21 单源化）的端到端测试：不经 Tauri 运行时，直接调
// pixel_arena_lib::onestop_default_catalog（与 IPC 命令同一实现体）。
// 钉住 GUI 勾选区清单与默认档位：与核心库质量优先取点一致（基准 75 = 现行默认
// 60/75/90），即「数据源切到核心库、界面行为不变」的外部行为锚点。

use pixel_arena_lib::onestop_default_catalog;

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
