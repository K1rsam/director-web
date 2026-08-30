# Seedance 导演工作台：项目全过程与交接文档

> 更新时间：2026-08-30
> 适用对象：产品负责人、接手开发者、测试人员、部署维护人员  
> 结论基于四个指定 Codex 任务、两个实际代码库、Git 历史、数据库结构及 Sites 当前状态交叉核对。

## 1. 一页摘要

本项目把影视剧本转成可交付给 Seedance 的结构化生产资料，核心产物包括：

1. 全剧策划与项目圣经；
2. 人物、场景、道具、非人资产索引；
3. 逐集、逐场、逐镜的结构化分镜表；
4. 按不超过约 15 秒组织的 Seedance 单元提示词；
5. 坐标化问题卡、返修记录和可追溯版本。

项目已经形成两套代码：

| 代码库 | 定位 | 当前状态 |
|---|---|---|
| `director-web`（GitHub `main`） | 本地完整生产版 | P1–P2、E0–E5、DeepSeek API、Codex CLI、SQLite、账号隔离均已实现；共用 Sites Runner 镜像已同步 |
| `director-workbench-sites`（Sites） | Sites 云端版 | 原页面、账号、21 张业务表、D1、D1 快照任务和设备 Runner 已上线；真实剧集生产仍需单任务端到端验收 |

线上地址：<https://director-workbench-yue.a8197772.chatgpt.site>

截至 2026-08-30，线上已部署第 26 版，对应 `director-workbench-sites` 提交 `b664121`，访问策略为公开链接，业务数据仍由应用账号隔离。

最重要的当前判断：

- 本地版是“能真正生产”的版本。
- Sites 版是“能登录、浏览、建项目、查看迁移数据、配置 API/CLI 连接并创建 D1 快照任务”的版本。
- Sites 版的 P1–P2、E0–E5 已接入任务快照与设备 Runner 协议，但本次没有启动真实剧集任务，因此不能把协议/构建通过当成真实分镜生产闭环已验收。

## 2. 产品目标、边界与原则

### 2.1 产品目标

将用户剧本稳定转换为：

```text
剧本
  → 全剧策划 / 项目圣经
  → 资产拆解
  → 单集叙事节奏
  → 分镜结构
  → 表演调度
  → Seedance 单元视听
  → 摄影光影
  → 审查、返修、编译
  → 可复制 / 可导出的 Seedance 提示词
```

目标不是生成或剪辑视频，而是把模型最容易误解的时间、动作、资产、镜头顺序和上下文提前结构化，降低 Seedance 自行猜测带来的不稳定。

### 2.2 已明确的创作原则

- 动作可以拆得更细，让每镜有明确动作或状态变化，而不是简单追求少镜头。
- “节奏拖拉”主要看每个动作分配的秒数、停顿和重复反应，不以镜头数量直接判断。
- 分镜表是唯一事实源；模型不得整表随意重写。
- 模型负责创作判断，Python 负责编号、时长、覆盖、顺序、绑定、坐标等确定性规则。
- E1–E4 各自只修改自己拥有的字段，E5 只审查，不承担创作补写。
- 返修应按问题责任岗位局部路由；结构变化才向下游级联，不增设“万能返修岗位”。

## 3. 项目发展全过程

### 阶段 A：最初本地生产线与 DeepSeek 阶段

项目最早在另一个 Codex 任务中建立，额度不足后迁移到 DeepSeek Harness 继续开发。2026-08-20 的接手任务读取了：

- 原 Codex 会话约 218 个回合；
- DeepSeek Harness 约 94 个回合、69,259 条事件；
- `ai-context` 交接包和当时的 SQLite 数据。

这一阶段完成了本地 Next.js + Prisma + SQLite 应用，以及剧本导入、全剧策划、资产拆解、分镜生产、Seedance 单元、问题卡和版本管理。

流程早期曾是 E1–E5，经过大量质量回归后增加 E0 叙事节奏岗位，最终稳定为 E0–E5。早期文档中 E3/E4 的职责曾经相反；当前权威顺序以代码和 README 为准：

```text
E0 叙事节奏
E1 结构导演
E2 表演调度
E3 单元视听
E4 摄影光影
E5 审查总控
```

