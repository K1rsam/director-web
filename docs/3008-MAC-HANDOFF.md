# 3008 独立工作台与 Mac 接手说明

**在 Mac 设计第二阶段岗位提示词，先读：[第一阶段提供哪些信息及如何取用](3008-STAGE2-INPUT-GUIDE.md)。** 包含字段字典、事实与状态能力边界、集场权限、输入精简建议及可复用的设计任务说明。

更新：2026-09-14。继续本轮原稿接收、第一阶段资料整理和逐场交接，请使用 `handoff/3008-stage1-20260912`，不要按旧 Mac 文档切回 `main` 或 `handoff/windows-local-20260905`。最新内部修复机制与验收边界见 [岗位交接与自动修复](3008-WORKFLOW-AUTO-REPAIR.md)。

本分支保存 3008 的源码、规则、迁移脚本和验证工具。它是独立开发交接版本，不代表已合入 main、已发布 Sites，或已完成第二阶段图像/视频制作。3000 和 Sites 的数据不随本分支同步。

最新现场修复：[Q1 成功后落库冲突与等待选择重复修复](3008-CHOICE-COLLISION-20260914.md)。包含真实 30 集已付费结果的零新增调用恢复证据，以及此前遗漏的岗位状态转换回归。

最新检查：[场头、运行卡片、通用事项权限与输入量](3008-HEADER-PROGRESS-SCOPE-AUDIT.md)。包含对象/字段/集场联合校验、共享素材边界、旧事项兼容，以及维护重启误停后台任务的修复；区分字符数与实际 token 用量。

重复运行专项：[自动修复与重复请求检查](3008-LOOP-AUDIT-20260914.md)。修复问题说明漂移、缺回执无限普通续作、长片段保存后自失效；包含真实控制器及任务重建反例。

来源误报：[重复集标题造成假待确认](3008-SOURCE-HEADING-FALSE-BLOCK.md)。9-14-3没有真正人工事项；程序修复后已零新增AI调用收尾，不再要求用户确认格式标题。

P1 请求预算：[重复诊断膨胀修复](3008-P1-ISSUE-COMPACTION-20260914.md)。9-14-4 第二批完整请求由 180248 降至 74813 字符，正文块与诊断关联保持一致；离线恢复回归通过，真实项目备份后已恢复至 P1 2/4，第二批已发送，第一批仍仅调用一次。记录时尚未完成全流程或模型结果验收。

## 1. 当前功能及操作路径

界面阶段编号与历史内部岗位编号并非一一对应。阅读新页面以当前流程为准，排查日志同时核对内部 F1/F2/Q1 与 phase，避免只按旧文件里的 P1/P2 名称判断。

| 阶段 | 当前行为 | 关键边界 |
| --- | --- | --- |
| 接收与程序初检 | 上传或粘贴原稿，或选择“已清洗”；预览后创建项目 | 程序初检不是 AI 检查；旧 DOC 先另存 DOCX |
| P1 原文结构检查 | 原稿点击“整理资料”后，由模型按完整原文块分批通读，提出归属、称呼与疑问候选；来源页展示进度、原文及规范化结构 | 即使初检无疑点仍检查全文；剧情、动作、台词和说话人正文保留；已清洗及旧项目不自动重复全文检查 |
| P2 拆集分场 | 从不可变原文物化集场结构，复用 P1 候选与机械事实索引 | 相邻同集同场声明合并；真实第 0 集不自动当资料；未知场界不伪造成整集一场 |
| P3 素材提取与资料核对 | 提取资产与必要变体，Q1 输出修改差异；处理有证据的位置、影响范围和用户决定 | 候选不等于事实，也不全变成阻断；长集分片、短集合批依原文顺序；单场确认只重查受影响片 |
| P4 交接就绪 | 提供逐场交接与后续任务包，保留第二阶段待办 | 场级决定只进入匹配场；明确全局需理由，不明范围不广播；就绪不表示所有内容待办均已裁定 |

机械事实缓存依赖原文、作者资料与名称/别名版本；不能为缩小输入丢失必要身份链、伤愈、闪回或前接状态依据。运行日志与内容版本原子写入；成功且没有 UNKNOWN 的页面轮询可复用缓存，失败、活跃、UNKNOWN 与无版本旧日志继续读取真实状态。

## 2. 外部 AI 清洗：两种文本协议

推荐先上传原稿，在“让其他 AI 整理”生成并复制材料，再将 AI 返回内容与原稿配对接收。外部 AI 不需要生成文件或手算 hash。协议细节见 [external-text.md](../.agents/skills/screenplay-fidelity/references/external-text.md) 与 [contract.md](../.agents/skills/screenplay-fidelity/references/contract.md)。

