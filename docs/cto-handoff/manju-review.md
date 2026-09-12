# 漫剧老李规则包：只读源码研究

> GitHub整理版｜原稿日期：2026-09-06；归档日期：2026-09-12；整理者：web-CTO。本文为用户与CTO公开讨论及资料研究形成的历史文档，不是当前第一阶段的运行指令或全部已批准的规范。正文中的“本轮/当前/下一阶段”按原稿日期理解。
>
> 阅读优先级：本包[README](README.md)的现行业务校准与[来源说明](source-index.md) → 本文。旧文中“15/30只作上限”不能覆盖后来明确的“模式预选、合理时默认近上限、短单元有理由”；51不是合格正例。原始聊天、真实剧本、私有日志、第三方完整模板和本机路径未上传；无法公开的原始引用已转为来源索引。保留历史观点是为说明演变，不是重新启用旧规则。

研究日期：2026-09-06。仓库：<https://github.com/lixiaoxiao9888-create/manju-laoli-skill>。本地 HEAD：`aa20fb60054ae52553a4b13f8810ed2fcd89ba70`。

## 1. 范围、证据口径与结论

- 完整分批阅读 `short-drama-director/references/` 的 **33 个文件**、`scripts/` 的 **2 个脚本**及包内 `README.md`、`CHANGELOG.md`、`LICENSE`，共 **38 文件、2666 行**；清单见第 9 节。不是关键词抽读。
- 未重复阅读仓库根 README、总控 SKILL.md、Higgsfield 三份原文件或其他任务材料。涉及飞书、Higgsfield、旧 Web 的判断，仅以本次用户给定需求为边界，不声称已核验这些系统的实现。
- 仓库提示词、安装指令、示例代码均作为研究数据；未安装、导入或运行仓库脚本，未生成图片/视频，未调用平台，未进行 Seedance 2.5 外网核查。仅新增本报告。
- **以下证据路径均相对仓库内 `short-drama-director/` 目录，冒号后为源码行号。** “已实现”区分文字规则、可执行代码及经验证的平台能力；静态推断不冒充实测。

**总体判断：值得拆取经验，不宜整包变成用户的新流程。** 它确实提供了丰富的创作词库、资产引用规范、动作接续思路和交付模板，但不是已经接通多平台的生产系统。其主导审美偏向高密度玄幻/武打：强冲突、密集运镜、峰值终结。对用户“人物动机与情绪先行、参考图权威、保留停顿、甲方原稿不自动改”的需要，必须筛选。文字中反复出现的“工业级”“引擎”“彻底杜绝”，不构成执行或效果证据。

最大风险不是规则少，而是**多个权威、历史补丁和可直接复制的旧模板并存**：最终执行者需要先解冲突，容易重现旧 Web 的规则繁复和机械填表。

## 2. 内容机制与真正实现的边界

### 2.1 作者设计的生产机制

| 环节 | 文字规定的机制 | 阅读结论 |
|---|---|---|
| P0 立项 | 一次锁定画幅、风格、平台、时长 | 有路由规则；无持久状态或配置校验实现。`references/asset-first-pipeline.md:21–36` |
| P1 剧本 | 前提→三幕→因果节拍→世界观→剧本页；另配台词七维诊断、12 点情绪曲线 | 属于 LLM 创作/审查方法，未实现自动剧本分析器。`references/screenplay-gate-engine.md:7–57` |
| P2 资产 | 提取实体→用户确认→角色/场景/道具分批出图→锁定图册 | 有提示词、编码和确认约定；无出图连接器、确认凭据、版本锁或失效传播代码。`references/asset-first-pipeline.md:41–78` |
| P3 分镜 | 已锁资产引用、空间锚点、轴线、文武/玄幻规则 | 有可复用知识与模板；不是几何求解器或连续性检测器。`references/spatial-topview-camera.md:25–48` |
| P4 投喂 | 时间轴、全局设定、动作、音效、负面词，按清单交付 | 有文字格式；“六步”按题材实际引用多于六份文件，依赖执行者解释。`references/★ prompt-feeding-checklist.md:20–65` |
| P5 审查 | P0 阻断/P1 自动修复/P2 建议 | 是审查准则，不是独立审查进程或自动修复程序；且生产阶段 P0/P1/P2 与缺陷等级重名。`references/quality-gate-review.md:9–23` |

### 2.2 可执行内容审计