### 阶段 B：Codex CLI 接入与 API/CLI 语义对齐（2026-08-20）

项目原来主要通过 DeepSeek API 执行，随后补齐 Codex CLI 模式。

关键实现：

- 检测 `codex --version` 和本机 app-server 登录态；未登录时提示在终端运行 `codex` 完成登录；
- 通过 `codex exec` 执行岗位并解析 JSONL；
- 保存岗位会话 ID，支持局部返修续接；
- 全量运行使用新会话，避免旧上下文污染；
- E0 使用临时会话；E5 使用独立新会话；
- 重置剧集时同时清理 API 与 CLI 会话；
- 批次锁定 API/CLI 执行模式；
- 支持超时、停止和真实 CLI 冒烟入口。

当时默认配置为：

- E0–E4、P1/P2：`gpt-5.6-terra`，推理强度 `high`；
- E5：`gpt-5.6-sol`，推理强度 `high`；
- 环境变量可覆盖模型和推理等级。

首次 P1 CLI 失败表面显示“模型刷新超时”，实际根因是发送给 Codex 的通用 JSON Schema 不符合严格格式，错误展示又抓取了无关警告。修复后，复杂岗位改为提示词约束 JSON + 防御性解析，并优先展示 stdout 中的真实结构化错误。

### 阶段 C：E0–E5 质量硬化与确定性层（2026-08-20 至 08-21）

对真实第 12 集进行 API/CLI 对比后确认：输出问题主要来自程序和跨岗位契约，而不是单纯模型能力。

重点修复包括：

- 视觉步骤从单一 Step 改为 `Beat + Step` 复合定位，消除跨 Beat 串线；
- 源节点顺序、镜内节点顺序、跨节点混镜机械校验；
- 对白说话人、OS/VO、动作型伪说话人统一规范；
- 台词锚点、切片、字速和镜头时长归正；
- 镜头拆分后的子镜继承父镜创作字段；
- 人物、声音、道具和特殊实体按资产码去重、补绑定；
- 单元开始前提、结束状态、时间窗口与未来实体泄漏检查；
- 光影状态机、光源因果和单元光影完整性；
- 编译提示词中的 `$1`、`undefined`、`null`、占位文本拦截；
- E5 输入在 E4 后重新读库，防止审查旧数据；
- E5 模型问题必须有 Python 事实层佐证，减少模型复读旧卡和幻觉阻断；
- 返修前建立快照；真回归才回滚，存量问题不误回滚；
- 返修范围按全部开放问题坐标而非仅 BLOCKER 判定，避免合法 MAJOR 修复被当成越界。

最终形成的返修策略：

| 问题类型 | 处理方式 |
|---|---|
| 解析、绑定、陈旧状态 | Python 修复 → 重新编译 → 新鲜 E5；零模型调用 |
| 单岗位单元格错误 | 原岗位局部修复 → E5 |
| E2 表演变化 | 局部 E2 → 受影响单元 E3/E4 → E5 |
| E1 镜号、时长、节点变化 | 受影响 Beat 从 E1 向下局部级联 |
| E0 或源文结构变化 | 受影响 Sequence 从 E1–E5 重算 |

这一轮还明确了 Seedance 时间表达应尽量写成镜内时间段，例如“0–1.8 秒递牌、1.8–3.5 秒核验”，减少下游模型自行分配。

### 阶段 D：Vision Studio 全站 UI 重构（2026-08-21）

旧界面深色残留多、层级混乱、导航和操作不直观。经过多轮实机反馈，最终视觉方向定为浅色冷白 + 蓝紫环境光 + iOS 毛玻璃的 `Vision Studio`。

完成的交互重构：

- 固定左侧导航、悬浮顶部栏和统一页面层级；
- 项目卡整卡可点击，悬停上浮；
- P0–P3 与 E0–E5 统一为岗位状态卡；
- 单岗位运行、整集生成、重跑、停止显示真实范围；
- 危险操作集中到维护区并二次确认；
- 全剧、单集、表格、Seedance、问题区统一玻璃容器和状态色；
- 项目页 → 全剧工作台 → 单集工作台采用 Shared Axis 横移转场；
- 单集进入专业工作区模式，只保留主工作区一个滚动层；
- E0–E5 状态默认展开，失败、运行、完成均不自动收起，用户可手动收起。

