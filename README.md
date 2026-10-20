# 分镜导演工作台

> **最新 3008 GitHub 交接版：`3008-v2026.10.20.1`**，分支 [`handoff/3008-v2026.10.20.1`](https://github.com/K1rsam/director-web/tree/handoff/3008-v2026.10.20.1)。整合连续制作与安全恢复、字卡确认、情绪/运镜/幻想偏好、系统表现及 v6.5 进度适配；更新与验证边界见[本版说明](docs/3008-RELEASE-20261020-V1.md)。只上传程序、规则、通用回归和文档；不含私人项目、数据库、凭据、150 集稿件或原生回执，不合并 main、不发布网站。旧任务保持冻结，不因升级重跑。

> **四路控制面：2026-10-18**，见[V18](docs/3008-FOUR-LANE-CONTROLS-20261018-V18.md)。模型/推理可选，默认6.1 Sol中档、Fast关闭；统一暂停只关后续派单、保留在途回包。人工暂停后继续原队列；未暂停的原授权可在开盖联网后安全重连，未知费用不自动补发。已完成项目和冻结任务不重跑、不换档；离线回归不等于真实合盖/跨平台生产验收。

> **第一阶段已返回结果恢复：2026-10-18**，见[V17](docs/3008-STAGE1-RECOVERY-20261018-V17.md)。同一已登记身份的安全使用补充自动保留全部场号和说明，不再因重复 key 卡死整批；历史失败可在网页“恢复已返回结果（零模型）”复验原回包。未知费用、源文变化、真实身份冲突及用户停止仍保护，后续未制作内容与免费恢复分开计费，不保证所有项目零故障。

> **第三阶段真实生成与精修验收：2026-10-05**，接续[V11实测记录](docs/3008-STAGE3-LIVE-QUALITY-20261005-V11.md)：第1/2集实际生成、精修、逐组采用与网页下载完成，10次调用共776,746已知Token。保留原稿，修复范围装载、关联幻想接收、重核重复提示和计数；新可逆历史运输仅影响新任务。文本有具体改进，不宣称第三方9分、真实视听或生产链传播已验收，历史版本不覆盖。

> **导演精修主动改稿：2026-10-05**，接续[V10改稿修复](docs/3008-STAGE3-REFINEMENT-IMPROVEMENT-20261005-V10.md)：默认整集主动找缺口、局部改正文并复查原有强项，不再给未改单元写保留辩护；精修只读独立技能，不重复叠加普通生成方法。新任务用 `director-refinement-v3`，冷重载后生效；旧稿/旧任务不强换，零修改明确“未产生改善”。免费回归与局部文字演练通过，真实新稿及成片仍待验收。

> **Mac 本地接续：2026-10-04**，已接入 GitHub `2511c56` 的第二阶段图片工作台及读取优化，保留本机数据、配置和第三阶段创作规则。Mac 验证、备份与 Chrome 生图连接边界见 [Mac 接续记录 V1](docs/3008-MAC-INTEGRATION-20261004-V1.md)。下方 Windows 连接完成记录仅适用于 Windows，不能视为 Mac 已连接。

> **第三阶段本地修订：2026-10-04**，连续发声、有效幻想、接收兼容及自然短尾修复见 [质量保全 V2](docs/3008-STAGE3-QUALITY-REPAIR-20261004-V2.md)。保持既有创作能力；正常重启3008后新建任务启用，旧任务沿冻结版本。已做免费回归，真实新稿、视频质量与Token收益仍待测试；尚未提交或推送。

> **第三阶段表现定版：2026-10-04**，取消镜长模板、源头区分幻想机制及跨镜气口定位见 [表现与节奏 V3](docs/3008-STAGE3-EXPRESSION-FINAL-20261004-V3.md)。保留已有爽感、强表演及有效长幻想；`expressive-cadence-v2`/`screen-rhythm-v3`只用于冷重载后新建任务，旧任务不换规则。工程回归通过不代表新稿或视频已验收。

> **第三阶段最新纠正：2026-10-04**，V3真实新稿暴露有效剪辑和反应重音退步，见[有效剪辑恢复 V4](docs/3008-STAGE3-EDITING-RECOVERY-20261004-V4.md)。恢复旧版有效观看引导，保留新版不断声、气口和现实回接；不恢复镜长硬锁，不新增收费岗位。新建版本为`expressive-cadence-v3`/`screen-rhythm-v4`，须原生冷重载，旧任务保持冻结。V3保留为历史记录，不代表当前质量结论；真实新稿及视频仍待验收。

> **第三阶段局部收口：2026-10-04**，用户新稿已感到改善，接续[语气、收尾与揭示 V5](docs/3008-STAGE3-CADENCE-CLOSURE-20261004-V5.md)：保留V4剪辑与幻想收益，按具体语气保留慢说/停顿，修逐镜摊慢、重复收束及揭示时机，不再改全局镜长。新任务为`expressive-cadence-v3`/`screen-rhythm-v5`；只给现有整编补尾段坐标，不增岗位/自动派单，旧稿与历史快照不变。工程和片段验证不代表真实视频验收。

> **第三阶段可选导演精修：2026-10-04**，见[稳定底稿与独立精修 V6](docs/3008-STAGE3-STABLE-REFINEMENT-20261004-V6.md)。完整稿后选1至2连续事件，单次独立候选，不覆盖原稿、不自评分循环；可免费导出同源完整A/B盲审材料。新任务冻结`director-refinement-v1`，需原生冷重载；跨集传播未核对时只预览。免费回归通过，尚无真实精修或第三方9分验收。

> **第三阶段精修纠正：2026-10-05**，两次真实精修全保留，不能算有提升的A/B，见[精修核查修复 V7](docs/3008-STAGE3-REFINEMENT-REPAIR-20261005-V7.md)。同稿转单稿复核，新增连续完整单元范围、简短工作单与有依据的处理账；明确冻结方向是否采用。新任务用`director-refinement-v2`，旧v1不强换；未改普通三岗规则、不自动重跑。工程验证通过，真实提升与第三方评分仍待验收。

> **第三阶段保全与择优采用：2026-10-05**，接续[稳定优化 V8](docs/3008-STAGE3-STABILITY-20261005-V8.md)。三岗用既有情绪契约核关联镜的实际作用；精修按完整修改组免费采用，默认无选择，未选部分精确保留基稿，导出实际采用稿。新任务冻结`expressive-cadence-v4`，旧任务不换；不新增收费岗位或自动循环。工程与受限文字样本不代表真实新稿、成片或第三方9分验收。

> **本机 Windows 整合版：2026-10-04**，在 `afe7cce` 上保留第二阶段图片工作台并修复数据库读取及 Windows 运行接续。当前本地分支为 `local/3008-integrated-20261003`；部署与验收见[整合说明](docs/3008-INTEGRATED-20261004.md)。
>
> **历史 3008 上游更新版本：`3008-v2026.10.03.2`（开发验证版）**
> 使用独立分支 [`handoff/3008-v2026.10.03.2`](https://github.com/K1rsam/director-web/tree/handoff/3008-v2026.10.03.2)。这是在旧版 `1c77b9f` 上追加的版本，不覆盖 `main` 或旧交接分支。先读 [本版更新说明](docs/3008-RELEASE-20261003-V2.md)；**Windows 更新及启动请读 [Windows 接续指南](docs/3008-WINDOWS-UPDATE-20261003-V2.md)**，不要使用下方历史 3000 安装入口。GitHub 只包含代码、规则和说明，不包含本机项目、密钥与生成结果。

> **2026-09-27 本地集成：第三阶段分镜创作**
> 新版V4内核已接入3008，界面沿用本工作台Soft Iris体系。使用与验证见 [第三阶段说明](docs/3008-STAGE3-WORKBENCH.md)。用户现已要求进入上游重构：原1.5显示改称“第二阶段 · 资产形象设计”；职责与格式借鉴见 [第一/第二阶段反推分析](docs/3008-UPSTREAM-REFACTOR-DESIGN.md)。不代表完整重构、提交、发布或真实成片验收已完成。

> **2026-09-25：阶段 1 + 1.5 开发交接版（非稳定发布）**
> Mac 请先读 [完整框架、更新说明及未解决问题](docs/3008-STAGE1-15-HANDOFF-20260925.md)。使用 `handoff/3008-stage1.5`，供重新整合参考；不合入或覆盖 main。启动使用 `npm run dev:3008`。

**历史分镜岗位设计入口：[第一阶段输入与交接说明](docs/3008-STAGE2-INPUT-GUIDE.md)。** 此历史文档中的“第二阶段”指现第三阶段分镜，不是现资产第二阶段；保留原协议和能力边界，新重构以反推分析及当前代码为准。

> **3008 独立开发交接分支（2026-09-12）**：本分支保存 P1–P4 第一阶段、原稿结构检查、外部保真导入与按场交接。继续开发请先读 [3008 完整说明与 Mac 接续](docs/3008-MAC-HANDOFF.md)，使用 `.env.3008.example`，不要照下方历史3000入口启动。源码不含私人数据库、凭据和剧本；macOS 尚未实机验收。本次推送不合并 main，也不发布网站。

把剧本转换为项目策划、资产索引、结构化分镜表和 Seedance 单元提示词。仓库包含完整本地版、岗位规则、数据库迁移与用户确认的 3180 设计案例。

**换电脑接着做：先读本页，再看 [Mac 安装与数据迁移](docs/LOCAL-SETUP-MAC.md) 和 [2026-09-05 交接说明](docs/HANDOFF-2026-09-05.md)。**

## 代码与版本

| 入口 | 内容 |
| --- | --- |
| [`handoff/3008-v2026.10.20.1`](https://github.com/K1rsam/director-web/tree/handoff/3008-v2026.10.20.1) | 最新 3008 交接版：连续制作与安全恢复、表现偏好、系统表现及 v6.5 适配；按本版说明更新 |
| [`handoff/3008-v2026.10.03.2`](https://github.com/K1rsam/director-web/tree/handoff/3008-v2026.10.03.2) | 历史 3008 更新版本，保留原分支及当时说明 |
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
