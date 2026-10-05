# 验证记录

记录日期：2026-10-04。这里区分代码与离线检查、浏览器受控预览、本机工具检查、桌面运行和真实制作验收；任何一类通过都不替代其他类别。

## 当前结果

最新原文结构更新：完整 Rust **193 通过、0 失败、11 默认忽略**，前端契约15、第一/三阶段组件与回调24、新结构UI15项通过。实际461行原文快照在临时项目识别为10集21场，前24行资料归属修复，正文与哈希、集场身份及成员不变；重复操作不增版本。新版独立 release 的结构摘要、分集预览与背景阅读实际通过；浏览器示例1280×720和1080×720无横向溢出。本次所有模型和媒体生成请求0、生产数据库只读。见[说明](SOURCE_STRUCTURE.md)、[真实输入隔离核查](verification/source-structure-live.json)、[最新原生启动](verification/source-structure/native/report.json)与[整合记录](verification/source-structure/integration.json)。

前一次补齐第一至第三阶段 CLI 设置和自动预检，修复启动任务提示冲突。完整 Rust **186 通过、0 失败、10 默认忽略**；第一/三阶段组件与回调 **24 通过**，前端契约 **15 通过**、图片历史 **16 通过**、视频操作区 **24 通过**、文本 CLI 设置 **11 通过**。本机 Codex CLI 0.160.0 实际短文本执行 **1 次**成功，得到结构化结果和 8 条 JSONL 事件；复用接受缓存新增请求 **0**，当时图片/视频生成 **0**。该版本在开发服务关闭时实际独立启动通过，生产协议、内嵌界面、IPC、SQLite、图片和文本设置均通过；该启动诊断使用独立项目，生成 **0**。详情见 [CLI 补齐说明](TEXT_CLI_INTEGRATION.md)、[整合记录](verification/text-cli/integration.json)、[真实文本调用](verification/text-cli/live-transport.json)与[当时独立启动](verification/text-cli/native/report.json)。短文本通路不替代整集创作、真实网页登录、Mac 或视频作品验收。以下历史证据保留各自边界，不与本轮数值相加。

| 检查 | 已取得的证据 | 验证边界 |
| --- | --- | --- |
| Rust 核心离线测试 | 最新完整套件 **193 通过、0 失败、11 默认忽略**，见[完整输出](verification/source-structure/core-tests.txt) | 定向重复检查不累加；忽略项需指定环境；不代表完整真实渠道制作验收 |
| 前端契约测试与构建 | **15 项前端测试通过，前端构建通过**；工作流组件 SSR **17 项通过**、当前图片/历史 SSR **16 项通过**、第四阶段 SSR 与回调/生命周期离线重放 **24 项通过** | 实际组件使用合成项目；回放的请求被桩隔离，不代表真实桌面 IPC 或上游受理；[工作流组件](verification/workflow-ui-ssr.json)、[第四阶段记录](verification/video-preflight-toolbar.json)、[当前图片证据](verification/current-image-history.json) |
| 80 集排队与恢复 | 实际 Engine 经两条模拟渠道运行：78 downloaded、1 query_failed、1 submission_unknown；重启新增 submit **0** | 验证调度、局部失败隔离和原任务恢复；未产生真实渠道费用或可供人工画质验收的作品 |
| 元数据性能 | debug 构建，公开 `workspace.get` 加 JSON 序列化：全项目 p95 **62.9461 ms**；按集过滤 p95 **64.6365 ms**，分别 5 个样本 | 不含界面渲染、媒体解码、网络或模型等待；5 样本的 nearest-rank p95 就是该组最大观测值 |
| 浏览器布局 | 第一至第四阶段、任务、设置共 6 页；第四阶段新布局另核对 1440×940 与 1080×720，无横向溢出，参数栏只保留两个动作 | `?preview=1` 只读示例；[新版排版截图](screenshots/stage4-video-toolbar.png)不证明真实生成或完整桌面交互通过 |
| Codex CLI | 本机原生 CLI v0.160.0、`gpt-6.1-sol`、`medium`，通过 Rust 执行器实际短文本请求 1 次；结构化结果及 8 条 JSONL 事件保存，缓存复用新增请求 0 | 临时项目，生产数据库未访问；证明文本通路，不代表整集创作或真实重新登录验收；[调用报告](verification/text-cli/live-transport.json) |
| Dreamina CLI | 官方 CLI v1.4.19 当前帮助与现有会话只读账户检查通过；新 Engine 账户/无标签排队现场集成通过；已恢复用户原图并补选为当前图；更新客户端后另一张实际新图已下载、核对哈希、自动成为当前图，旧图保留精确关联历史 | 新图片测试由客户端既有明确生成流程发起，核验程序只读且未调用生成/查询。自动选图不代表人工画质验收，费用以任务记录为准。视频结构和恢复通过合成回归，未查询或下载真实官方视频；[历史回传](verification/dreamina-result-recovery.json)、[当前图与实际新图](verification/current-image-history.json) |
| ffprobe | 实际 MP4：15 秒、960×540、24 fps、H.264；实际 WAV：1 秒、16 kHz。坏容器、未知时长和封面图流等情况有检查 | 证明容器元数据及拒绝行为，不代表已经逐帧看画面或听声音 |
| Windows 当前开发运行 | 最新 `--no-bundle` release 构建和隔离原生启动通过，PE GUI 属性、界面/IPC/SQLite/图片协议核验见 [本轮视频操作区记录](verification/video-preflight-toolbar.json)；新版真实窗口的第四阶段已载入，仅准备与生成两个按钮 | 独立启动验证不启动调度器或访问真实账户；实际项目只导航到第四阶段，未点生成。生产任务、资产及当前图完整行不变，旧 NSIS 的 SHA 保持不变 |
| macOS | **未实机验证** | Win/Mac CI 检查流程已编写，不能据此声称 CI 已远程执行、Mac 已打包或正式启动 |
| 官方与 BH 制作 | 已恢复用户的官方原图片；**完整集与真实视频未生产验收** | 真实视频/BH 能力、素材上传、结果期限、实际费用和画面声音合格仍需分别核实 |
| Chrome 图片方式 | 可配置外部兼容 bridge 与扩展 | 新项目没有内置完整 Chrome 扩展；真实浏览器出图链尚待该桥接环境配置与验收 |

