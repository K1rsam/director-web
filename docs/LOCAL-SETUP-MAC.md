# Mac 本地复刻与继续开发

> 3008 当前交接请先阅读 [3008 完整说明与 Mac 接续](3008-MAC-HANDOFF.md)；下文保留历史背景。

更新：2026-09-05。适用于本仓库的 `main`，以及基于它的 `handoff/windows-local-20260905` 分支；不适用于直接启动 `sites-online`。

## 先选代码版本

- 继续网站界面优化：克隆 `main`，从它创建自己的开发分支。
- 同时继续这台 Windows 电脑尚在开发的对白、时长、流水线工作：克隆 `handoff/windows-local-20260905`。该分支额外保留 24 个源文件的改动，详见交接说明；没有把这批工作直接混入正式分支。

```bash
# 常规本地版
git clone https://github.com/K1rsam/director-web.git

# 或者另建目录，接续本机开发快照
git clone --branch handoff/windows-local-20260905 https://github.com/K1rsam/director-web.git director-web-local-handoff
```

进入选定目录后运行 `git status`、`git log -5 --oneline`，确认自己所在分支。不要同时混用两个目录的 `.env` 或数据库。

## 新电脑准备

需要 Git、Node.js 24.x 与随附 npm。已有 nvm 可运行 `nvm install && nvm use`；否则安装对应 Mac 架构的 Node.js 24.x。检查 `node --version`、`npm --version`、`git --version`。

Apple Silicon 与 Intel Mac 都需要在自己的机器运行 `npm ci` 和 `npm run prisma:generate`，以获取对应平台依赖；不要复制 Windows 的 `node_modules`、`.next` 或生成的 Prisma Client。

仓库的 `.cmd`、`.ps1` 是 Windows 辅助启动器，Mac 直接用下文的 npm 命令。Python 3 用于 `scripts/e8_pipeline.py` 等 Python 工具与 `npm run verify:e8`，不需要为了打开 HTML 案例安装 Python。

## 首次创建空工作台

1. 按根 README 执行 `npm ci`、`cp .env.example .env`。
2. 在 `.env` 设置随机 `DIRECTOR_CREDENTIAL_KEY`（至少 32 字符）、自定 `TEST_ACCOUNT_INITIAL_PASSWORD`。不要把实际值写进文档或 Git。
3. 执行 `npm run prisma:generate`、`npm run database:migrate`、`npm run accounts:seed`。
4. 执行 `npm run dev`，打开 `http://localhost:3000`，使用 `tester01` 和自定密码登录。

这里是新数据库，不会出现旧电脑的“无限心动”等私人项目。项目、账号及生成结果由数据库保存，源码仓库不附带它们。

## 迁移原电脑的项目数据

### 在原电脑准备

先等运行中的制作任务结束或通过界面停止任务，再关闭网站服务，避免导出后又产生新的结果。在原电脑实际项目目录执行：

```bash
npm run database:backup
```

命令读取该目录 `.env` 的 `DATABASE_URL`，用 SQLite `VACUUM INTO` 创建完整一致性副本，路径打印在终端，文件保存在 `local-backups/director-时间.db`。支持默认路径和自定义 SQLite 路径；路径不存在时停止，不会创建空库冒充备份。

通过自己的加密存储、U 盘等私人渠道带走：

- 刚生成的数据库备份。
- 原 `.env` 中的 **`DIRECTOR_CREDENTIAL_KEY`**，以及仍需要的 API 配置；可以私下带走 `.env`，但在 Mac 重新检查路径。
- 若另外保存了原始剧本、图片等仓库外文件，也单独携带。数据库备份不等于备份电脑上所有媒体文件。

`local-backups/` 和 `.env` 已被忽略提交。不要把它们放到 GitHub。不要仅复制正在运行的 `dev.db` 而遗漏 SQLite 的 WAL 内容，使用备份命令即可获得一致副本。

### 在 Mac 恢复

1. 安装依赖，复制 `.env.example` 为 `.env`。
2. 将备份复制为 `prisma/dev.db`；若该处已有有用数据库，先另外备份，不要直接覆盖。
3. 设置 `DATABASE_URL="file:./dev.db"`。Prisma 的相对数据库路径以 `prisma/schema.prisma` 所在目录为基准。
4. 填回原 **`DIRECTOR_CREDENTIAL_KEY`**。重新随机生成会使库内原有加密 API 凭证无法解密。
5. 运行：

```bash
npm run prisma:generate
npm run database:migrate
npm run dev
```

使用原账号密码登录，不需要重新 seed。历史项目、分镜和生成文本来自恢复的库。若确实忘记私有测试账号密码，可以在 `.env` 设置新 `TEST_ACCOUNT_INITIAL_PASSWORD`，然后运行 `npm run accounts:seed -- --rotate tester01`；这会退出该账号已有会话。

数据库不会搬走原电脑上运行中的进程；检查任务状态后再继续制作。Codex CLI 应在 Mac 自己安装并登录，不能把 Windows 的进程、登录文件或绝对路径当成已经迁移。

## CLI 与 API

从“所有项目”打开“CLI 与 API”。本地版 CLI 调用当前电脑的可执行文件；API 模式使用账号保存的凭证或本地环境回退。

- 确认当前终端可以找到 `codex`，然后使用应用的本机检测。
- 清理 `.env` 中旧 Windows 的 `CODEX_CLI_PATH`、`DIRECTOR_KNOWLEDGE_BASE_DIR`、`CODEX_SKILLS_DIR` 等自定义路径；默认规则与 Skill 已在仓库内。
- 必须自定义路径时改成真实的 Mac 路径，而不是 `C:\...` 或 `E:\...`。
- 登录、额度和密钥取决于自己的账号。先验证页面和本机连接，真实生成需主动操作。

## 继续优化网站

```bash
git switch -c design/mac-next
npm run dev
```

同时开一个终端运行 `npm run preview:3180`，在 100% 浏览器缩放下并排比较正式页面和样稿。不要将生产版整体缩放至 200%，也不要只改样稿而漏改正式应用。

提交前按改动运行 `npm run typecheck`、`npm run verify:ui` 和 `npm run build`。本地生产构建可用 `npx next start` 启动；日常优化使用 `npm run dev`。`git push -u origin design/mac-next` 保存新分支。

Sites 采用独立适配层，发布流程见 [交接说明](HANDOFF-2026-09-05.md)，不应把本地 Prisma/CLI 服务原样覆盖到云端代码。GitHub 推送不会迁移数据库或自动完成 Sites 发布。

## 验证范围

安装流程已在 Windows 全新目录验证，建库、账号初始化、备份副本和生产构建启动均通过，详细结果见交接说明。macOS 路径分支已从代码核对，但本次没有 Mac 实机，不能把它当作已经通过的 macOS 运行测试。
