//! 产物命名与输出目录（T29-1）。
//!
//! 命名格式（需求 9，决策 D6–D9）：
//! `{原图名}_{编码器小写}_q<值>|lossless[_{(自定义参数)}].{扩展名}`，
//! 例：`image123_avif_q60_(-y 420 --sharpyuv -s 4).avif`。
//!
//! 命名同时受两个约束：
//! - 必须是三平台都合法的文件名：Windows 禁字符与控制字符逐字符最小替换为 `_`、
//!   尾随空格/点剥离、保留设备名加 `_` 前缀、全名 ≤255 字节且不切断多字节序列
//!  （先截原图名再拼后缀，编码器小写 + 质量 + 扩展名永远保留）；
//! - 自定义参数段要「复制后可直接在 shell 执行」：每个参数词过 POSIX shell
//!   单词引用（[`shell_quote`]）。
//!
//! 同名冲突默认自动追加 `_1/_2` 不覆盖（决策 D9），比较大小写不敏感——
//! Windows/macOS 文件系统本就大小写不敏感，Linux 上统一同样口径，三端行为一致。
//! T30 起 GUI 可选「询问」策略：写入前弹窗，用户拍板「覆盖」时按确切名落位
//!（[`ConflictPolicy`]）；CLI 恒为自动追加（决策 0017）。

use crate::error::CoreError;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// GUI 产物输出目录名（决策 D5）：原图/视频所在目录下固定叫这个，已存在直接复用。
pub const PRODUCT_DIR_NAME: &str = "Pixel Arena";

/// 单个文件名的字节上限：NTFS/ext4/APFS 等常见文件系统的最严格约束。
const MAX_FILE_NAME_BYTES: usize = 255;

/// 产物名的质量段（决策 D7/D8）：有损统一 `q<值>`（大小优先写实际质量点），
/// 无损统一 `lossless`，PNG 对照组没有质量段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualitySegment {
    /// PNG 对照组：名称里没有质量段。
    None,
    /// 无损对照组：统一 `lossless`。
    Lossless,
    /// 有损：`q<值>`。
    Lossy(u8),
}

/// 产物文件名（纯函数）：原图名去扩展名 + 编码器小写短名 + 质量段 + 可选自定义
/// 参数段 + 扩展名，整体过文件名合法性约束（见模块注释）。
///
/// `custom_params` 为空时省略参数段；每个词按需 shell 引用。参数段同样要当文件名
/// 用：shell 引号里只有 `'` 是 Windows 文件名合法字符，含 `'`/`"` 等字符的参数值
/// 经最小替换后在该字符处不再保持 shell 还原语义（空格等常见场景不受影响）。
pub fn product_file_name(
    stem: &str,
    encoder: &str,
    quality: QualitySegment,
    custom_params: &[&str],
    extension: &str,
) -> Result<String, CoreError> {
    let mut suffix = format!("_{encoder}");
    match quality {
        QualitySegment::None => {}
        QualitySegment::Lossless => suffix.push_str("_lossless"),
        QualitySegment::Lossy(q) => suffix.push_str(&format!("_q{q}")),
    }
    if !custom_params.is_empty() {
        let words: Vec<String> = custom_params.iter().map(|word| shell_quote(word)).collect();
        suffix.push_str(&format!("_({})", replace_forbidden(&words.join(" "))));
    }
    suffix.push('.');
    suffix.push_str(extension);

    // 参数段极长时原图名可能无处可放：fail-fast，不默默丢内容
    if suffix.len() >= MAX_FILE_NAME_BYTES {
        return Err(CoreError::Encode {
            message: format!(
                "产物名后缀过长（{len} 字节，上限 {MAX_FILE_NAME_BYTES}），请精简自定义参数：{suffix}",
                len = suffix.len()
            ),
        });
    }
    let budget = MAX_FILE_NAME_BYTES - suffix.len();
    let stem = sanitize(stem);
    let stem = truncate_utf8(&stem, budget);
    Ok(format!("{stem}{suffix}"))
}