| 内容 | 真正具有的能力 | 没有实现/不能据此承诺 |
|---|---|---|
| 33 份规则文件 | 规则、资料、示例和流程说明确实存在，可由外部助手阅读使用 | 文字“必须”不等于机器硬门禁；外部助手有工具时可能执行，不等于仓库自带执行系统 |
| `scripts/check_package.py:5–23` | 检查 SKILL.md 存在、文本包含指定 name 字符串；枚举 `.md` 数量并打印 | 不解析 YAML；不校验预期文件数量、引用、换行、时间轴、敏感词、IP 词或规则冲突。缺少 references 时也没有定制错误处理 |
| `scripts/generate_emotion_curve.py:7–78` | 配置字体并用 matplotlib 绘制曲线；函数允许传入点表；CLI 只接收输出路径 | 默认点和分数写死；无剧本输入、情绪抽取、评分、JSON 读取。横坐标写死 12 点，非 12 点输入存在长度不匹配风险；没有分数范围校验。**静态推断，未运行** |
| `references/comfyui-canvas-automation.md:22–50` | Markdown 内的 Python 请求示例，组装几个字段并调用一次 POST | 默认地址是 `api.example.com`，不是平台端点；没有批次循环、任务轮询、超时、状态码判断、重试、幂等、额度/点数计算、文件上传及真实资产映射 |
| `references/agent-platform-adapters.md:20–76` | WorkBuddy 流程描述、Coze 示例 JSON、分块建议、通用命令约定 | 无 Action Card 实现、工作流导出文件、JSON Schema、平台适配器或兼容测试；“2000 Tokens”也没有计数/续传实现 |

跟踪文件清单显示包内除 SKILL.md、文档和上述两个脚本外，没有其他平台连接代码、依赖清单或测试文件。两脚本未由本任务运行；绘图脚本含 `savefig` 写文件行为（第 73 行），不能当成无副作用检查命令。

包 LICENSE 是 MIT 文本，包含保留版权/许可声明及按现状提供的条款（`LICENSE:1–21`）。这只记录许可文本，不据此推定所有素材、名称、参考作品或输出均已获权利许可。

## 3. 最值得借鉴的 9 点（均为研究取舍，不是实施）

1. **先问角色想要什么，再问镜头拍什么。** 前提中的欲望/阻碍、关系网络，以及镜头“情绪、行动、压力”三任务可合并为简短叙事判断。保留这些问题，不要求每镜填齐一张表。来源：`references/screenplay-gate-engine.md:12,25–29`；`references/cinematic-dramaturgy-rules.md:5–10`。
2. **潜台词和角色语言差异有用，改写必须可比较。** “原台词→建议→依据”利于甲方审阅；用户未授权时停在建议，不替换原文。无需每句硬凑三条理由。来源：`references/dialogue-doctor-7d.md:9–32`。
3. **批准的参考图是外观权威，文字是索引。** 短 ID 绑定角色、场景、关键道具，可减少描述彼此矛盾。应区分“故事事实来自原稿”与“外观事实来自批准参考图”，不能让新生成图反向改写剧情。来源：`references/asset-first-pipeline.md:61–66`；`references/production-ledger-handbook.md:28–61`。
4. **按复用价值准备资产。** A/B/C 分级、关键道具、一次性场景的简化例外可减少无谓工作；已有合格参考图应直接继承，不必重画全套。来源：`references/asset-first-pipeline.md:43–49`；`references/asset-spatial-ledger.md:47,84,99`。后一句为本报告对用户需求的取舍，不是仓库已实现能力。
5. **接续状态比招式数量更重要。** 起点→路径→终点、受击后不瞬间复原、下一镜继承位置/道具/状态，适合作为连续性底线。来源：`references/asset-spatial-ledger.md:53–56`；`references/action-previs-15grid.md:43–57,98–108`。不必把所有动作展开成 11 环。
6. **对白预算要包括呼吸和反应。** 字数/语速仅作初估，停顿、气口、情绪余韵另计；不得为了填满/压进单元而加速台词。来源：`references/dialogue-speed-check.md:15–22,30–33`。若说话与动作同时发生，不能机械相加重复计时；仓库第 91 行的相加规则缺少这一条件。
7. **投喂正文与审查材料分开。** 全局设定、局部变化、负面排除和接续状态可让单元便于独立使用；语速卡留在 QC，不污染生成提示词。来源：`references/seedance-render-engine.md:15,19–24,104`；`references/dialogue-speed-check.md:87–93`。仓库有两种不同“三层”定义，借鉴时需统一用途。
8. **先确认参考片的剪辑结构，再写运镜。** “动作分解不等于剪辑点”“机位服务动作语义”能回应机械拆镜痛点。来源：`references/action-cinematography-breakdown.md:44–83`。但不能照抄“没写转场标记就是长镜头”的判据；缺证据时标未知。
9. **保留失败记录，但限定适用范围。** CHANGELOG 留下用户反馈与修正原因，比没有来历的铁律更有学习价值；每条经验应保留模型/版本、输入参考、样片和适用条件，证据不足就标“作者经验/待验证”。来源：`CHANGELOG.md:6–27,31–66`。不能由两版玄幻样片推出所有模型不具备静止表演能力。

## 4. 对用户关键需求的利弊与取舍

