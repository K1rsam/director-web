# 桌面分支云端环境

2026-10-05 已创建并发布私有 Codex 云端环境 `director-desktop`。

- 仓库：`K1rsam/director-web`。
- 分支：`handoff/director-desktop-20261005`。
- 首次配置验收提交：`4ea3851b9336d65a4fcf0c893151bc94a2e3966a`，不作为永久版本锁定。
- 云端工作目录：`/workspace/director-desktop-repo/director-desktop`。
- 安装及启动配置保存在云端环境中。发布后的环境可从“工作位置 → 云端”选择。

安装使用 Node.js 24、Rust stable、C 编译工具、pkg-config 和 CA 证书。SQLite 使用 bundled 模式，HTTP 使用 rustls；无 GUI 核心检查无需 GTK/WebKit 或外部数据库服务。生成渠道凭据未上传，环境仅自己可用。

首次云端实际验证：前端类型检查、28 项前端测试、生产构建、浏览器预览、Rust `--no-default-features --all-targets` 检查及隔离核心启动通过。完整 debug Rust 测试在 247 项通过、12 项忽略、没有已报告失败时中断，不代表完整套件通过；其日志保留在云端配置任务中。

完整 Rust 测试移出安装脚本。后续代码变更后，在桌面子目录执行：

```bash
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --lib --tests -- --test-threads=1
```

默认忽略测试保持忽略，不运行真实 Codex/即梦/BH 创作请求。浏览器预览与 Linux 核心验证不能替代 Windows/macOS 原生客户端验收，不在云端构建 Windows 安装包。

开始任务前核对分支、HEAD 和工作区状态。需要更新代码时，先保留未提交修改，再取该分支并仅快进合并；不能以 reset 覆盖工作，也不能改旧 Web 主线。新任务从已发布环境准备的文件系统启动，重要代码修改仍须提交 GitHub。

云端配置任务：[设置 director-web](https://chatgpt.com/local/01a10bb2-dbc9-7080-bf97-92517a3190b5?hostId=local)。