/// 产物名冲突的处理方式（T30）：GUI 可配置「自动追加 / 询问」，询问下用户拍板
/// 「覆盖」时用 Overwrite；CLI 不读 GUI 设置，恒为 AutoAppend（决策 0017）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConflictPolicy {
    /// 已有同名（大小写不敏感）时自动追加 `_1`/`_2`，永不覆盖已有文件（决策 D9，
    /// 现状默认行为）。
    #[default]
    AutoAppend,
    /// 使用确切的产物名，已有同名文件由最终落位的一次 rename 覆盖（编码先进
    /// 暂存目录完成，见 [`crate::encode`]，中途失败不动已有文件）。
    Overwrite,
}

/// 同名冲突去重（决策 D9）：`dir` 里已有同名文件（大小写不敏感比较）时自动追加
/// `_1`/`_2`，永不覆盖已有文件。目录不存在视为无冲突（首个产物必然不撞名）。
pub fn unique_file_name(dir: &Path, file_name: &str) -> Result<String, CoreError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(file_name.to_string());
        }
        Err(err) => {
            return Err(CoreError::Encode {
                message: format!("无法读取产物目录 {}：{err}", dir.display()),
            });
        }
    };
    // 非 UTF-8 的目录项不可能与我们的 UTF-8 产物名相等，跳过无碍
    let existing: HashSet<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .map(|name| name.to_lowercase())
        .collect();
    if !existing.contains(&file_name.to_lowercase()) {
        return Ok(file_name.to_string());
    }
    let (base, extension) = match file_name.rsplit_once('.') {
        Some((base, ext)) => (base, Some(ext)),
        None => (file_name, None),
    };
    for n in 1u64.. {
        let candidate = match extension {
            Some(ext) => format!("{base}_{n}.{ext}"),
            None => format!("{base}_{n}"),
        };
        if !existing.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }
    unreachable!("候选序号穷举不可能耗尽")
}

/// 按冲突策略解析产物名（T30）：AutoAppend 走 [`unique_file_name`]（追加 `_1/_2`），
/// Overwrite 原样返回（确切名落位覆盖，语义见 [`ConflictPolicy::Overwrite`]）。
/// 编码函数一律经此解析，不再各自判断。
pub fn resolve_product_name(
    dir: &Path,
    file_name: &str,
    policy: ConflictPolicy,
) -> Result<String, CoreError> {
    match policy {
        ConflictPolicy::AutoAppend => unique_file_name(dir, file_name),
        ConflictPolicy::Overwrite => Ok(file_name.to_string()),
    }
}

/// 目标名是否与 `dir` 里已有文件冲突（T30 询问策略用，大小写不敏感，口径与
/// [`unique_file_name`] 完全一致——判定即「去重解析是否改了名」，不另起一套）。
/// 目录不存在视为无冲突。
pub fn file_name_conflicts(dir: &Path, file_name: &str) -> Result<bool, CoreError> {
    Ok(unique_file_name(dir, file_name)? != file_name)
}

/// GUI 产物输出目录（决策 D5）：原图/视频所在目录下的「Pixel Arena」文件夹。
/// 原图路径没有目录部分（纯文件名）时报中文错误。
pub fn product_output_dir(source: &Path) -> Result<PathBuf, CoreError> {
    let parent = source
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| CoreError::Encode {
            message: format!("无法确定原图所在目录（原图路径缺少目录部分）：{}", source.display()),
        })?;
    Ok(parent.join(PRODUCT_DIR_NAME))
}

/// 确保产物输出目录可用（决策 D5）：不存在则创建，不可写当场报中文错误——
/// GUI 据此提示用户可中止本次跑分或更换原图/视频位置。真正的可写性只有
/// 写了才知道：探针文件即写即删。
pub fn ensure_output_dir_writable(dir: &Path) -> Result<(), CoreError> {
    std::fs::create_dir_all(dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物输出目录 {}：{err}", dir.display()),
    })?;
    let probe = dir.join(".pixel-arena-可写性探针");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            std::fs::remove_file(&probe).ok();
            Ok(())
        }
        Err(err) => Err(CoreError::Encode {
            message: format!(
                "产物输出目录不可写：{}（{err}）。可中止本次跑分，或更换原图/视频到可写位置后重试",
                dir.display()
            ),
        }),
    }
}