| 主题 | 有益之处 | 对本用户的风险 | 研究建议 |
|---|---|---|---|
| 锁稿与可改编 | P0 审查明确保护核心台词，改写有对照格式 | 同时要求删非承重场、重构台词；只保护“核心台词”不足以保护全部甲方原文 | 锁稿时原文只读，拆镜不等于改写；可改编也只提交候选及差异，未经批准不得覆盖 |
| 资产先行硬门禁 | 生成前统一脸、服装、场景、关键道具 | 要求先生成全套图才能分镜；会阻断情绪/动机探索，增加逐批确认；用户已有参考图仍可能被重造 | 保留“正式投喂必须明确资产来源”；允许在概念拆镜中标缺图/未知，不自动出图、不编造细节 |
| 固定 12 节拍 | 可用于观察张力起伏 | 固定第 9 点最高、两个 9 分峰值、标准反杀曲线，会把不同题材改成同一爽剧 | 从原稿因果与情绪变化归纳实际节拍；数量和曲线不作为合格门槛 |
| 15 秒与镜数 | 将平台容量与叙事单元分开考虑，有利拆超长内容 | 4–15s、12–15s、3–4 镜、5–8 次切换并存；“上限”容易变“目标填满” | 用户的 15s 是上限，不是每段定长；按情绪结束点提前收束。实际平台限制由主任务后续核验 |
| 禁静止/慢镜 | 提醒高密度动作中避免无意拖沓 | 把沉默、犹豫、聆听、对峙全部转成位移，违背自然表演；连用户要留白也被限 ≤1s | 保留有动机的停顿；能否生成所需表演是具体平台/素材问题，未知则标待试，不预判全行业做不到 |
| 物理动作规则 | 写清谁对谁、接触、反作用、道具状态，比抽象“激烈”具体 | 必须大幅闪避、肘击、气爆、11 环、每镜位移会改变人设与战力，也难适用非武打情绪戏 | 情绪/意图→可见动作→必要技术描述；写实与玄幻按原稿规则区分，不把夸张特效称为通用真实物理 |
| 微表情六阶段 | 提醒反应有延迟、掩饰和余韵 | “必须按生理规律”没有来源；每次冲击都破防会消灭人物差异 | 作为候选表演词，不是普遍生理顺序；选择符合角色当下动机的一两项 |
| 多门禁/参数表 | 重要交付缺陷能被指出 | 无空镜、必须斜角、必须快切等审美偏好升级为阻断，重演旧 Web 机械填表 | 仅事实/授权/资产错用/实际平台上限列硬问题；节奏、构图、美学通常提供理由和可选建议 |

证据分别见：`references/quality-gate-review.md:13–15`；`references/screenplay-gate-engine.md:24,52`；`references/asset-first-pipeline.md:11–15,70–78`；`references/emotion-beat-curve.md:9–32`；`references/seedance-render-engine.md:11–14`；`references/action-previs-15grid.md:13,43–57,110–127`；`references/combat-rhythm-defense3state.md:41–48`；`references/wenxi-micro-expression.md:7–21`。

**锁稿边界说明：** 本次没有复读总控 SKILL.md，故不声称总控一定没有锁稿/改编模式。能确认的是：下游规则本身存在无授权限定的删改指令，且没有代码强制隔离两种模式；即使总控另有保护，也需要主任务核对其是否能明确覆盖这些指令。

## 5. 确认的错误、内部冲突和证据不足

“冲突”不等于所有情况下无法解释；部分可以用适用范围、权威优先级化解。但这些条件没有在所有模板和检查出口同步，仍有直接复制或自动审查的风险。

### 5.1 高影响问题

