# 分镜导演工作台

> **3008 独立开发交接分支（2026-09-12）**：本分支保存 P1–P4 第一阶段、原稿 GPT6-low 结构检查、外部保真导入与按场交接。继续开发请先读 [3008 完整说明与 Mac 接续](docs/3008-MAC-HANDOFF.md)，使用 `.env.3008.example`，不要照下方历史3000入口启动。源码不含私人数据库、凭据和剧本；macOS 尚未实机验收。本次推送不合并 main，也不发布网站。

把剧本转换为项目策划、资产索引、结构化分镜表和 Seedance 单元提示词。仓库包含完整本地版、岗位规则、数据库迁移与用户确认的 3180 设计案例。

**换电脑接着做：先读本页，再看 [Mac 安装与数据迁移](docs/LOCAL-SETUP-MAC.md) 和 [2026-09-05 交接说明](docs/HANDOFF-2026-09-05.md)。**

## 代码与版本

| 入口 | 内容 |
| --- | --- |
| [`main`](https://github.com/K1rsam/director-web/tree/main) | 本地应用稳定基线；已同步本轮正式界面更新 |
| [`sites-online`](https://github.com/K1rsam/director-web/tree/sites-online) | Sites 平台适配代码；使用云端存储与本地 Runner，不直接照本页启动 |
| [`handoff/windows-local-20260905`](https://github.com/K1rsam/director-web/tree/handoff/windows-local-20260905) | 额外保存的本机开发快照：对白、时长与流水线改动；继续这部分开发时使用，未合入稳定基线 |
| [3180 案例](examples/3180/README.md) | 已核对的“柔光鸢尾·浅”第五轮 HTML；完整离线交互 |
| [设计规范](DESIGN.md) | 当前字体、玻璃材质、布局、按钮、过渡与阅读密度要求 |

线上访问：[Director Studio](https://director-studio-edy.qq8197772.chatgpt.site)。2026-09-05 本轮 UI 发布为 v9。后续版本以部署平台实际记录为准；推送 GitHub 不等于自动发布 Sites。

## 在 Mac 启动本地版

使用 Node.js 24.x（仓库有 `.nvmrc`）、npm、Git。CLI 模式另需本机可用的 Codex CLI；Python 3 用于仓库内 Python 工具和相关验证。

```bash
git clone https://github.com/K1rsam/director-web.git
cd director-web
npm ci
cp .env.example .env
```

首次新建数据时，编辑 `.env`：

- 保持 `DATABASE_URL="file:./dev.db"`，实际文件是 **`prisma/dev.db`**。
- 设置 `DIRECTOR_CREDENTIAL_KEY` 为随机的 32 字符以上密钥。可运行 `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'` 生成，再复制到本机 `.env`。
- 设置 `TEST_ACCOUNT_INITIAL_PASSWORD` 为你自己保存的初始密码。

```bash
npm run prisma:generate
npm run database:migrate
npm run accounts:seed
npm run dev
```

打开 [本地工作台](http://localhost:3000)，用 `tester01` 和刚设置的密码登录。初始化共创建 `tester01`–`tester05` 五个私有测试账号；已有账号不会被重复创建。CLI 与 API 入口位于“所有项目”。

若要继承原电脑的剧本、生成结果和账号，**不要按新库流程重新初始化**，请走 [已有数据迁移](docs/LOCAL-SETUP-MAC.md#迁移原电脑的项目数据)。克隆 GitHub 会得到程序，不会自动得到私人数据库、API Key 或 Codex 登录状态。

## 单独看 3180 案例

无需安装项目依赖，也无需数据库：

```bash
node examples/3180/serve.mjs
```

打开 [3180 案例](http://127.0.0.1:3180/index.html)。或直接下载并打开 [`examples/3180/index.html`](examples/3180/index.html)；本地服务方式支持更完整的复制体验。GitHub 文件页本身显示 HTML 源码。

## 后续更新

先保存自己的修改（提交到开发分支），再拉取；不要覆盖正在做的工作。

```bash
git pull --ff-only
npm ci
npm run prisma:generate
npm run database:migrate
npm run dev
```

更新数据库前先停止网站和正在执行的任务。迁移命令会为已有 SQLite 自动建立一致性备份；遇到不完整旧结构会停止并报错。

## 验证与开发入口

```bash
npm run typecheck
npm run verify:ui
npm run verify:database-migration
npm run build
```

更多离线检查见 `package.json` 的 `verify:*`。`verify:codex-cli:live` 与 `verify:deepseek-api` 会调用真实服务，不是日常 UI 检查步骤。页面开发先看 `AGENTS.md`，下一位开发者的具体接手提示见交接说明。

## 数据与凭证

- 本地 SQLite 与 Sites 云端数据库独立，不自动双向同步。
- `npm run database:backup` 将本地库保存到忽略提交的 `local-backups/`；私下携带备份及原来的 `DIRECTOR_CREDENTIAL_KEY`。
- Mac 必须重新安装依赖和生成 Prisma Client，不复制 Windows 的 `node_modules`、`.next` 或启动脚本。
- 仓库内已包含 `knowledge/director`、`.agents/skills` 等规则，无需从旧电脑额外拷贝全局 Skill。
- `.env`、数据库、API Key、Codex 登录文件和实际剧本数据不应提交到 GitHub。

旧 `PROJECT_HANDOFF.md` 和 `docs/release-options.md` 保留为历史记录；当前入口、部署地址与接手顺序以本页及 2026-09-05 交接说明为准。