顶部 14px 悬浮边距经历了三次方案调整。最终方案不是关闭浏览器回弹，也不是让导航硬贴顶，而是：

- 保留 14px 悬浮间距、圆角和阴影；
- 恢复浏览器原生回弹；
- 根背景与页面使用同一连续蓝紫渐变；
- 回弹或顶部露出时不再出现黑条、灰条或异色底。

### 阶段 E：GitHub 私有发布与本地账号隔离（2026-08-24）

本地完整版上传到私有仓库：<https://github.com/K1rsam/director-web>

为了五台设备测试，先做了最小账号系统：

- `tester01`–`tester05` 五个预置测试账号；
- 不开放注册、找回密码和账号后台；
- 密码只存哈希；
- 登录会话默认 30 天；
- 历史无归属项目统一分配给 `tester01`；
- 项目读取、修改、删除、导出均在服务端检查当前用户归属；
- 访问其他账号项目统一表现为“项目不存在”。

本地库当前实查：7 个项目、5 个用户、28 集、717 镜、188 个单元、1,793 条问题记录、462 条流水线记录。测试账号使用过弱临时密码，公开交接时必须另行安全传递并立即轮换，不应写入公开文档或源码。

### 阶段 F：账号 + 设备 Runner 大规模实现，但未闭环（2026-08-24）

随后尝试实现：

- API Key 按账号加密保存；
- CLI 按账号 + 当前设备绑定；
- 一次性配对码；
- Runner 设备令牌、租约、心跳、任务队列和回传；
- 任务锁定用户、项目、设备和执行方式；
- 跨平台本地 Runner；
- 设置页、连接测试、删除和撤销。

这一阶段出现严重过度工程化：主任务加 29 个子代理，约 3.73 亿 tokens，大量时间用于双重复审、竞态、租约、安全边界和测试矩阵，用户最需要的设置页与真实 E0 闭环反而没有完成。

当前遗留在：

```text
/Users/yue/Documents/CL/.worktrees/device-connections
```

状态：

- 分支 `feature/device-connections`，比 `main` 多 26 个提交；
- 约 16,379 行新增；
- 仍有 21 个未提交路径；
- 没有合并到 `main`，也没有推送到 GitHub 主分支；
- 包含可复用的加密、配对、Runner、租约和路由实现，但不能直接合并。

必须把它视为“研究性实现和代码素材”，不是当前发布版本。

### 阶段 G：参考成熟应用，重新确定 CLI 架构（2026-08-24）

对 SHUO Canvas 和 Cockpit Tools 的实现进行对照后，结论是：连接 Codex CLI 不要求先做完整 GUI，真正必要的是本地执行进程。

SHUO Canvas 的可复用模式：

1. 桌面程序把 Codex 路径加入 PATH；
2. 启动仅本机访问的后端；
3. 网页调用本地 API；
4. 后端执行 `codex exec --json`；
5. 本地请求携带随机令牌。

Cockpit Tools 更偏多账号、`CODEX_HOME`、本地代理和实例管理，只建议借鉴进程管理、端口令牌、自动启动和更新，不应照搬 OAuth/Token 代理。

项目最终采用的方向：

```text
线上网页 + 云数据库 + 任务队列
             ↕ HTTPS 配对 / 领任务 / 回传
        本地无界面 Runner
             ↓
      用户自己的 Codex CLI + Skill
```

Runner 主动轮询云端，不让线上网页直接请求用户 `localhost`。协议稳定后再用 Tauri/Electron 包装托盘 GUI。

### 阶段 H：纯 Sites + D1 + Runner 上线（2026-08-25）

为尽快上线，创建了独立的 Sites 项目 checkout `director-workbench-sites`。

第一次上线只做了 Runner 控制原型，使用 ChatGPT 登录，只有 3 张控制表，且页面不是原项目。用户指出这既不是原 UI，也无法新建并进入项目，因此方向被推翻。

第二次按原项目 1:1 复刻：