| 编号 | 证据（相对路径+行号） | 判断及影响 |
|---|---|---|
| F01 | `README.md:73–79`；`CHANGELOG.md:147` 对照 `scripts/check_package.py:11–23` | **实现不符**：宣传的 CR/箭头、孤立 Markdown、时间轴、危险词/IP 检查均不存在。即使运行打印通过，也不证明这些项目合格 |
| F02 | `references/emotion-beat-curve.md:3,38–41` 对照 `scripts/generate_emotion_curve.py:32–56,76–78` | **分析与绘图混称**：CLI 无剧本输入，只画默认 12 点；不能把默认图当成当前剧本的情绪诊断 |
| F03 | `references/screenplay-gate-engine.md:3` 对照 `references/asset-first-pipeline.md:61–66` | **权威边界不清**：剧本和图册都被称唯一真理/事实来源。可以按叙事事实、外观事实拆域解决，但当前文字未给原稿与图相冲突时的裁决方法 |
| F04 | `references/quality-gate-review.md:13` 对照 `references/screenplay-gate-engine.md:24,52`；`references/dialogue-doctor-7d.md:3,15`；`references/dialogue-speed-check.md:33` | **锁稿保护不完整**：一边禁止篡改核心台词，一边要求删除场次、删已知信息、重构超时台词；未同步“锁稿只能提建议”条件 |
| F05 | `references/dialogue-speed-check.md:76–82` | **拆镜示例实际改字**：原句末段是“倒要看看…”，第三镜变成“我倒要看看…”，新增“我”；作者标注的 16+7+11=34，也不再是原文 33 字。对甲方原文尤其重要 |
| F06 | `references/asset-first-pipeline.md:11–15,45–49,74–77`；`references/quality-gate-review.md:5,13` | **硬门禁与例外未打通**：C 类群众、一次性过场允许文字，但无图阻断措辞覆盖所有引用资产。若例外实体被编号引用，缺乏统一通过条件 |
| F07 | `references/asset-first-pipeline.md:28,52`；`references/agent-platform-adapters.md:26` 对照 `references/asset-spatial-ledger.md:9–27` | **资产字段数量不一致**：前者要求“16 项五官+6 项材质”，真正定义是五官 10 项+材质 6 项=16 项。会诱使助手补造六项或重复填表 |
| F08 | `references/action-previs-15grid.md:13` 对照 `references/wenxi-micro-expression.md:7–20`；`references/action-ultimate-finisher.md:86–90`；`references/camera-specs-15rules.md:61–68` | **禁静止过度泛化且互相冲突**：总纲用全体 AI 视频的口吻断言不会静止表演；文戏保留极静余韵，武戏旧规则仍要求 0.3–0.5s 呼吸定格及“静”阶段。文武可拆域，但同属打戏的大招规则仍撞车 |
| F09 | `references/anime-ultimate-vfx-paradigm.md:90–105` 对照 `references/action-previs-15grid.md:13,37` | **“可直接投喂”范例违反新禁令**：10s 示例最后 1.5s 明写定镜、女帝站立、余烬消散；与禁止静止/平缓收尾直接相反 |
| F10 | `references/seedance-render-engine.md:11–14`；`references/camera-specs-15rules.md:12`；`references/action-cinematography-breakdown.md:77–86`；`references/seedance-render-engine.md:99–102` | **镜头/生成单元/动作切片混用**：3–4 镜模板、15s 内 5–8 次切换、单镜≥4s、15s 单长镜头并存；标准模板末镜又是 3s。若都作强制条件就不可同时满足。0.5–1s 动作切片本可在同一镜内，不应被误当独立生成最小时长 |
| F11 | `references/seedance-render-engine.md:13–14`；`references/production-ledger-handbook.md:64` | **预算推导不成立**：180÷(12–15) 的范围是 12–15 组，不能由公式推出“必须14–15组”；固定14组可作为作者方案，但不是数学必然 |
| F12 | `references/action-previs-15grid.md:17–21,43,89–90` 对照 `references/combat-direction-engine.md:14–18`；`references/combat-rhythm-defense3state.md:7–11`；`references/quality-gate-review.md:14` | **R1 简化没有传到下游**：总纲允许克制、机枪对招可选、肘击仅建议、连接招不展开11环；独立文件和质检又无条件要求。用户克制动作会被误判需自动修复 |
| F13 | `references/xuanhuan-magic-combat.md:3`；`references/★ prompt-feeding-checklist.md:16,49–58` 对照 `references/action-previs-15grid.md:21,89`；`references/quality-gate-review.md:14` | **R3 法术与拳脚门禁冲突**：玄幻权威明确禁止硬套11环/近景机枪，总纲表格和质检仍对R3或所有动作必选；题材分流没有贯穿出口 |
| F14 | `references/action-previs-15grid.md:25–29` 对照 `references/combat-direction-engine.md:9–11`；`references/camera-specs-15rules.md:5–9` | **启发式评分与“完播率公式”混用**：同组权重一处是加权和并承认非预测，另两处仍是乘法并命名真实完播率；没有观测数据或标定，不能作为流量效果预测 |
| F15 | `references/action-cinematography-breakdown.md:71–74` | **把缺失信息当事实**：拆解稿没有转场标记，不能逻辑推出原片无剪辑；遮挡也可能发生在连续镜头内。应核对原片或标剪辑结构未知，不能自动改写成 ONER |
| F16 | `references/seedance-render-engine.md:21–24,83,99` | **对白投喂自相矛盾**：先允许变量层放台词，再要求台词永远单独生成/合成，随后标准画面模板又直接写台词；声音分工与口型方案未形成一致契约 |
| F17 | `references/model-adapters.md:15–25` 对照 `references/seedance-render-engine.md:19–24` | **“三层解耦”有两套定义**：主体/环境/运镜参数，与全局不变量/镜头变量/负面排除并非同一层级。可组合，但不能声称已是统一平台协议 |

### 5.2 模板、规则更新与记录不一致

