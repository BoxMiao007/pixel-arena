// 像素竞技场核心库。
// T01 范围：只提供版本号查询，打通「核心库 -> GUI / CLI」的最小通路；
// 解码、指标、编码编排等能力按后续票逐个加入，不预写。

/// 核心库版本号，与 Cargo.toml 的 package.version 保持一致。
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_returns_current_core_version() {
        // 独立事实来源：当前核心库版本就是 0.1.0（与 Cargo.toml 保持一致）。
        assert_eq!(version(), "0.1.0");
    }
}