## 离线证据的范围

测试覆盖原文锁定与覆盖校验、稳定资产身份与采用图、引用顺序、不可变提交快照、乐观版本检查、素材哈希、任务回执与未知提交、独立查询和下载重试、迁移隔离、导出恢复及局部依赖调度。离线通过仅说明这些受测规则成立。

图片当前/历史新增 10 条核心回归包含：完整下载后自动选择、重新生成替换、手选历史与重启/查询保持、部分下载和失败保留、形象版本变更、精确过期关联准备、事务回滚、补选缺图、顺序批量导入及生成图片发布期间的补选竞争。公开 `images.produce` 验收同时运行父图生成、自动成为当前图、派生依赖解锁和子图下载完整链。视频下载不自动采用，原视频人工验收规则保持。专用界面复验入口为 `node scripts/verify-image-history-ui.mjs`。

第四阶段新增 13 条核心回归核对能力缓存与配置绑定、过期刷新失败、模型/尺寸拒绝、账户差异、参数事务回滚、能力版本变化、局部提交、原 ID 恢复零提交和请求期间配置变化。前端 24 条检查包含实际组件 SSR、按钮回调和初始化生命周期的离线重放；4 次请求均为测试桩，无真实渠道或生产数据库操作。生产项目更新前一致性备份；本轮未发起付费生成。专用入口为 `node scripts/verify-video-production-ui.mjs` 和 `cargo test --test video_preflight`。

正式项目先经一致性备份。首次新客户端启动时，已有原图自动补选，两个原任务完整行不变；之后出现的新图片测试有持久化云端回执，最终下载 2560×1440 图片（2,260,266 bytes），哈希 `20eb5b07d47fcd52ddf1eb01bfae1528d52c0b3742e38ff8f89b323c056ffed6`。完成事件与当前图一致，旧原图文件和历史关联保持。这个后续测试独立于初始化核验，不能把新增的一条真实生成任务混入“初始化新增生成为零”的证据。人工画质验收、原生历史点击和多文件选择仍未记录为通过。

80 集用例在实际 Engine 中为每单元进行一次原始模拟提交，共 80 次。79 项取得不同原任务 ID，另 1 项保留提交未知。查询失败不阻塞其他集；重新打开核心继续查询原 ID，未知项保持阻塞，提交计数仍为 80。对应测试是 `src-tauri/tests/scheduler.rs` 中的 `eighty_real_episode_jobs_keep_local_failures_independent_and_never_resubmit_on_restart`。

性能用例包含 80 个锁定集、80 个资产、80 个单元、80 个历史任务及一个共用不可变图片文件；历史正文与回执保存在按需详情中。它测量公开核心读取和序列化，而非仅测数据库 SQL。对应 `src-tauri/tests/acceptance.rs` 的 `local_workspace_metadata_benchmark_eighty_locked_episodes`。当前样本满足此元数据路径的 1 秒目标，但不能推导所有制作页面、所有项目规模或端到端操作都低于 1 秒。

实际媒体元数据证据见 [`tools/ffprobe/verification.json`](../tools/ffprobe/verification.json)，官方 CLI 检查及未执行项见 [`src-tauri/src/providers/verification.json`](../src-tauri/src/providers/verification.json)。模块和定向测试数是子集记录，不应与本次完整套件相加。

后续修改另做了视频采用回归：当前单元修订后，即使新的任务复用完全相同的文件哈希，旧的人工作品采用仍保留原单元版本，不能自动提升为新版本；该定向 acceptance 测试通过。Codex CLI 的隔离策略保存为 `codex-isolated/v1`，改变策略后不复用旧策略缓存。

