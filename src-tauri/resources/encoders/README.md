# 安装包捆绑的编码器资源（T29-4，决策 0014 修订）

本目录由 CI 打包前用 `scripts/bundle-encoders.sh`（Linux/macOS）或
`scripts/bundle-encoders.ps1`（Windows）填充：按平台下载锁定工件 → sha256 校验 →
解出成员可执行文件。tauri.conf.json 的 `bundle.resources` 把本目录内容打进三端
安装包（安装后位于应用资源目录 `encoders/`，只读）。

二进制不入库：本目录除本 README 外的内容已被 .gitignore 排除。运行期由应用壳
按「设置覆盖 > 捆绑 > tools/ 下载安装」定位（见 src-tauri/src/lib.rs 的
to_core_overrides 与 tool_status.rs 的状态判定）。
