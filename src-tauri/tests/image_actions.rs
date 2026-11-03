// 图片右键菜单「另存为」的实现体测试：不经 Tauri 运行时，直接调
// pixel_arena_lib::copy_image_file，钉住「源文件必须存在 / 目标不能是源文件本身 /
// 逐字节拷贝」三条契约。打开与定位只是 opener 插件的一行转发，不在这里测。

use std::fs;
use std::path::Path;

fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn copies_bytes_to_new_target() {
    let dir = tempfile::tempdir().expect("临时目录");
    let source = dir.path().join("shot.png");
    let target = dir.path().join("copy.png");
    fs::write(&source, b"pixel-arena").expect("写源文件");

    let saved = pixel_arena_lib::copy_image_file(&shown(&source), &shown(&target))
        .expect("另存应成功");

    assert_eq!(saved, shown(&target));
    assert_eq!(fs::read(&target).expect("读目标文件"), b"pixel-arena");
    // 源文件必须原样保留（另存不是移动）
    assert_eq!(fs::read(&source).expect("读源文件"), b"pixel-arena");
}

#[test]
fn overwrites_existing_target() {
    let dir = tempfile::tempdir().expect("临时目录");
    let source = dir.path().join("new.png");
    let target = dir.path().join("old.png");
    fs::write(&source, b"new-bytes").expect("写源文件");
    fs::write(&target, b"old-bytes").expect("写旧目标");

    pixel_arena_lib::copy_image_file(&shown(&source), &shown(&target))
        .expect("覆盖应成功");

    assert_eq!(fs::read(&target).expect("读目标文件"), b"new-bytes");
}

#[test]
fn rejects_missing_source_with_chinese_reason() {
    let dir = tempfile::tempdir().expect("临时目录");
    let missing = dir.path().join("nope.png");
    let target = dir.path().join("out.png");

    let err = pixel_arena_lib::copy_image_file(&shown(&missing), &shown(&target))
        .expect_err("源文件不存在应报错");
    assert!(err.contains("源文件不存在"), "实际错误：{err}");
}

#[test]
fn rejects_saving_onto_itself() {
    let dir = tempfile::tempdir().expect("临时目录");
    let source = dir.path().join("same.png");
    fs::write(&source, b"bytes").expect("写源文件");
    let path = shown(&source);

    let err = pixel_arena_lib::copy_image_file(&path, &path).expect_err("同路径应报错");
    assert!(err.contains("无需另存"), "实际错误：{err}");
    assert_eq!(fs::read(&source).expect("读源文件"), b"bytes");
}