- Sites 改为公开入口，不再强制 GPT 登录；
- 恢复应用自己的用户名/密码登录；
- 迁移原项目 21 张业务表和当时约 4,568 条数据；
- 恢复项目库、新建项目、全剧工作台和单集工作台；
- Runner 绑定到应用账号，不再绑定 ChatGPT 用户 ID；
- 修复 Cloudflare PBKDF2 迭代上限导致的旧密码不可验证问题；
- 重做 1080P/2K/4K 响应式字号、表格和页面间距；
- 使用唯一固定全屏底图，解决 Windows/Mac 顶部 14px 色差；
- Runner 页最终复用主站 AppChrome、悬浮顶栏、侧栏和玻璃卡片；
- 所有 Logo 的“镜”改为 “L”。

第 4 个任务没有留下最终答复；随后线上已从第 13 版持续推进到第 26 版，当前源仓库提交为 `b664121`，线上地址和公开访问均有效。

## 4. 当前业务工作流

### 4.1 全剧阶段

| 阶段 | 责任 | 主要产物 |
|---|---|---|
| P0 Python | 剧本预处理、拆集、拆场、源节点标准化 | 结构化剧本节点 |
| P1 全剧基础策划 | 通读全剧，建立项目圣经、表现规范待确认清单、场次时间/内外 | 项目记忆、策划、场次信息 |
| P2 全剧资产拆解 | 人物、群像、非人、场景、道具、状态变体编号 | 资产索引与绑定 |
| P3 Python | 确定性校验 | 可进入单集生产的稳定数据 |

### 4.2 单集阶段

| 阶段 | 字段所有权与任务 | 主要产物 |
|---|---|---|
| E0 叙事节奏 | Sequence → Beat，设定因果链、戏剧功能、镜数与时长预算 | Beat 骨架与导演合同 |
| E1 结构导演 | 镜号、时长、画面目标、台词归属、源节点覆盖 | 分镜表骨架 |
| E2 表演调度 | 动作链、可见情绪、站位、视线与人物状态 | 表演字段 |
| E3 单元视听 | Python 分组后补声音、转场、单元前提/结束/目标 | Seedance 单元视听字段 |
| E4 摄影光影 | 单元布光、机位、景别、运镜、画幅变化 | 摄影与光影字段 |
| E5 审查总控 | Narrative / Generation / Aesthetic 三类审查 | 坐标化问题卡与放行结论 |

### 4.3 Python 确定性层

Python/TypeScript 机械层负责：

- 源节点覆盖和顺序；
- 镜号、时长、字速、对白切片；
- 单元不跨场、时长上限与镜头关系；
- 资产、说话人、特殊实体绑定；
- 光影状态、前后单元连续性和未来信息泄漏；
- 问题卡坐标、返修范围、快照回滚；
- 编译、版本和放行状态。

这是项目稳定性的核心。新增规则时，先判断它能否确定性计算；能机械判断的规则不要交给 E5 幻觉式裁决。

## 5. 当前技术架构

### 5.1 本地完整版 `CL`

```text
Next.js 16 UI / Server Actions
        ↓
Prisma 6 + 本地 SQLite
        ↓
岗位调度与确定性流水线
        ├─ DeepSeek API
        └─ 本机 codex exec + .agents/skills
```

特点：

- 功能最完整，真实 P1–P2、E0–E5 在这里运行；
- API Key 来自本机 `.env`；
- Codex CLI 使用本机登录；
- 数据写入本地 SQLite；
- GitHub `main` 当前为 `5c63758`；`public/runner/director-runner.mjs` 与 Sites 版共用同一份 Runner 镜像。

### 5.2 Sites 云端版 `director-workbench-sites`

```text
Sites / vinext / React
        ↓
应用账号与 D1
        ├─ 项目、剧集、分镜、单元、问题等 21 张业务表
        ├─ runner_tokens / runner_jobs
        └─ 两张早期 prototype 表（遗留）
```

特点：