- **FIDELITY-TEXT/1**：AI 返回短块的归属计划，程序从不可变原文块复制正文。适合从本程序导出的材料开始整理。
- **FIDELITY-DRAFT/1**：AI 返回带归属标记的完整稿，程序配对原稿并验证保真。适合已有外部清洗全文再接入。

支持粘贴文本、TXT/MD/DOCX，兼容既有 JSON/ZIP 包。配对提取、完整性比对与按标记拆分由程序完成，不再次全文调用模型。无标记的普通稿与原稿须逐字匹配；不能承诺任意 AI 自由格式都可自动接收。

只有清洗稿、没有原稿时，基准仅为本次清洗稿，无法证明外部 AI 没有改字。校验覆盖改字、说话人变化、漏段、重复、错序、标记冲突、Unicode、换行差异和旧来源拒绝。换原稿后按新来源验收，跨不同原稿版本的局部增量迁移尚未实现。

## 3. 在 Mac 从空数据库启动

准备 Git、Node.js 24.x、npm 和 Python 3。仓库 `.nvmrc` 指定 Node 版本；使用 nvm 时可运行 `nvm install && nvm use`。Apple Silicon 与 Intel Mac 均在本机重新安装依赖和生成 Prisma Client，不复制 Windows 的 node_modules、.next 或可执行文件。

```bash
git clone --branch handoff/3008-stage1-20260912 https://github.com/K1rsam/director-web.git director-web-3008
cd director-web-3008
git status
git log -5 --oneline
node --version
python3 --version
npm ci
cp .env.3008.example .env
```

编辑本机 `.env`：填写随机 32 字符以上的 `DIRECTOR_CREDENTIAL_KEY`，以及自己保存的 `TEST_ACCOUNT_INITIAL_PASSWORD`。生成密钥可用：

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

然后运行：

```bash
npm run prisma:generate
npm run database:migrate
npm run accounts:seed
npm run dev -- --hostname 127.0.0.1 --port 3008
```

打开 `http://127.0.0.1:3008`，用 `tester01` 与自定密码登录。seed 创建 tester01–tester05 私有测试账号，已有账号不重复创建。数据库默认是 `prisma/dev.db`，不是仓库根目录 dev.db；`DATABASE_URL` 的相对路径基于 Prisma schema 目录。

**端口本身不会隔离 Cookie。** 示例设置 `DIRECTOR_SESSION_COOKIE_NAME="director_session_3008"`；并行启动其他工作台时，各自使用不同 Cookie 名和独立数据库，避免同主机不同端口互相覆盖会话。不要混用 localhost 与 127.0.0.1 登录地址。

本轮第一阶段实测使用 **gpt-6-astra / low**。示例 env 显式覆盖 CLI 默认和 F1/F2/Q1 岗位；源码部分历史默认仍是 gpt-5.6 系列/high，不能只克隆仓库就假定配置一致。项目选择 CLI 模式；在 Mac 自行安装并登录 Codex CLI，从“所有项目 → CLI 与 API”检查连接。API 模式另走供应商配置，不等于上述模型验证。

清除旧电脑 CODEX_CLI_PATH、CODEX_SKILLS_DIR、DIRECTOR_KNOWLEDGE_BASE_DIR 等绝对路径，确需设置时改成 Mac 实际路径。Python 适配器默认执行 python3；自定义解释器可用 PYTHON 环境变量。

## 4. 私人数据迁移与后续更新

**源码不包含私人数据库、账号记录、剧本原稿、API Key、登录状态或现场日志。** 新建空库不会自动出现旧项目。需要接续原数据时，采用私人加密存储或自己的移动介质，不把数据提交到 Git。

1. 原电脑等待任务完成或在界面停止任务，再关闭 3008 服务。在对应 3008 项目目录执行 `npm run database:backup`，得到 local-backups 下的一致性 SQLite 副本。
2. 私下携带备份与原 `DIRECTOR_CREDENTIAL_KEY`，以及需要的仓库外原稿/媒体。数据库不等于所有外部素材的备份；不要仅复制运行中的数据库而遗漏 WAL。
3. Mac 安装源码依赖，将备份放到配置所指数据库位置；已有有用数据库先另做备份，不直接覆盖。保留原加密 key，否则原加密 API 凭证无法解密。
4. 执行 `npm run prisma:generate`、`npm run database:migrate`，再按 3008 命令启动。用原账号密码登录，**无需再次 seed**。进程与运行中任务不会随数据库搬走，先检查状态再继续。

继续优化先创建自己的分支，例如 `git switch -c improve/mac-3008`。拉取前提交自己的修改，更新后重新安装依赖、生成 Prisma Client，并在停服及备份后迁移数据库。不要把本地 Prisma/CLI 代码直接覆盖到 sites-online；平台边界见 `.platform/platform-boundaries.json`。

## 5. 已有验收与重验清单

