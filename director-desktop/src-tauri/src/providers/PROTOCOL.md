# 生成渠道契约

这些同步函数须从 desktop 的 blocking pool 调用。调用者负责数据库事务、状态机与限流；渠道模块不会写项目数据库、自动重发生成或替用户采用结果。正常退出前调用 `providers::shutdown()` 并等待本地执行器完成退出；它停止当前 CLI 子进程，不取消云端任务。

调用顺序：`capabilities → prepare → 持久化提交意图 → submit → 立即持久化回执 → query_prepared → download`。没有准备快照的已知任务使用 `query_for_kind(config, 原ID, 原任务image/video类型)`；普通 `query` 保留通用只读兼容。`prepare` 可以创建 Chrome 任务标签页并上传参考素材；中断后需要核对其记录，不自动重复打开或发送。BH 图片为同步接口；成功回执使用本地 `sync:<requestId>` 身份，下载使用该回执中的 URL，不能拿此身份查询云端。

`ProviderError.submissionUnknown=true` 必须保留未知状态。取得任务 ID 后仅调用查询/下载函数。`reconcile_unknown` 对 Chrome 使用稳定关联码 GET；即梦及 BH 缺少该接口，返回人工核对要求。任何重新生成都需要一个新任务身份。

## 即梦

- 必须明确配置绝对 `cliPath`，没有旧安装路径或 PATH 自动回退。程序以 argv 调用，不经过 shell。
- `prepare` 根据当前 `version` 与四个生成命令 `-h` 创建能力快照，同时保存所配置 CLI 文件身份（路径、SHA256、字节数）与选定型号能力。帮助读取前后文件身份必须相同；未知模型或未明确能力关闭提交。提交意图持久化后的 `submit` 只进行本地文件/素材哈希、冻结型号规则及请求重编译核对，随后直接运行生成命令，不再执行 `version`、帮助或网络预检。CLI 文件变化或旧准备结果缺少文件证明时要求重新准备，不能自动生成。
- `--poll=0` 提交；`query_result --submit_id` 查询。只有 `gen_status=success` 表示成功，仍需返回可下载媒体并经本地验收。
- 结果仅遍历明确的输出容器，包括官方当前图片实测的 `result_json.images[].image_url`；视频适配覆盖 `result_json.videos[].video_url` 与输出记录的 `url` 回退、结果字符串数组。原图/视频 URL 优先于通用 `url`，过滤缩略图、封面、帮助、排队信息与参考输入；只接受无账户凭据的合法 HTTPS URL，保留原有数组顺序和完整签名参数。处理中、失败及未知状态均不采集临时结果。成功但缺少可用 URL 不推断为过期；未知状态及原任务 ID 保留供任务层核对。返回了不合法任务 ID 的提交回执标为未知提交，查询响应的明确非法或错误 ID 不以原 ID 掩盖。
- 图片/视频提交按冻结请求类型选择结果；准备快照查询按 `prepared.request.kind`，缺少快照的查询按原任务类型，只通过明确容器与字段筛选，不猜 URL 后缀。混合响应中的 `images` 不会当成视频下载，`videos` 不会当成图片下载。`submit_id/submitId/task_id/taskId` 的所有显式值（包括外层与 data 层）必须合法且一致，并与查询原 ID 一致；提交身份冲突仍为未知提交。
- CLI 内部上传，没有公开独立上传回执，因此准备结果标记 `uploadReceiptsExposed=false`；不声称上游已经读取参考素材。
- `dreamina_account` 通过官方 `user_credit` 查询当前账户，使用实际返回的 `user_id` 生成 `dreamina:official:user:<sha256>` 稳定身份，公开结果不含原始 UID、账户名或 OAuth token。缺少 UID 时 `ready=false`，积分存在也不能当作身份核验。总积分来自 `total_credit`；未返回会员/赠送/购买明细时显示未知，不伪造为 0。
- `dreamina_begin_login` 先复用经过身份验证的当前会话；只有未登录且用户发起连接时才执行 `login --headless`。返回授权素材仅保留 `device_code/user_code/verification_uri/expires_in/interval`，供核心内存使用，不写入项目或任务快照。URI优先取 CLI 的 `verification_uri_complete`，其次 `verification_url`、`verification_uri`；支持 JSON、ANSI 前缀与官方 SDK 的纯 `key: value` 文字，字段白名单保持一致。
- `dreamina_check_login` 执行 `login checklogin --device_code=... --poll=0`。`authorization_pending/slow_down` 返回待授权，拒绝与过期分别返回明确错误；零退出码之后仍重新查询 `user_credit` 才认定账户已连接。`dreamina_logout` 仅由用户明确退出时调用；关闭客户端不会退出共享的官方 OAuth 会话。账户、授权、余额的公开结果均不能含原始 CLI JSON 或 token。
- 2026-10-04 已在原有授权会话下实际运行只读 `user_credit` 验证，核实它确实返回 `user_id/total_credit/vip_level`；没有读取 Registry/DPAPI 私密值，没有运行登录、退出或付费生成。
- 图片尺寸使用当前型号帮助中的明确组合：3.0/3.1 支持 1K、2K；4.x/5.0 支持 2K、4K；5.0Pro 支持 1.5K、2K、4K。常用比例为 21:9、16:9、3:2、4:3、1:1、3:4、2:3、9:16。
- 视频尺寸逐型号读取 `Supported combinations` 的明确声明，并取文生视频与全能参考模式的共同能力。当前现场帮助确认 Seedance2.5 为 480P/720P/1080P，Seedance2.0_vip 为 720P/1080P/4K，其余公开 Seedance2.0、2.0fast、2.0fast_vip、2.0mini 固定 720P；共同比例为 1:1、3:4、16:9、4:3、9:16、21:9。固定尺寸保留单项能力，`raw.resolutionMode=fixed`；多项为 `choice`。型号声明缺失时不借其他型号或 flag 示例中的尺寸补齐。
- 图片 `1080p` 是工作台自定义像素预设，短边 1080px。只有当前文生图和适用图生图帮助同时明确支持 `--width/--height`、与 `--ratio` 互斥，以及 2K 的 768–3072px/4,194,304px 容量时才开放。提交时编译为 `--resolution_type=2k --width=... --height=...`，不传 `--ratio` 或伪造 `resolution_type=1080p`。16:9 为 1920×1080、9:16 为 1080×1920、21:9 为 2520×1080；最终实际输出尺寸以查询结果为准。
- 2026-10-04 现有用户图片任务的安全结构核验显示：请求目标 1920×1080，`result_json` 返回原图 2560×1440。这与官方帮助的“width/height 为目标尺寸、后端/模型可能对齐最终输出，query_result 为准”一致；未缩放原始成果，不将参数接受等同于精确输出尺寸验收。
- 官方在线安装入口：[jimeng.jianying.com/cli](https://jimeng.jianying.com/cli)。2026-10-04 读取官方版本文件为 `1.4.19`（发布日期 2026-10-03），并将其 Windows 二进制独立下载到新项目 `tools/dreamina/1.4.19/dreamina.exe`。构建为 `1d0bd17-dirty`、2026-10-03；当前生成与 OAuth 帮助已核对。运行时仍以所配置 CLI 的当前帮助为准。
- 新二进制 MD5 与官方 HTTP ETag 一致，官方 Skill MD5 与安装脚本值一致；下载收据记录 SHA256 与来源。二进制没有 Authenticode 签名，官方未公开独立签名校验文件，不将下载一致性描述为签名认证。

## BH

- 默认 endpoint 为 `https://api.7tai.cc/v1`。令牌从 `credentialEnv` 指定的环境变量读取，未写入准备快照。
- 目录实时读取并保留 `catalog_version`，兼容分组 `variants`。仅已有代码参数映射且目录明确时长/比例/分辨率/参考容量时允许准备；新增型号必须补充代码映射和线协议验证，配置中的 `adaptedModels` 不能绕过此要求。
- multipart `file` 上传；保留完整签名 OSS URL。图片、音频、视频分别限制 10/50/60 MiB；上传回执不表示上游读取成功。
- 视频异步使用 `/video/generations`；查询优先 `result_url`、其次 `url`。下载地址失效后只重新查询原任务。
- 图片同步使用 `/images/generations`，`resolution` 和 `quality` 同值，`n=1`。超时不自动重发。
- 只有明确的价格和计费规则才返回 CNY 估算，视频参考倍率未知则费用未知。实际费用单独记录。
- 协议来自当前本机下游手册（2026-09-12 主文及 9 月后续修订）及 SHUO r11 上传/价格/恢复行为。无认证目录请求返回 401，最新线上能力/价格须在用户配置渠道后核实。

## Chrome

- endpoint 只允许本机回环 HTTP；独立 `bridgeTokenEnv`，不读取旧项目 bridge.env。
- Rust 直接访问 bridge 和扩展，无旧 Next/Prisma 后端依赖。当前模式 `model=chatgpt-image`、`resolution=native`；画面比例属于提示词要求，需要用户验收实际原图。
- 专属 launchToken `director-desktop-<requestId>`，空白原生检查 `proofVersion=2`，稳定请求 ID 与 Idempotency-Key，只发送一次。
- 恢复使用 `query_prepared`，通过保存的提示词哈希核对原生会话、回复、来源客户端、生成文件身份、数量及字节证明。证明不足停止导入。
- 下载凭据为 `artifact:///ID?mime=...&sha256=...&size=...`；下载字节与原生证明一致后才返回本地回执。

## 验证边界

测试使用本机 fake HTTP 渠道和合成素材，覆盖签名 URL 完整保存、上传/提交字段、异常受理、原任务恢复零新增提交、哈希变化阻止执行、目录变体、身份与来源核对。该证据不能替代即梦/BH 的真实付费生成、Mac 启动或人工画面验收。

2026-10-04 最近一轮常规 provider 测试 39 个通过，另显式运行独立官方 CLI 的 help-only 契约验证，1 个通过；`query_result -h` 已现场核对。此前现有会话只读账户验证已通过。新增覆盖全部 6 个视频型号的固定/可选尺寸、提交阶段无重复帮助查询、CLI/参数/素材完整性，以及图片/视频提交与查询结果、数组顺序、签名 URL、缩略图排除、成功缺 URL、未知状态、非法/冲突回执身份和冻结类型筛选。本轮 provider 子任务未执行登录、退出、私人任务查询或付费生成；主控通过查询既有用户图片原任务确认其 `result_json` 结构。视频 `result_json` 映射仍是合成契约回归，未实际生成视频验证；全新 OAuth 授权、视频真实效果及尺寸准确性仍须独立验收。