- D1 绑定名为 `DB`，R2 尚未启用；
- 公开链接访问，应用内部仍要求业务账号登录；
- 当前数据库可见 21 张业务表、2 张正式 Runner 表和 2 张早期 prototype 表；
- 当前线上版本为第 26 版，Sites 源仓库 HEAD 为 `b664121`；本地构建与线上保存版本一致；
- Sites 源码已同步到 GitHub 私有仓库的独立 `sites-online` 分支，避免覆盖线下生产版 `main`。

### 5.3 当前 Runner

已经具备：

- 设备 Token；
- 用户归属校验；
- 轮询领取任务；
- 租约、心跳、成功/失败回传；
- `smoke`、`project_foundation`、`episode_pipeline` 命令映射；
- Windows 启动器与 Mac 启动命令入口；
- 设备撤销与最后在线时间。

当前尚未完成或尚未验收：

- 真实 P1/P2、E0–E5 尚未在本次检查中启动；
- 网页任务 → 当前设备 CLI → 结构化结果 → D1 的生产级端到端验收仍未完成；
- 停止、局部返修、重试、冲突和版本回写仍需云端端到端验收；
- 正式安装包、自动更新和托盘状态尚未产品化。

## 6. API 与 CLI 当前真实状态

### API

已完成：

- 用户填写自己的 DeepSeek Key；
- Key 保存在当前浏览器 `localStorage`；
- Sites 只在连接测试时临时转发；
- 服务端不写入 D1，也不回退使用站长 Key；
- 可调用 DeepSeek `/models` 验证连接。

未完成：

- P1–P2、E0–E5 实际 API 执行；
- 长任务的可靠后台调度；
- 页面关闭后继续执行。

关键架构矛盾：Key 只在浏览器中时，后台任务无法在用户离开页面后继续取得 Key。后续必须三选一：

1. Key 按账号加密存服务端，支持真正后台 API 任务；
2. API 也交给用户本地 Runner 执行，Key 永不上云，但电脑需在线；
3. 浏览器保持连接并临时转发，只适合短测试，不适合数分钟至数十分钟的 E0–E5。

### CLI

已完成：

- 用户使用自己的 Codex 登录和额度；
- 网页生成设备启动器/令牌；
- Runner 读取本机账号、额度、用量快照并按设备回传脱敏状态；
- Runner 可连接、领任务、心跳、回传；
- 网站不保存 ChatGPT 密码或 Codex 凭据。

未完成：

- 从网页点击某岗位到本机 CLI 真实执行，再把结构化分镜写回 D1 的完整闭环；
- 普通用户无需源码目录的正式安装包、自动更新和托盘状态；
- Windows/macOS 多设备端到端验收。

## 7. 代码与文档地图

### 本地完整版

| 位置 | 用途 |
|---|---|
| `/Users/yue/Documents/CL/README.md` | 本地启动、账号、验证说明 |
| `/Users/yue/Documents/CL/lib/episode-pipeline.ts` | E0–E5 主流水线 |
| `/Users/yue/Documents/CL/lib/episode-pipeline-quality.ts` | 确定性质量层 |
| `/Users/yue/Documents/CL/lib/role-runner.ts` | API/CLI 岗位调度 |
| `/Users/yue/Documents/CL/lib/codex-cli.ts` | `codex exec` 适配器 |
| `/Users/yue/Documents/CL/lib/project-foundation.ts` | P1/P2 全剧流程 |
| `/Users/yue/Documents/CL/prisma/schema.prisma` | 本地权威数据模型 |
| `/Users/yue/Documents/CL/.agents/skills/` | P1/P2、E0–E5 发布版 Skill |
| `/Users/yue/Documents/CL/docs/release-options.md` | 混合 SaaS 架构说明 |
| `/Users/yue/Documents/CL/ai-context/PROJECT_HANDOFF.md` | 早期历史交接；内容很丰富但时间停在 2026-08-16，不能当当前状态 |

### Sites 云端版