以下是 2026-09-12 Windows 实施验收摘要，源自本地实施记录；私人运行证据和用户原稿没有随源码发布。**Mac 尚未实机验证。** 这份交接文档本身不把历史检查当成本次重新执行，也不将静态通过视为所有剧本和生成结果均正确。

| 已执行范围 | 记录结论 |
| --- | --- |
| 真实小样 P1/F2/Q1 | 各调用一次，gpt-6-astra/low；全链 COMPLETE、documentReady=true，保留伤势延续与交还动作 |
| 最终紧凑 P1 真实小样 | 仅允许一次 P1，receipt COMPLETE、原文不变；后续被测试调用上限停止，整任务 PARTIAL，不算第二次全链完成 |
| 浏览器隔离测试 | 上传、预览、创建、外部材料、粘贴计划配对、来源页、下载、交接选择与会话隔离；最终浏览器页面错误 0，原文回读一致 |
| 协议及兼容 | 正反例、换行/Unicode、未知归属、第 0 集、旧 v1/v2/ZIP 回归通过 |
| 控制器与费用保护 | 零集启动、检查点恢复、停止后拒写、手动确认保留证据；付费响应保存失败后恢复不增加调用，UNKNOWN 不自动重发 |
| 长短混合与交接 | 短集 1 → 长集 2 所有片 → 短集 3/4；前接状态供给、局部重查、范围/身份依赖、场级任务包及过期来源校验通过 |
| 工程检查 | TypeScript、生产构建、34 项调用保护及相关费用/事实/证据回归通过；构建有 4 条既存 CLI 动态路径追踪警告 |

另外，私人配对样本的文本/JSON 两种接收均得到相同的 59,870 字符、70 集版本，模型调用 0 次。另一 DOCX 默认段落读取视图为 62,689 字符，差异来自读取/分隔视图，不能称为增加剧情。P1 三批请求字符量由 376,924 降到 159,865（57.59%），这是请求字符量，不是实测 token、费用或耗时下降比例，也不能推算整剧耗时。

Mac 首次启动后，先在隔离测试数据中重验：

```bash
npm run typecheck
npm run verify:ui
npm run verify:database-migration
node .agents/skills/screenplay-fidelity/scripts/fidelity.test.mjs
node --env-file=.env --import tsx scripts/verify-fidelity-external.ts
node --env-file=.env --import tsx scripts/verify-fidelity-p1-review.ts
node --env-file=.env --import tsx scripts/verify-scoped-choice-handoff.ts
node --env-file=.env --import tsx scripts/verify-foundation-mixed-fragments.ts
npm run build
```

按具体改动扩大检查，见 package.json 与 scripts/verify-*。涉及数据库的验证应先阅读脚本、确认其隔离方式；不要对唯一私人数据库尝试修复脚本。真实服务验证（如 verify:codex-cli:live、verify:deepseek-api、verify-five-step-live-bounded.ts）会产生实际调用，日常页面检查不需要执行它们。

人工检查原稿与已清洗两条路径、保真失败反馈、来源页原文、结构前后对照、待办范围、下载及复制完整性；再在 Safari/Chrome、100% 缩放、常规与较窄窗口、文字放大和减少动画模式下检查布局与交互。涉及整剧时先做有调用上限的小样。

## 6. 后续优化入口和保留事项

| 方向 | 代码入口 | 接续要点 |
| --- | --- | --- |
| 外部接收/保真 | lib/fidelity-external.ts、fidelity-import.ts、fidelity-package.ts；.agents/skills/screenplay-fidelity/ | 保留原文验证与协议版本拒绝；自由格式兼容需新增明确契约及反例 |
| P1 全文检查 | lib/fidelity-p1-review.ts、fidelity-source-assist.ts、fidelity-refresh.ts、fidelity-review-candidates.ts | 保留检查点、手工决定、原文证据及完整块覆盖 |
| 分片、事实与成本 | lib/foundation-delivery.ts、foundation-fragments.ts、foundation-fragment-work.ts、foundation-facts.ts、foundation-fact-cache.ts | 优化前后都验证长短顺序、身份依赖、前接状态和付费响应恢复 |
| 范围与交接 | lib/foundation-application-scope.ts、foundation-choice-store.ts、episode-pipeline.ts；app/projects/[projectId]/foundation/handoff/ | 场级/跨集/全局/未决不能混为一类；不静默丢弃旧源、假场号和越界证据 |
| 来源页与第一阶段界面 | app/projects/[projectId]/source/、foundation-delivery-panel.tsx、foundation-viewer.tsx | 以 DESIGN.md 为视觉规范，改正式页面并验证长文本，勿只改 3180 示例 |
| 会话与跨平台 | lib/auth.ts、scripts/migrate-database.ts、scripts/backup-local-database.ts、.env.3008.example | Mac 路径、Python、Prisma 和 Cookie 隔离需现场验证 |

