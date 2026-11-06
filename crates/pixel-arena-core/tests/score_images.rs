// 主测试缝：核心库公共 API（规格 Issue #1 Testing Decisions）。
// 只测外部行为：给定输入文件，断言指标或错误提示，不碰内部实现。

use std::path::Path;

/// 造一张 64x64 的灰渐变 PNG，作为最小可解码样例。
fn write_gradient_png(path: &Path) {
    let mut img = image::RgbImage::new(64, 64);
    for (x, y, pixel) in img.enumerate_pixels_mut() {
        let value = ((x + y) % 256) as u8;
        *pixel = image::Rgb([value, value, value]);
    }
    img.save(path).expect("测试样例 PNG 应能写入");
}

#[test]
fn 同一张图跑分_psnr为无穷_ssim为1() {
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let image_path = dir.path().join("原图.png");
    write_gradient_png(&image_path);

    let score =
        pixel_arena_core::score_images(&image_path, &image_path).expect("同一张图跑分不应报错");

    assert!(
        score.psnr.is_infinite(),
        "像素完全一致时 PSNR 应为无穷大，实际 {}",
        score.psnr
    );
    assert!(
        (score.ssim - 1.0).abs() < 1e-9,
        "像素完全一致时 SSIM 应为 1.0，实际 {}",
        score.ssim
    );
}

#[test]
fn 同一张图跑分_感知指标为各自锚点值() {
    // 实测锚点：MS-SSIM = 1，Butteraugli = 0（距离分，越小越像），
    // SSIMULACRA2 = 100（质量分，越大越好）。相同图差异全为零，内部无浮点求和，
    // 锚点跨平台稳定，容差取远小于黄金基准的量级即可。
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let image_path = dir.path().join("原图.png");
    write_gradient_png(&image_path);

    let score =
        pixel_arena_core::score_images(&image_path, &image_path).expect("同一张图跑分不应报错");

    assert!(
        (score.ms_ssim - 1.0).abs() < 1e-9,
        "像素完全一致时 MS-SSIM 应为 1.0，实际 {}",
        score.ms_ssim
    );
    assert!(
        score.butteraugli.abs() < 1e-6,
        "像素完全一致时 Butteraugli 应为 0，实际 {}",
        score.butteraugli
    );
    assert!(
        (score.ssimulacra2 - 100.0).abs() < 1e-6,
        "像素完全一致时 SSIMULACRA2 应为 100，实际 {}",
        score.ssimulacra2
    );
}

#[test]
fn 图片小于最小窗口时中文报错_不崩溃() {
    // 11x11 是 SSIM 系指标的最小窗口；此前的 SSIM 实现在更小图上会因
    // usize 下溢 panic，现在是明确的中文错误。两张图都过小才能走到尺寸检查之后。
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let reference_path = dir.path().join("原图.png");
    let distorted_path = dir.path().join("跑分图.png");
    let reference = image::RgbImage::from_pixel(8, 8, image::Rgb([0, 0, 0]));
    reference
        .save(&reference_path)
        .expect("测试样例 PNG 应能写入");
    let distorted = image::RgbImage::from_pixel(8, 8, image::Rgb([10, 10, 10]));
    distorted
        .save(&distorted_path)
        .expect("测试样例 PNG 应能写入");

    let error = pixel_arena_core::score_images(&reference_path, &distorted_path)
        .expect_err("小于最小窗口的图必须报错");

    let message = error.to_string();
    assert!(
        message.contains("过小") && message.contains("11x11"),
        "错误信息应说明尺寸过小与最小窗口要求：{message}"
    );
    assert!(message.contains("8x8"), "错误信息应包含实际尺寸：{message}");
}

#[test]
fn 尺寸不一致时明确报错并给出两边尺寸() {
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let reference_path = dir.path().join("原图.png");
    let distorted_path = dir.path().join("跑分图.png");
    write_gradient_png(&reference_path);
    let distorted = image::RgbImage::from_pixel(32, 16, image::Rgb([0, 0, 0]));
    distorted
        .save(&distorted_path)
        .expect("测试样例 PNG 应能写入");

    let error = pixel_arena_core::score_images(&reference_path, &distorted_path)
        .expect_err("尺寸不一致必须报错");

    let message = error.to_string();
    assert!(
        message.contains("尺寸不一致"),
        "错误信息应说明尺寸不一致：{message}"
    );
    assert!(
        message.contains("64x64"),
        "错误信息应包含原图尺寸：{message}"
    );
    assert!(
        message.contains("32x16"),
        "错误信息应包含跑分图尺寸：{message}"
    );
}

#[test]
fn 损坏文件报错且不崩溃() {
    let dir = tempfile::tempdir().expect("临时目录应能创建");
    let bad_path = dir.path().join("损坏.png");
    std::fs::write(&bad_path, "这不是图片，是一段文本").expect("测试文件应能写入");
    let reference_path = dir.path().join("原图.png");
    write_gradient_png(&reference_path);

    let error =
        pixel_arena_core::score_images(&reference_path, &bad_path).expect_err("损坏文件必须报错");

    let message = error.to_string();
    assert!(
        message.contains("无法解码"),
        "错误信息应说明无法解码：{message}"
    );
    assert!(
        message.contains("损坏.png"),
        "错误信息应定位到文件：{message}"
    );
}

// ---------- EXIF 方向 ----------

fn fixture(name: &str) -> String {
    format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn 带exif方向的照片按显示方向解码_可与正立图对齐跑分() {
    // exif-orient6.jpg：画面存成 64x32、EXIF Orientation=6（显示时顺时针转 90°）；
    // exif-orient6-upright.png：同一画面按显示方向摆正后的 32x64 像素。
    // 解码若忽略 EXIF，两边尺寸不一致会直接报错；按方向解码后应能对上。
    let score = pixel_arena_core::score_images(
        fixture("exif-orient6.jpg"),
        fixture("exif-orient6-upright.png"),
    )
    .expect("按 EXIF 方向解码后，正立图应能与原图对齐跑分");

    assert!(
        score.psnr > 40.0,
        "同一画面的正立副本 PSNR 应很高，实际 {}",
        score.psnr
    );
    assert!(score.ssim > 0.99, "SSIM 应接近 1，实际 {}", score.ssim);
}
