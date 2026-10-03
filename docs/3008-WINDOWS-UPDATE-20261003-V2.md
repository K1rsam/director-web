# Windows 接续 3008：2026.10.03.2

只更新程序版本，保留本机项目、任务历史与凭据。目标是 `http://127.0.0.1:3008`，不是旧版 3000 入口，也不是覆盖 3007。

固定版本：分支 `handoff/3008-v2026.10.03.2`，标签 `3008-v2026.10.03.2`。先读[更新说明](3008-RELEASE-20261003-V2.md)。以下命令在 **Windows PowerShell、3008 项目根目录**运行；任一命令失败时停止，不继续执行后续迁移或启动。

## 1. 已有 3008：先保护数据

1. 等现有生成任务完成或安全暂停并保存回包，再停止网页。双击 `停止3008.cmd`；它刻意保留资料工作进程，**停止网页不等于所有后台资料任务已结束**。若还有资料任务运行，先等它结束，不在运行途中更换依赖或代码。
2. 查看 `git status --short --branch`，记下当前分支和 `git rev-parse HEAD`。有本地源码改动时先保存在自己的分支；不要强制切换、reset 或用压缩包直接覆盖。不会处理本地改动时，改走下文的独立安装目录，暂不复制旧数据。
3. 在仍有原依赖和正确 `.env` 的旧目录备份数据库：

```powershell
npm run database:backup
```

它将一致性 SQLite 备份写入 `local-backups`，只备份数据库，不包含文件型任务状态。确认 `.env` 的 `DATABASE_URL` 正是原网页使用的库；现行 Windows 启动器使用项目下的 `prisma/dev.db`。路径不一致时先纠正备份目标，不能备份一个空库或另一项目的库。

同时私下备份以下**实际存在**的文件/目录，保留同一时间点的完整套件：

- `.env`，尤其原 `DIRECTOR_CREDENTIAL_KEY`；不能重新生成它替换旧密钥，否则旧 API 凭据无法解密。
- `local-backups` 中本次数据库备份。
- `.storyboard-stage3-v2`、`.storyboard-v4`、`.storyboard-stage3`：任务、冻结规则、回包和文稿历史。
- `.production-ledgers`、`.production-workflows`：预算账本、闭环和承接约定。
- `uploads` 及实际自定义素材目录。

不存在的目录不用创建。若 `.env` 指定了 `DIRECTOR_STORYBOARD_DATA_DIR`、`DIRECTOR_PRODUCTION_BUDGET_DIR` 或 `DIRECTOR_PRODUCTION_WORKFLOW_DIR` 等外部路径，备份对应真实路径，而不是仅备份上面的默认目录。不要提交这些私人备份到 GitHub，也不要复制 Mac 登录文件。

## 2. 更新已有目录

确认源码改动已安全保存、所有生成任务已结束后：

```powershell
git fetch origin
git switch --create handoff/3008-v2026.10.03.2 --track origin/handoff/3008-v2026.10.03.2
git log -1 --oneline
node --version
npm ci
npm run prisma:generate
npm run database:migrate
```

`node --version` 应为 **24.x**。如果本地已存在同名分支，不重复 `--create`；先查看它的提交，再用 `git switch handoff/3008-v2026.10.03.2`。如需拉取该分支后续更新，只用 `git pull --ff-only`，遇到分叉停止，不能强推或重置。

不要覆盖原 `.env`；不要执行 `prisma migrate reset`、在旧库执行 `prisma db push` 或重新初始化账号。迁移失败时保留备份与错误信息，不通过删除旧库绕过。

本版未新增 Prisma 表结构迁移，但旧版本可能未接续完整历史迁移，所以仍保留正式迁移命令。

## 3. 首次安装，或使用独立新目录

选择一个不存在的 `director-web-3008-v2` 目录，从其父目录运行：

```powershell
git clone --branch handoff/3008-v2026.10.03.2 --single-branch https://github.com/K1rsam/director-web.git director-web-3008-v2
cd director-web-3008-v2
node --version
npm ci
Copy-Item .env.3008.example .env
```

只在**首次新建**时复制模板，不能覆盖已有 `.env`。编辑本机 `.env`：

```dotenv
DATABASE_URL="file:./dev.db"
DIRECTOR_SESSION_COOKIE_NAME="director_session_3008"
PYTHON="python"
PYTHONUTF8="1"
PYTHONIOENCODING="utf-8"
```