| 位置 | 用途 |
|---|---|
| `director-workbench-sites/app/` | 云端页面、账号和接口 |
| `director-workbench-sites/db/business-schema.ts` | 21 张业务表清单 |
| `director-workbench-sites/db/schema.ts` | Runner 控制表的 Drizzle 映射 |
| `director-workbench-sites/db/ensure-schema.ts` | Runner 表初始化 |
| `director-workbench-sites/lib/repositories/` | D1 项目/单集读写 |
| `director-workbench-sites/app/runner/` | API/CLI 连接设置页 |
| `director-workbench-sites/runner/` | 本地 Runner 轮询与命令执行 |
| `director-workbench-sites/public/runner/` | 用户下载的 Runner 启动文件 |
| `director-workbench-sites/tests/` | 当前云端版测试 |
| `director-workbench-sites/.openai/hosting.json` | Sites 项目与 D1 绑定；不要写入密钥 |

## 8. 当前完成度矩阵

| 能力 | 本地 `director-web` | 线上 `director-workbench-sites` |
|---|---|---|
| 项目/剧集浏览 | 已完成 | 已完成 |
| 新建项目 | 已完成 | 已完成 |
| 账号登录与项目隔离 | 已完成 | 已完成 |
| 21 张业务表 | SQLite 已完成 | D1 已迁移 |
| P1/P2 真实执行 | 已完成 | 已接入 D1 快照任务，未做真实端到端验收 |
| E0–E5 真实执行 | 已完成 | 已接入 D1 快照任务，未做真实端到端验收 |
| DeepSeek 连接 | 已完成 | 仅 Key 保存与连接测试 |
| Codex CLI | 已完成 | Runner 使用各设备自己的 CLI，并同步状态；业务闭环未验收 |
| 问题卡与局部返修 | 已完成 | 可查看/进入任务控制，云端返修闭环未验收 |
| 停止任务 | 本地已完成 | Runner 租约可回传，云端闭环未验收 |
| 导出 Seedance 提示词 | 已完成 | 可导出现有迁移结果 |
| 响应式 UI | 已完成 | 已完成并上线 |
| 外部源码备份 | GitHub 私有仓库 `main` | GitHub `sites-online` 分支 + Sites 源仓库 |

## 9. 已知风险与不要踩的坑

1. **不要把 Sites 协议说成真实生成已验收。** 页面和任务入口已接通，但本次没有启动真实剧集任务。
2. **不要直接合并 `feature/device-connections`。** 它规模大、仍有未提交文件，与后来的 `CL-sites` 架构已经分叉。
3. **不要让 Runner 直接把本地 SQLite 当云端事实源。** 必须定义任务包输入和 D1 结果回写协议。
4. **不要同时维护两个“权威数据库”。** 后续需明确 D1 是云端事实源，本地 SQLite 只是缓存/执行沙箱，或明确只做本地产品。
5. **不要继续扩展测试矩阵后再做用户闭环。** 先完成一个真实 E0，再补边缘条件。
6. **不要依赖旧 `ai-context/CURRENT_STATE.json`。** 它停在 2026-08-16，且与后续数据库状态不一致。
7. **测试账号密码过弱。** 公开测试前必须轮换，并通过安全渠道交接。
8. **API Key 放 `localStorage` 有 XSS 风险。** 这是当前 Beta 的便利方案，不是长期秘密存储方案。
9. **D1 中还保留 `prototype_projects`、`prototype_runner_jobs`。** 清理前先确认没有生产代码依赖。
10. **当前没有 R2。** 大文件、剧本原件、导出包和日志不应无限塞入 D1。
11. **Sites 源码与线下版架构分叉。** 更新 Sites 后同时推送 GitHub `sites-online` 分支；不要直接覆盖 `main`。
12. **用户离开页面后的 API 长任务仍无可靠方案。** 必须先决定 Key 的执行位置和存储策略。

## 10. 推荐的最小后续路线

### 里程碑 1：建立安全基线

1. 已完成：Sites 源码推送到 GitHub `sites-online` 分支。
2. 已完成：记录线上第 26 版及提交 `b664121` 为当前回滚基线。
3. 冻结 `CL` 的未完成设备分支，不继续追加功能，只挑选可复用代码。
4. 轮换测试账号密码，整理账号与 Sites 所有权交接清单。

验收：源码可恢复、线上可回滚、凭证不在代码和文档中。

### 里程碑 2：只打通一个真实 E0

推荐的数据协议：

```text
Sites 从 D1 生成不可变 TaskPackage
  → Runner 领取任务包、Skill 版本和输入快照
  → Runner 在隔离临时目录执行 E0
  → 回传结构化结果、日志摘要、版本和错误
  → Sites 校验结果后原子写入 D1
```