## 受控预览截图

这些截图使用只读开发样例，不写真实项目、不提交生成。仅记录 1440×940 下六个顶层页面布局；未将单元编辑映射、音视频用途编辑、冻结包动态变化、原生文件选择或真实任务播放列为已完成的人工交互验收。

| 页面 | 截图 |
| --- | --- |
| 第一阶段：制作基础 | [stage1-preview.jpg](screenshots/stage1-preview.jpg) |
| 第二阶段：图片资产 | [stage2-preview.jpg](screenshots/stage2-preview.jpg) |
| 第三阶段：分镜提示词 | [stage3-preview.jpg](screenshots/stage3-preview.jpg) |
| 第四阶段：视频生产 | [stage4-preview.jpg](screenshots/stage4-preview.jpg) |
| 统一任务 | [tasks-preview.jpg](screenshots/tasks-preview.jpg) |
| 渠道与设置 | [settings-preview.jpg](screenshots/settings-preview.jpg) |

## 复验入口

以下普通检查不需要登录渠道，也不触发付费生成：

```text
npm ci
npm run test:frontend
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features -- --test-threads=1
```

本机元数据基准为默认忽略用例，单独复验：

```text
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --test acceptance local_workspace_metadata_benchmark_eighty_locked_episodes -- --ignored --exact --nocapture
```

外部 CLI 和媒体探测用例需要指定已经核验的本机工具或素材；不应将所有 ignored 测试一并解释为无环境依赖的普通测试。CI 定义位于 [`.github/workflows/check.yml`](../.github/workflows/check.yml)：Windows/macOS 上运行前端测试及构建、desktop feature 的 Cargo check/test。当前记录没有远程 CI 执行结果。

原生启动检查可用最终客户端 `--verify-startup <绝对报告路径>` 复验。报告父目录须先存在，复验时关闭 1420 开发服务；它使用该目录下的独立 `startup-verification-home`，只建立文本与一张测试 PNG，验证生产编译模式、真实页面地址、启动前后开发端口、前端、IPC、SQLite 和图片读取后退出。开发页面即使能渲染也不能通过独立启动检查。重复运行核对同一测试项目，30 秒无回执则超时退出。该入口不读取正式项目，也不运行渠道调度或文本模型。

## 并发、账户和发布约束

当前「每视频渠道 1 路」限制的是本地渠道操作。一次提交取得回执后，允许下一项提交；**它不限制云端同时 running 的任务数为 1**。是否把上限改为云端在途任务数，仍待用户选择，不能按已确定规则宣传。文本并发保持全局最多 4、同集最多 2；Chrome 图片从 1 路开始。

即梦已使用官方 `user_credit` 的实际账户 ID 哈希绑定任务；账户备注不参与鉴权门槛，调用前重新查询身份。BH/Chrome 仍使用用户声明的稳定标签，token 轮换不改标签，换账户须同步更新标签。官方共享登录无法被工作台的本地锁完全锁定，任务执行期间应避免在 SHUO 中切号。

helper 安装资源只采用明确列出的文件，不递归打包工具目录。最终 NSIS 脚本实际清单已核对：主程序、Rust 核心命令入口、Dreamina 二进制及来源回执、ffprobe 二进制及许可/说明/来源回执。工具开发期间产生的编译测试文件、下载归档和其他临时文件未进入该清单。清理被自动审批以 `blocked by policy` 拒绝，不能写成已清理；相关文件保留并排除。Windows helper 的存在也不证明 Mac 对应工具已经配置或验证。

## 剩余制作验收

即梦现有登录与身份已核实；BH 凭据、代表性一集和生成预算尚待确认。按下列门槛分别记录，不以接口成功代替作品合格：

1. Windows 实际安装与完整人工交互，覆盖文件选择、编辑、音视频播放及渠道配置；原生启动与基本 IPC/项目读取已取得独立证据。Mac 实机启动、路径重定位、工具配置、媒体哈希、备份恢复及跨机迁移仍待验收。
2. 包含基础形象、变体和场景的一集，从原文到图片、独立分镜、配图和逐单元视频完整运行；人工确认原文、台词归属、连续状态、声窗与动作。
3. 至少 3 个单元分别通过官方即梦与 BH 实际生成，记录原任务回执、费用、时长和保存期限，检查参考素材、人物形象、动作与声音，并人工采用合格结果。
4. 在真实渠道分别复验上传中退出、提交未知、取得 ID 后退出、下载中退出、鉴权失效和 URL 过期；恢复过程新增生成提交数必须为零。
5. 若使用 Chrome 图片方式，先配置并验收外部兼容桥接；核实任务身份、原图来源、数量、顺序和哈希。

视频落盘后仍需验证容器和 motion video 流，生成结果的单元版本须与当前版本一致才可采用。历史采用视频允许继续预览，但不代表新单元版本已验收。容器合格、接口合格、画面与声音合格、人工采用是不同状态。