优先补 Mac 实机启动与浏览器验收，再根据真实使用反馈优化阅读密度、错误定位和待办说明。跨原稿版本增量迁移仍待实现；无依据的作者资料关联和历史状态解除不能自动假定解决；无版本旧日志保守处理。后续图像、视频生成及成片质量不在本轮通过范围。

## 7. 本次仓库交接复核

2026-09-12 推送前重新执行：TypeScript 类型检查、外部保真协议正反例、场级交接、紧凑 P1 请求验证均通过。Windows 的协议测试需要加载本机 `.env` 中的 Python 路径；Mac 按模板使用 python3。提交范围已排除私人数据库、实际 `.env`、上传文件、现场日志与一次性私人样本审计脚本；本机配置中的真实密钥/密码逐值扫描未命中提交内容。归档的第三方参考材料保留原样，仍按各自授权及私有研究边界使用。

可选私人样本审计使用 `QA_PROJECT_ID` 或 `QA_SOURCE_FILE` 指向自己的测试项目/原稿；默认离线验证不需要原用户的数据。这些变量不应填写到提交文件。

最新修复：[Q1 格式修复请求超预算：原因、修复与恢复边界](3008-REPAIR-BUDGET-FIX.md)。

2026-09-14 更新：[风险修复与主控复检](3008-RISK-FIXES-20260914.md)，涵盖补丁中断恢复、任务假忙、导入包装兼容、局部输入和交接缓存。完全损坏 JSON 已改为保留响应并停止，不再走大包修复。

追加：[P1 剧名前重复零集标题误阻断修复](3008-TITLE-BOUNDARY-FIX-20260914.md)。

源头补修：[边界提示生成与标题识别修复](3008-SOURCE-DIAGNOSTIC-ROOT-FIX.md)。fidelity/3 兼容场N-M、同集场同行和明确双行场头；真实原稿82集保持不变，0→192场、2785→0边界提示，原文块逐项不变。第四批称呼候选阻断现已修复并复用原响应，P1四批完成；当前素材整理运行中，见文末候选恢复说明。

P1候选恢复：[无效称呼候选隔离与结构问题分流](3008-P1-CANDIDATE-RECOVERY.md)。9-14-4第四批已复用原返回，真实P1四批完成，零新增P1请求；已进入素材整理。跳号等疑问保留并按范围传递，不补稿、不宣称疑问已经解决。此状态取代上文第四批暂停记录，后续阶段尚未全程验收。

确认后反馈：[待确认数量与下一项入口](3008-CHOICE-WAIT-FEEDBACK.md)。9-14-5已确认的14集选择已实际应用，现等待其余5项；修复了固定“自动继续”提示与缺少提交反馈的问题。26项离线UI检查通过，本轮无真实浏览器点击验收。

交互更新：[连续保存选择，最后统一应用](3008-CHOICE-COLLECTION.md)。取代此前“每确认一项立刻运行”的行为：保存中间项不启动任务，最后一项才启动整理。原选择、局部权限与回执复用保留；后台处理仍可能分批调用模型。

确认后误拦截修复：[优化改名与自动纠正](3008-DECISION-RENAME-RECOVERY.md)。优化补丁省略别名时保持原值；合法纠正完整复验，复用已返回结果。

岗位流程主入口：[岗位执行与交接重构](3008-ROLE-WORKFLOW-REFACTOR.md)。本轮验收以泛化岗位行为和隔离故障注入为准，不以恢复业务测试稿作为交付目标。

P1 合入修复：[整集归属覆盖纯标题](3008-P1-OWNERSHIP-MERGE-FIX.md)。新增旧付费检查点的零调用恢复回归，保留真实缺场等反例。

岗位交接补修：[P1 派生集索引迁移](3008-P1-DERIVED-INDEX-MIGRATION.md)。验收覆盖隔离数据库的结构保存、连续刷新、历史保留和人工资料保护，并修正技术暂停的状态显示。

正式导入契约补修：[P1 精简来源快照兼容](3008-P1-COMPACT-SOURCE-FIX.md)。新增从正式 importParsedProject 创建项目开始的组合回归，避免手工测试快照与实际存储格式不一致。

历史显示：[运行状态与岗位耗时](3008-HISTORY-STATUS-DURATION.md)。成功执行与工作稿就绪分开，同任务内分批耗时和用量一致汇总。

交接规则纠偏：[检索未关联与生产阻断分离](3008-RETRIEVAL-HANDOFF-FIX.md)。匿名背景保留供岗位阅读，只有实际来源缺口或有据制作问题影响就绪，且总态与分集一致。

完成状态：[第一阶段收口](3008-COMPLETION-RECONCILIATION.md)。P4不等待第二阶段；当前交付就绪与历史任务状态分离。

角色子形象方法更新见 [必要角色造型覆盖与数量控制](3008-CHARACTER-VARIANT-COVERAGE.md)。
