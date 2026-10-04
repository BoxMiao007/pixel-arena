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