新数据库还必须自行设置随机 `DIRECTOR_CREDENTIAL_KEY`（至少 32 字符）和私有 `TEST_ACCOUNT_INITIAL_PASSWORD`。可在本机用以下命令生成密钥，结果仅保存到私有 `.env`，不要粘贴到公开说明或仓库：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run prisma:generate
npm run database:migrate
npm run accounts:seed
```

`accounts:seed` 只用于首次新库；使用 `tester01` 与自行设置的密码登录。

若目的是继续旧项目，不运行新库初始化流程：先建立私有配置并保留旧密钥，再由一致性数据库备份和配套文件型任务目录恢复到正确路径，核对后迁移。代码克隆本身不会携带旧项目；新、旧目录不能同时指向同一可写数据库或同一组在运行的任务目录。

## 4. Python、CLI 与模型

- 安装 Python 3，并在终端执行 `python --version`。默认程序调用 `python3`；Windows 若仅有 `python`，在 `.env` 设置 `PYTHON="python"`。也可填本机 Python 可执行文件的绝对路径；不要填写带空格参数的 `py -3`，它不是一个可执行文件路径。
- 中文消息管道建议设置上文两项 UTF-8 环境变量，避免 Windows 默认编码破坏剧本文字。
- Windows 上重新安装并登录 Codex CLI；`codex --version` 用于核对可执行程序。沿用本机登录，不复制 Mac 的令牌、认证文件、二进制或绝对路径。程序支持原生 `codex.exe` 和 Windows npm shim；必要时仅在私有 `.env` 配置本机 `CODEX_CLI_PATH`。
- 现行 CLI 策略是 `gpt-6.1-sol` / `medium`。本机账号必须能使用这个模型；不可用时应明确报错，不悄悄降级。可在网页“CLI 与 API”检查本机连接；连接通过不等于实际模型生成通过。
- 使用 API 模式仍按该模式自己的凭据与模型规则执行，不能把 CLI 模型配置误当成 API 模型迁移。

本版运行技能随仓库 `runtime/storyboard-v4` 携带，无需把 Mac 全局技能目录复制到 Windows。

## 5. 手动启动、停止与检查

推荐双击项目根目录 `启动3008.cmd`，或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-3008.ps1
```

启动器在本机另起隐藏进程，日志是 `runtime-3008\stdout.log` 和 `runtime-3008\stderr.log`。它不是自动恢复的 Windows 服务；网页自动打开或打印 starting 不表示启动成功。先看日志出现 Ready，再打开 `http://127.0.0.1:3008/login`。

```powershell
Get-Content .\runtime-3008\stdout.log -Tail 30
Get-Content .\runtime-3008\stderr.log -Tail 30
Get-NetTCPConnection -LocalPort 3008 -State Listen
```

停止时双击 `停止3008.cmd`，或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-3008.ps1
```

如果希望直接看终端日志，可运行 `npm run dev:3008`；此方式是前台进程，关闭终端或按 Ctrl+C 就停止。两种方式择一，不能同时占用 3008。`npm run dev` 是历史 3000 入口，不用于本版。

## 6. 更新后先做免费核对

```powershell
npm run typecheck
npm run verify:source-parser-ipc
npm run verify:workflow-glass
```

打开网页核对原项目、账号、资料和任务历史仍在，检查步骤卡与页头是否一致。已打开的旧页面刷新一次加载新版资源。不要仅为验证升级重新生成已有付费稿；需要新技能效果时另建新任务，旧任务的冻结规则和输入不被替换。

新一轮第一阶段会在既有资料核对中顺带生成方向候选；旧项目不自动收费补卡。要给第三阶段统一全剧方向，应在“剧本阅读与全剧方向”核对并确认采用，而非仅看到资料已整理。

## 7. 出错或需要回退

保留日志、当前提交、私人备份和旧目录。不要删除任务目录清除错误，或通过重复点击生成尝试“修复升级”。未知回包与用量先核对，避免重复计费。

代码可切回步骤 1 记录的旧分支/提交或保留的旧目录；有本地修改时先保存。数据与代码兼容性需单独核对，不能把旧数据库备份直接覆盖升级后产生的新数据。确需整套回退时，恢复同一时间点数据库、旧密钥与文件型任务目录，并先保留回退前现状。

本指南已根据现行路径、启动/停止及迁移源码核对；此次验证环境是 macOS，尚未在用户 Windows 电脑上实机运行。不要把离线回归或 HTTP 存活当作 Windows 全流程与创作品质验收。