/// 文件名清洗（stem 专用）：先逐字符最小替换，再剥尾随空格/点（Windows 目录条目
/// 不允许），恰为保留设备名时加 `_` 前缀。
fn sanitize(stem: &str) -> String {
    let cleaned = replace_forbidden(stem);
    let cleaned = cleaned.trim_end_matches([' ', '.']);
    if is_windows_reserved(cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    }
}

/// Windows 禁字符 `< > : " / \ | ? *` 与控制字符逐字符最小替换为 `_`（stem 与
/// 自定义参数段共用；只替换禁字符，不做多余清洗）。
fn replace_forbidden(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 || c == '\u{7f}' => '_',
            c => c,
        })
        .collect()
}

/// Windows 保留设备名（不分大小写，可带序号）：恰为 stem 时占用会出问题，加前缀避开。
fn is_windows_reserved(stem: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.contains(&stem.to_ascii_uppercase().as_str())
}

/// 按字节预算截断字符串，在 char 边界回退，绝不切断多字节序列。
fn truncate_utf8(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    let mut cut = budget;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// POSIX shell 单词引用：产物名参数段里的每个词复制出来可直接粘贴进 shell 执行。
/// - 稳妥字符（字母数字与 `_ - . / : = @ % + ,`）不加引号；
/// - 其余统一单引号包裹，内部单引号走 `'\''` 三段式（不用双引号形式：`"` 是
///   Windows 文件名禁字符，参数段还要当文件名用）。
pub(crate) fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | '@' | '%' | '+' | ','));
    if plain {
        return word.to_string();
    }
    let mut quoted = String::from("'");
    for c in word.chars() {
        if c == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- T30：冲突策略（自动追加 / 询问后覆盖） ----------

    #[test]
    fn file_name_conflicts_detects_case_insensitive_matches() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            !file_name_conflicts(dir.path(), "a_avif_q60.avif").unwrap(),
            "目录不存在视为无冲突（首个产物必然不撞名）"
        );
        std::fs::write(dir.path().join("a_avif_q60.avif"), b"x").unwrap();
        assert!(file_name_conflicts(dir.path(), "a_avif_q60.avif").unwrap());
        // 大小写不敏感口径与 unique_file_name 一致（ADR 0023）
        assert!(
            file_name_conflicts(dir.path(), "A_AVIF_Q60.AVIF").unwrap(),
            "冲突判定应大小写不敏感"
        );
        std::fs::write(dir.path().join("b_avif_q60.avif"), b"x").unwrap();
        assert!(
            !file_name_conflicts(dir.path(), "c_avif_q60.avif").unwrap(),
            "名字不同的文件不算冲突"
        );
    }

    #[test]
    fn resolve_product_name_appends_or_keeps_per_policy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.png"), b"x").unwrap();
        // AutoAppend：现状行为，追加 _1 不覆盖
        assert_eq!(
            resolve_product_name(dir.path(), "a.png", ConflictPolicy::AutoAppend).unwrap(),
            "a_1.png"
        );
        // Overwrite：用户拍板覆盖，原样返回确切名
        assert_eq!(
            resolve_product_name(dir.path(), "a.png", ConflictPolicy::Overwrite).unwrap(),
            "a.png"
        );
        // 无冲突时两种策略结果一致
        assert_eq!(
            resolve_product_name(dir.path(), "b.png", ConflictPolicy::Overwrite).unwrap(),
            resolve_product_name(dir.path(), "b.png", ConflictPolicy::AutoAppend).unwrap()
        );
    }

    #[test]
    fn shell_quote_covers_plain_and_quoted_forms() {
        assert_eq!(shell_quote("-y"), "-y");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("my photo"), "'my photo'");
        assert_eq!(shell_quote("it's fine"), "'it'\\''s fine'");
    }

    #[test]
    fn truncate_utf8_never_splits_multibyte_chars() {
        assert_eq!(truncate_utf8("长长长", 7), "长长");
        assert_eq!(truncate_utf8("abc", 10), "abc");
        assert_eq!(truncate_utf8("", 5), "");
    }
}
