<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 项目接手入口

开始前阅读 `README.md`、`docs/HANDOFF-2026-09-05.md` 和 `DESIGN.md`，检查分支及未提交修改。用户说的“3180 案例”固定指 `examples/3180/index.html`；运行 `npm run preview:3180` 查看完整交互。Mac 安装与数据库迁移见 `docs/LOCAL-SETUP-MAC.md`。

本地版在 `main`，Sites 平台适配在 `sites-online`，本机额外开发改动保存在 `handoff/windows-local-20260905`。同步遵循 `.platform/platform-boundaries.json`，不能将 Prisma/本地 CLI 代码盲目覆盖到 Sites。不要提交数据库、`.env`、登录文件或私人项目导出。