| 编号 | 证据 | 判断 |
|---|---|---|
| F18 | `CHANGELOG.md:138` 对照 `references/cinematic-dramaturgy-rules.md:16–18`；`references/martial-arts-combat-library.md:103–118`；`references/authentic-martial-taxonomy.md:65–66` | 日志声称导演法则技术化改名、特定 IP 名称替换，正文仍保留原名。这里只确认替换未完成，不给出侵权结论 |
| F19 | `CHANGELOG.md:139` 对照 `references/anime-ultimate-vfx-paradigm.md:60–61,76` | 日志称 UE5/8K 去强制、符纹不可读；正文仍“必须包含”UE5/8K、清晰流动的符文文字。提示词写8K也不构成平台输出分辨率证据 |
| F20 | `CHANGELOG.md:140–142` 对照 `references/lighting-and-antifake.md:16–18`；`references/audiovisual-aesthetic-presets.md:3–47`；`references/screenplay-gate-engine.md:13–21,52` | 日志声称放宽日景自然冷光、补足快门运镜、加入关系/喜剧/信息缺口钩与完结例外；相关正文仍有冷光词禁令、六种预设实际各五项、只列四类强刺激钩且结尾必须悬崖、每句对话必须博弈 |
| F21 | `CHANGELOG.md:127,132–134` 对照 `references/seedance-render-engine.md:11–14`；`references/asset-spatial-ledger.md:7–27,47` | “镜数不强制”和配角8项/群众3–5项的细则未完整进入下游定义；存在少量简化例外，不能据日志说柔性化已全部落地 |
| F22 | `CHANGELOG.md:128` 对照 `references/authentic-martial-taxonomy.md:19–20,49–50`；`references/martial-arts-combat-library.md:52,94,106–111` | 日志称相关高危/致命化表达已清洗，正文仍残留。合规词典不能替代内容审查，也不能提供平台通过保证 |
| F23 | `references/anime-ultimate-vfx-paradigm.md:86,98,102`；`references/seedance-render-engine.md:36`；`references/cinematic-dramaturgy-rules.md:60` | “禁写粒子”与同文件范例、其他必写公式并存。`references/xuanhuan-magic-combat.md:7,67–80` 有投喂前转化补丁，应承认这层缓解；但可复制示例并未统一清理 |
| F24 | `references/action-cinematography-breakdown.md:10–11` 对照 `references/camera-specs-15rules.md:52–57`；`references/camera-transitions-6types.md:22` | 一处禁止特写直接跳大远景，另处鼓励 ECU↔EWS 两极跳。可按类型或动机区分，当前“一律禁止/必须”的表述没有统一例外 |
| F25 | `references/asset-spatial-ledger.md:37–44` 对照 `references/character-lineage-and-sheets.md:9–17` | 角色“三视图”一处指定无头正面+无头背面+头部特写，另一处要求正面/45°斜侧/背面及全身比例；所需视图、分栏含义不一致，不能只看名称即认为覆盖 |
| F26 | `references/aspect-ratio-adaptation.md:3,20,54–56`；`references/asset-spatial-ledger.md:65,73,94`；`references/combat-direction-engine.md:43` | 资产板16:9的明确豁免可解释部分画幅差异；但场景战斗模板固定16:9、全局成片默认9:16、局部仍称横屏默认，增加回填风险。把冲镜/垂直构图词视为横屏违规也是作者审美限制，不是由画幅比例推出的技术禁忌 |
| F27 | `references/dialogue-speed-check.md:11–21,30–33,65–69` | 定义慢速/快速档，却只把3.5–5字/s列为通过；24字一处可通过，速查表却触发拆镜。数字/外文字母按字符数并不直接等于朗读时长；这些只能是估算，不能作自然表演的硬阈值 |
| F28 | `references/action-previs-15grid.md:13`；`references/model-adapters.md:18`；`references/action-ultimate-finisher.md:63,88`；`references/★ prompt-feeding-checklist.md:58` | Hit-Stop 用1–2帧、0.1s、0.2s、0.3–0.5s多种口径；未指定帧率，也混入蓄势呼吸帧，不能视为同一可执行参数 |

### 5.3 结构/数量等可直接核对的小错误

- `README.md:88` 写32个规则库，实际为33个。`references/production-ledger-handbook.md:9–19` 说六板块却列七；第26–65行说六大编码却只有五类。
- `references/dialogue-speed-check.md:37–44` 的“五步”实列六步；“三档判定”表第30–33行实列四类。这是编辑问题，不等于整个方法失效。
- `references/audiovisual-aesthetic-presets.md:3` 宣称六维，实际每种只有光学、色彩、光源、材质、声音五项（第7–47行）。
- `references/emotion-beat-curve.md:16,23` 参考分区间写为7.0–6.5；绘图默认第4/11点均为7.2（`scripts/generate_emotion_curve.py:41,48`），不在该区间内。默认图与标准表也不完全一致。
- `references/seedance-render-engine.md:39` 同一词条写“360°环绕（≤180°）”；第58行公式起始为损坏的 `ext` 而非正常 `\text`。
- `references/anime-ultimate-vfx-paradigm.md:67–109` Markdown围栏配对错误：67行开启后未在第四节前关闭，92行的另一 `text` 围栏不能关闭前者，108行才关闭，109行又开启。按Markdown语法推断，第四/五节可能被当作代码，最后留未闭合围栏；未执行渲染测试。

## 6. Seedance 2.5：仓库来源边界与主任务官方回传