不要让 Runner 只拿 D1 的项目 ID 后直接改本机旧 SQLite；任务必须携带可验证输入，结果必须由 Sites 写回 D1。

首轮只支持：

- 一个账号；
- 一台设备；
- 一个项目；
- E0 单岗位；
- 一次只运行一个任务；
- 失败可见、可重试、可取消。

只保留三个必要验证：

1. A 账号不能读取 B 账号任务或结果；
2. A 设备不能领取 B 账号任务；
3. 网页发起 E0 → 本机 Codex 完成 → D1 显示结果。

### 里程碑 3：扩到完整 CLI 流水线

按 E0 → E1 → E2 → E3 → E4 → E5 顺序逐个接通；每接通一岗再验证字段所有权、失败停止和结果回写。之后再接 P1/P2、局部返修、停止和续跑。

### 里程碑 4：确定 API 长任务方案

在以下两种正式方案中二选一：

- 服务端加密保存用户 Key，使用持久任务执行器；
- API 也通过用户本地 Runner 执行。

不推荐依赖浏览器长期保持请求。决定后再接 P1–P2、E0–E5 API 执行。

### 里程碑 5：产品化 Runner

协议稳定后再做：

- Windows/macOS 安装包；
- 托盘状态；
- 自动启动；
- Codex 安装/登录/Skill 版本检测；
- 自动更新和诊断日志。

## 11. 新接手者操作清单

### 第一天先确认

- [ ] 能访问私有 GitHub `K1rsam/director-web`
- [ ] 能访问 Sites 项目“导演工作台”及 D1 数据库
- [ ] 知道 `director-web` 与 `director-workbench-sites` 的不同职责
- [ ] 知道 `feature/device-connections` 不能直接合并
- [ ] 知道线上任务入口已接通，但真实剧集闭环仍需单任务验收
- [ ] 已从安全渠道获得测试账号，不在聊天和仓库传播密码

### 本地完整版启动

```bash
cd /Users/yue/Documents/CL
npm ci
cp .env.example .env
npx prisma generate
npm run database:migrate
npm run dev
```

CLI 模式还需本机安装并登录 Codex；API 模式需在本机 `.env` 配置用户自己的 DeepSeek Key。

### Sites 版启动

```bash
cd /Users/yue/Documents/CL-sites
npm ci
npm run dev
```

### 常用验证

本地完整版：

```bash
npm run typecheck
npm run verify:all
npm run build
```

Sites 版：

```bash
npm test
npm run build
```

真实 CLI/API 冒烟会产生费用，应单独执行，不要混在普通回归中。

## 12. 交接时必须说明的五句话

1. 这是一个“剧本到 Seedance 分镜生产资料”的工具，不是视频生成器。
2. 本地 `director-web` 功能完整；线上 `director-workbench-sites` 已完成数据、页面、账号、Runner 和任务快照层。
3. 云端最大未完成项是“网页任务 → 用户本机执行 → 结果原子写回 D1”的真实端到端验收。
4. 旧设备分支投入很大但未闭环，不能因为代码多就默认采用。
5. 后续以真实 E0 闭环为第一优先级，不再先做大规模安全和测试扩展。

## 13. 本文来源

- `codex://threads/01a01e1b-46e6-7560-8e96-849b24a5e3e4`：DeepSeek/Codex 历史接手、CLI、E0–E5、UI 重构。
- `codex://threads/01a02825-9ef8-7d02-896e-0ea4b5f070df`：GitHub、发布架构、账号隔离、设备 Runner 大规模实施。
- `codex://threads/01a03211-5ecb-7441-ae20-3e36bc1d2850`：SHUO Canvas、Cockpit Tools 与本地 CLI 架构对照。
- `codex://threads/01a0365c-43a5-78e3-9150-6fe90611154e`：过度工程化复盘、纯 Sites+D1+Runner 上线、原项目复刻、响应式与连接层。
- `/Users/yue/Documents/CL`、`/Users/yue/Documents/CL-sites` 的当前代码、Git 历史和数据结构。
