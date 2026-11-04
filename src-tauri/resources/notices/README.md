# crate 许可清单（决策 0047）

本目录的 `crate-notices.md` 由 [`cargo-about`](https://github.com/EmbarkStudios/cargo-about)
生成，不入库（`.gitignore` 排除）。生成命令：

```sh
cargo about generate --workspace --config about.toml about.hbs \
  -o src-tauri/resources/notices/crate-notices.md
```

CI（release.yml）在打包前自动生成并随安装包捆绑；本地构建前需手动执行一次
（需先 `cargo install cargo-about --locked --features cli`）。配置白名单见仓库根
`about.toml`，模板见 `about.hbs`。
