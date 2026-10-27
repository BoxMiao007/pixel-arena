// T3（票 #77）两个薄后端能力的端到端测试：不经 Tauri 运行时，直接调
// pixel_arena_lib 的 `*_impl` 实现体（与 IPC 命令同一实现，沿 onestop_catalog.rs 先例）。
//
// 覆盖票面验收：
// - 清空某轮跑分行后 candidates 为空、原图与轮仍在、磁盘产物文件存在性不受影响；
//   组/轮不存在时报中文错误。
// - 图片标识读取：读到的行给出大小与修改时间；读不到的行给出中文原因，
//   且不中断整批（面板要把「能读的 + 读不到的原因」一起拿到）。
//
// 说明：workspace 的可变方法只能在内存里跑，测试不落盘工作区文件（那属于 IPC 层
// 的 mutate 职责），磁盘文件存在性用真实临时文件自己造——不受工作区持久化干扰。

use std::io::Write;

use pixel_arena_core::workspace::Workspace;
use pixel_arena_lib::{image_identities_impl, round_clear_candidates_impl};

/// 临时图片的固定内容（大小断言从这里来，避免手写常量与内容漂移）。
const IMAGE_BYTES: &[u8] = b"not-a-real-image-but-a-real-file";

/// 造一张真实存在的图片文件（内容无所谓：清行与标识读取都不解码）。
fn write_temp_image(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut file = std::fs::File::create(&path).expect("创建临时图片");
    file.write_all(IMAGE_BYTES).expect("写入临时图片");
    path
}

#[test]
fn round_clear_candidates_清空后原图与轮保留且磁盘文件不被删除() {
    let dir = tempfile::tempdir().expect("临时目录");
    let reference = write_temp_image(dir.path(), "photo-ref.png");
    let product = write_temp_image(dir.path(), "photo-dis.jpg");
    let reference_text = reference.display().to_string();
    let product_text = product.display().to_string();

    let mut ws = Workspace::new();
    let group_id = ws.create_group("图片组", pixel_arena_core::workspace::GroupKind::Image)
        .expect("建组")
        .id
        .clone();
    let round_id = ws.create_round(&group_id, "评测轮 1（photo-ref.png）")
        .expect("建轮")
        .id
        .clone();
    ws.set_round_reference(&group_id, &round_id, &reference_text)
        .expect("设原图");
    ws.add_round_candidates(&group_id, &round_id, &[product_text.as_str()])
        .expect("加跑分图");

    round_clear_candidates_impl(&mut ws, &group_id, &round_id).expect("清空跑分行");

    let group = ws.groups.iter().find(|g| g.id == group_id).expect("组还在");
    let round = group.rounds.iter().find(|r| r.id == round_id).expect("轮还在");
    assert!(round.candidates.is_empty(), "清空后 candidates 必须为空");
    assert_eq!(
        round.reference_path.as_deref(),
        Some(reference_text.as_str()),
        "原图必须保留"
    );
    assert_eq!(round.name, "评测轮 1（photo-ref.png）", "轮本身必须保留");
    assert!(reference.exists(), "原图文件不应被删除");
    assert!(product.exists(), "磁盘上的产物文件不应被删除");
}

#[test]
fn round_clear_candidates_组或轮不存在时报中文错误() {
    let mut ws = Workspace::new();
    let group_id = ws.create_group("图片组", pixel_arena_core::workspace::GroupKind::Image)
        .expect("建组")
        .id
        .clone();
    let round_id = ws.create_round(&group_id, "轮").expect("建轮").id.clone();

    let group_error = round_clear_candidates_impl(&mut ws, "不存在的组", &round_id).unwrap_err();
    assert!(
        group_error.to_string().contains("跑分组不存在"),
        "组不存在应报中文错误：{group_error}"
    );
    let round_error = round_clear_candidates_impl(&mut ws, &group_id, "不存在的轮").unwrap_err();
    assert!(
        round_error.to_string().contains("评测轮不存在"),
        "轮不存在应报中文错误：{round_error}"
    );
}

#[test]
fn image_identities_读到大小与修改时间_读不到给中文原因不中断整批() {
    let dir = tempfile::tempdir().expect("临时目录");
    let image = write_temp_image(dir.path(), "a.png");
    let missing = dir.path().join("不存在.png");

    let paths = vec![
        image.display().to_string(),
        missing.display().to_string(),
    ];
    let identities = image_identities_impl(&paths);

    assert_eq!(identities.len(), 2, "每个入参都应有一行回包");
    let ok = &identities[0];
    assert_eq!(ok.path, paths[0]);
    assert_eq!(
        ok.size_bytes,
        Some(IMAGE_BYTES.len() as u64),
        "大小应是文件真实字节数"
    );
    assert!(ok.modified_ms.is_some(), "应读到文件修改时间");
    assert_eq!(ok.error, None);

    let failed = &identities[1];
    assert_eq!(failed.path, paths[1]);
    assert_eq!(failed.size_bytes, None);
    assert_eq!(failed.modified_ms, None);
    let error = failed.error.as_deref().expect("读不到应有原因");
    assert!(
        error.contains("读取图片信息失败"),
        "失败原因应是中文且可定位：{error}"
    );
}

#[test]
fn image_identities_空入参返回空表() {
    assert!(image_identities_impl(&[]).is_empty());
}
