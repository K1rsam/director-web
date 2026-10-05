# 本地客户端交付

- Windows 对外入口固定为 `src-tauri/target/release/director-desktop.exe`。
- 仅保留上一轮 `director-desktop-previous.exe`；下一次更新覆盖更早的备用版，将更新前的当前版转为备用版。
- 完成必要验证后使用 `scripts/update-client.ps1` 发布；可用 `-PublishOnly -CandidatePath <已验证程序>` 避免再次构建。构建候选仅放在内部 `deps`，不再创建阶段名或日期名的对外 EXE。
- 不能强制关闭用户客户端；文件使用中无法轮换时保留现有程序，明确告知需自然关闭后再更新。不得清理项目、数据库、媒体、凭据或 CLI 工具。
- 安装包只在用户明确要求构建时制作，日常更新使用 `npm run desktop:update`。