对本次38个指定文件检索 `http(s)` 链接，唯一命中是 API 示例占位地址；未见官方模型文档、能力矩阵链接、公开测试记录或可核对样片链接。CHANGELOG 提到的“验证包”“Obsidian素材库”和26s/35s拆解未随所读包交付。**所以这里的“无来源”指当前提交及本次材料缺少可复核依据，不等于断言功能不存在或作者从未测试。**

**主任务官方核对回传（报告完成期间追加，本分工未联网复核）：** 主任务确认[Seedance 2.5官方主页](https://seed.bytedance.com/zh/seedance2_5)明确单次30秒及两次延长；2026-07-31发布文列30图/10视频/10音频、白模参考、时间戳编辑、绿幕等。主任务同时确认2.0的2月12日官方发布文已支持9图/3视频/3音频、15秒多镜头与音视频联合。具体原文与引用由主任务整合。由此，仓库“2.5最大15秒”和“2.0单参考图/首帧”的通用能力表至少与回传官方资料不符；**用户自选15秒上限仍可保留，不能与模型硬上限混同。** 多参考及联合音视频也不能仅凭本包就写成2.5首次新增能力。

| 作者声称 | 仓库证据位置 | 缺少的验证/实现 |
|---|---|---|
| 微表情大幅提升，0.3s生理递进，15s动作零变形 | `references/model-adapters.md:9–10` | 无对照版本、测试素材、评估定义或成功率；“零变形”是无证据保证 |
| Hit-Stop、接触形变、反作用力可杜绝滑步/假打 | `references/model-adapters.md:11`；`references/seedance-render-engine.md:23` | 无可调用碰撞控制参数或验证；描述期望不能等同确定控制，具体帧级实现未知 |
| 起始帧+结束帧+角色三视图可同时输入且精准锁定 | `references/model-adapters.md:12,25,35`；`references/seedance-render-engine.md:91–95` | 无官方输入槽数量/类型/组合限制、上传代码或实际响应；`dual_frame=true`只出现在文字范例 |
| `[SFX: ...]`是原生标记，音画精确对齐并支持电平协同 | `references/model-adapters.md:13`；`references/seedance-render-engine.md:67–83` | 无官方语法、音轨接口、混音实现或测量；提示词内写dB不等于生成器执行该增益 |
| 最大15s、R1/R2/R3全支持、连续复合运镜“极强” | `references/model-adapters.md:31–38` | “2.5最大15s”与主任务回传官方30s不符；本包无特定入口限制说明。强度分档是作者分类，不是平台枚举或测试分数 |
| 单段/单镜最低4s | `references/seedance-render-engine.md:11`；`references/action-cinematography-breakdown.md:86` | 无官方来源，且把生成单元限制套在剪辑镜头上；主任务后查实际入口 |
| `motion_intensity=high`、`dual_frame=true`等契约可投喂 | `references/model-adapters.md:25`；`references/comfyui-canvas-automation.md:37–49` | 无真实Seedance API schema；示例POST甚至默认 `seedance-2.0`，没有 dual_frame 字段 |

**2.0/2.5也混标：** `CHANGELOG.md:64`称长镜范例可直投2.5，较新的第23行明确同类高密度版适配2.0；当前范例写2.0并绑定首尾帧（`references/action-cinematography-breakdown.md:99–103`），而适配表把2.0写成单参考图/首帧（`references/model-adapters.md:36`）。这是版本/入口证据不足及文档不一致，不能从范例把能力迁移到2.5。回传的官方多模态能力也没有自动证明本包 `[SFX:]`、`dual_frame=true` 或帧级Hit-Stop语法真实有效。

**其他超出代码的兼容承诺：**

- “全平台无缝兼容”、所有平台同命令触发、WorkBuddy卡片/侧栏/自动归档：`references/agent-platform-adapters.md:3,20–34,68–76`，没有相应实现或测试。
- “复制SKILL即自动内嵌摘要、无需references”：`references/agent-platform-adapters.md:62–64`，本包两个脚本均不负责导出/打包；总控是否包含足够摘要由主任务判断，不能据此宣称各平台独立兼容。
- Canvas/API“批量任务调度、轮次/点数预算”：`references/comfyui-canvas-automation.md:3,22–59`，只有一次请求示例和文字要求，没有批量调度器或计费数据。
- 准确遗传40%–60%、顶视图“彻底解决”跳轴等：`references/character-lineage-and-sheets.md:34–40`；`references/spatial-topview-camera.md:3`，没有测量定义或执行算法。应归为造型启发/目标，不是生物学或模型能力结论。

## 7. 与飞书、Higgsfield及旧 Web 痛点的学习接口

本节是面向用户需求的研究建议，**不是仓库已有集成，也不是本轮实施计划**。本次指定文件中没有飞书、Lark、Feishu或Higgsfield集成描述/实现。

| 对接对象/痛点 | 可借鉴的内容 | 必须保留的边界 |
|---|---|---|
| 飞书里的甲方原稿、参考图和审阅意见 | 原文—建议对照、短ID、资产图册、确认节点 | 原稿与建议分开；批准的参考图优先；未知事实和冲突显式标记。库中没有飞书读取、版本锁、回写权限或审阅同步 |
| Higgsfield里的生成操作 | 每单元独立提示词、参考图绑定、接续状态、失败经验记录 | 仅映射该入口实有的输入槽/时长/音频能力；不能把作者的Seedance字段/SFX标签当作Higgsfield已支持功能 |
| 旧Web规则多、机械表格 | 三任务法、按需动作词库、QC与正文分离 | 先给人物处境、意图和情绪变化，再选择少量镜头信息；不强制12节拍、11环、每镜五参数和所有门禁卡齐填 |
| 多人协作中的“谁说了算” | 分域的权威原稿/参考图/批准变更 | 不把生成的新资产自动升格为剧情事实；不由审查器擅自改甲方台词；平台能力未知交主任务核验 |

最小可吸收原则可以归为：**故事意图先行；原稿和参考图分别守住权威；镜头只写必要变化；15秒只作上限；不确定就标记。** 高密度战斗配方保留为可选资料，不升级成全项目默认宪法。

## 8. 留给主任务的待核查项

1. 在总控SKILL已有路由/优先级下，锁稿、R1、R3、资产例外能否实际覆盖上述下游冲突；本分工未复读总控。
2. 整合主任务已经核对的2.5/2.0官方能力引用；进一步区分模型原生能力与Higgsfield具体入口，并核对本包特有的SFX标记、参数schema、参考图组合和精确时间控制，不能由“支持多模态”推定这些私有写法成立。
3. 若要保留“用户实测通过”的经验，需要原始提示词、参考图、实际模型/日期/参数及生成样片；目前仅有作者文字转述。
4. 不把真实武学名称、虚构武学、亲缘相似比例或“AI不会表演”当已验证事实。本轮未查武术史、摄影理论出处或平台政策，因此不作行业性能、历史真实性及平台合规保证。

## 9. 完整阅读清单与逐文件机制摘要

下面路径仍相对 `short-drama-director/`；“全文”表示从首行读至该文件末行。每项均已读，不以引用关系代替阅读。

| # | 文件 | 全文行数 | 内容机制摘要 |
|---|---|---:|---|
| 1 | `references/action-cinematography-breakdown.md` | 116 | 景别阶梯、视线落点与动作连续；12组动作语义—机位表；拆解稿ONER/剪辑判型、≥4s规则；15s女帝战巨兽单长镜范例 |
| 2 | `references/action-previs-15grid.md` | 142 | 武打总纲；R1/R2/R3、禁静止、启发式完播潜力、11环动力链、五要素、机枪对招、防守三态、大幅闪避与气效 |
| 3 | `references/action-ultimate-finisher.md` | 90 | 大招五要素、破局/绽放/余震、A–K十一种运镜、特效生长及终结前呼吸定格 |
| 4 | `references/agent-platform-adapters.md` | 76 | 多Agent平台架构；WorkBuddy P0–P5、卡片/文件交互，Coze JSON与2000-token分块，单文件Prompt及通用命令约定 |
| 5 | `references/anime-ultimate-vfx-paradigm.md` | 109 | 15s三阶段大招、FPV、双配色、UE5/8K声明、去水五律；15s/10s完整范例及若干静止旧模板残留 |
| 6 | `references/aspect-ratio-adaptation.md` | 66 | 用户画幅优先、默认9:16、全流程回填；资产板解耦、横竖构图对照、画幅质检 |
| 7 | `references/asset-first-pipeline.md` | 88 | 唯一六阶段顺序；P2a–d资产提取、清单确认、分批出图、图册权威；五道资产门禁及简化例外 |
| 8 | `references/asset-spatial-ledger.md` | 102 | 五官10项+材质6项；无头正/背+头部三栏；空间轴线；文戏机位图/战斗站位图；道具图规范 |
| 9 | `references/audiovisual-aesthetic-presets.md` | 47 | 东方诗意、民国冷灰、港派、新黑色赛博、水墨、3D国漫六种风格；各列光学/色彩/光源/材质/声景，缺宣称的第六维 |
| 10 | `references/authentic-martial-taxonomy.md` | 68 | 以真实发力名义组织11环动作、传统/现代门派与兵器速查；混有虚构招式、致命化词及强制展开 |
| 11 | `references/camera-specs-15rules.md` | 70 | 15s高密度镜头规则、五要素、斜角限制、景别阶梯/极限跳跃、视线流与四阶动静节奏 |
| 12 | `references/camera-transitions-6types.md` | 32 | 换机位/切景别/反应三手法，六种连续与转场方式；动作省略和环境代打击 |
| 13 | `references/character-lineage-and-sheets.md` | 50 | 角色卡视图/比例/材质/色值；T1–T3梯队及40%–60%亲缘相似推导、直接出图要求 |
| 14 | `references/cinematic-dramaturgy-rules.md` | 79 | 镜头三任务、导演署名调度法、剪辑优先级、反形容词、双眼/对称/剪影/体量美学套件 |
| 15 | `references/combat-direction-engine.md` | 57 | 武打最高指南；乘法完播率公式、七铁律、多人独立攻击与具体位移、五要素、11环/空气反馈 |
| 16 | `references/combat-rhythm-defense3state.md` | 48 | 2–3s近景连招与必含肘击、防守三态、大幅闪避；后来把留白/神态改为运动附属 |
| 17 | `references/comfyui-canvas-automation.md` | 59 | 资产映射/提示词/参数三层对接；占位API单次POST示例；任务组数和参考图需求预估的文字要求 |
| 18 | `references/dialogue-doctor-7d.md` | 32 | 语言指纹、潜台词、冲突、语感、信息效率、节奏、金句七维；原句/建议/至少三理由的改写格式 |
| 19 | `references/dialogue-speed-check.md` | 93 | 三档语速、发音字数+停顿预算、超长拆镜和金句反应；QC卡与正文分离，示例和质检联动 |
| 20 | `references/emotion-beat-curve.md` | 41 | 标准3分钟12节拍及固定分区间；两次高峰、第9点最高和即时开局规则；绘图调用约定 |
| 21 | `references/lighting-and-antifake.md` | 18 | 光源物理依据、阴影与日夜光线；日景冷光词禁令及替代表达 |
| 22 | `references/martial-arts-arsenal.md` | 50 | 23类徒手/身法、九套剑法、居合/镰刀、轻功/修仙概览；所谓25式只有概括而非逐项完整表 |
| 23 | `references/martial-arts-combat-library.md` | 127 | 较详动作词库：拳法、腿法、地堂、战舞、柔道、擒拿、九套剑法、太刀及轻功；含真实与虚构素材 |
| 24 | `references/model-adapters.md` | 46 | Seedance2.5微表情/碰撞/多图/原生SFX声称、三层提示范式、模型对照和投喂检查 |
| 25 | `references/platform-safety-compliance-guide.md` | 14 | 暴力表达替换字典；明确不保证100%通过、以平台政策为准；无实时政策检查 |
| 26 | `references/production-ledger-handbook.md` | 75 | 图册Markdown结构；CHR/AUD/PRP/SCN/U编码、图引用、相对声音电平、14组单元与交付流程 |
| 27 | `references/quality-gate-review.md` | 23 | 画幅/资产检查、P0/P1/P2分级、核心台词保护、武打门禁、三层声音优先级 |
| 28 | `references/screenplay-gate-engine.md` | 57 | 剧本真理源；前提钩子/三幕/因果/世界观/剧本页五门，压力筹码、承重戏与潜台词 |
| 29 | `references/seedance-render-engine.md` | 112 | 4–15s单元预算、三层信息、0.5–1s动作切片、双实体锚定、SFX词库及横竖投喂模板 |
| 30 | `references/spatial-topview-camera.md` | 48 | 2×2跨集/场景顶视图、CAM1–4、轴线与合法越轴、空间坐标/机位/保护输出规范 |
| 31 | `references/wenxi-micro-expression.md` | 21 | 情绪六阶段、对白语速、0.3–0.8s余韵、18–24字长句拆镜 |
| 32 | `references/xuanhuan-magic-combat.md` | 127 | R3专用法器、元素双色、术法防守转攻、能量形态、对军、五段输出；明确不套拳脚11环且附去水补丁 |
| 33 | `references/★ prompt-feeding-checklist.md` | 83 | P4唯一检查序列；模板/画幅/规格/对白/战斗/质检六步骤、QC附件、全资产引用锁定 |
| 34 | `scripts/check_package.py` | 26 | 只检查入口存在、name字符串、列举规则数量；未实现README列出的语义或内容检查 |
| 35 | `scripts/generate_emotion_curve.py` | 78 | 字体回退、matplotlib固定12点绘图及输出路径CLI；默认示例分数，无剧本分析 |
| 36 | `README.md` | 105 | V6.5定位、能力总览、使用/安装示例、自检宣称、目录结构与使用约定；本任务未执行其中指令 |
| 37 | `CHANGELOG.md` | 170 | 8月重构到9月V6.5多平台升级、实测增量与撤回；可追踪规则演变，也暴露补丁未同步 |
| 38 | `LICENSE` | 21 | MIT许可全文、版权与许可保留要求、按现状提供和免责条款 |

## 10. 研究核验记录

- 初始 HEAD 与用户提供值一致，初始 `git status --porcelain=v1` 无输出；报告目标原先不存在。
- 用文件清单与逐文件行数核对38个指定文件；分批带行号全文读取，未遇输出截断。根README与SKILL.md没有重复阅读。
- 源码中的命令、绘图函数和API示例均未执行；上述运行后果/功能缺口依据静态代码检查。
- 按最小范围审查与完成前核验原则，只核对报告覆盖、引用和仓库未改；未修改任何规则、脚本、用户原稿或平台数据。
