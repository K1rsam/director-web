---
name: short-drama-director
description: "【漫剧老李AIGC 全流程Skill · V6.5 Multi-Agent】抖音与红果爆款短剧/漫剧工业化编剧与视听导演超级系统。全面支持 OpenClaw、WorkBuddy、豆包智能体/扣子(Coze)等多Agent平台，深度适配 Seedance 2.5/2.0、即梦、可灵等闭源视频模型。整合五阶门控剧本引擎、台词七维诊断、16项资产锁、《剧组产出册》工业台账、12节拍情绪曲线、二阶亲缘资产推导、2x2俯视空间机位图（CAM1~CAM4）、15秒打戏PREVIS、文戏情绪微表情、Canvas/API自动化工作流与P0~P2独立质检门禁。"
---

# 漫剧老李 AIGC 全流程 Skill · V6.5 Multi-Agent（全平台与多模型工业级导演系统）

版本：V6.5 Multi-Agent（多 Agent 平台与 Seedance 2.5 深度适配版）  
定位：面向抖音、红果等爆款短剧/漫剧工业化全流程的导演总控中枢。**全面兼容 OpenClaw、WorkBuddy、豆包智能体 / 扣子 (Coze)、Dify 等主流 Agent 运行环境**，**深度适配 Seedance 2.5、Seedance 2.0、即梦、可灵等主流闭源视频模型**。

---

## 一、 系统架构与专业规则库索引

```text
skills/short-drama-director/
├── SKILL.md                                 # 全局总控路由器、六步工作法与多平台兼容中枢
├── scripts/                                 # 辅助校验与可视化脚本
│   ├── check_package.py                     # 静态规则与完整性校验脚本
│   └── generate_emotion_curve.py            # 12 节拍全片情绪张力折线图自动绘制脚本
└── references/                              # 底层专业规则库（★=权威总控文件）
    ├── ★ asset-first-pipeline.md           # Asset-First 六阶段生产管线（★全局总控：P0~P5 唯一生产顺序）
    ├── ★ aspect-ratio-adaptation.md        # 画幅自适应路由（★全局总控：横/竖屏全流程裁决，用户指令优先）
    ├── ★ agent-platform-adapters.md         # 多平台 Agent 架构与国产工作流适配规范 (WorkBuddy/豆包/OpenClaw/Dify)
    ├── ★ model-adapters.md                  # 闭源视频模型适配层规范 (Seedance 2.5/2.0/即梦/可灵特性与契约)
    ├── ★ production-ledger-handbook.md      # 《剧组产出册》工业台账总控规范 (CHR/AUD/PRP/SCN/Uxx)
    ├── ★ emotion-beat-curve.md              # 12 节拍全片情绪张力与可视化曲线引擎
    ├── ★ spatial-topview-camera.md          # 空间顶视图与机位调度图规范 (2x2 四图合一/CAM1~4/180°轴线)
    ├── ★ character-lineage-and-sheets.md    # 角色资产板与亲缘/多梯队遗传推导规范
    ├── ★ screenplay-gate-engine.md          # 五阶门控剧本引擎 (Premise->Structure->Beat->Entity->Page)
    ├── ★ dialogue-doctor-7d.md              # 台词七维全量诊断与三段式理由重构引擎（★权威，下方普通条目已合并，不重复列）
    ├── ★ dialogue-speed-check.md            # 台词语速自检引擎（语速三档/速算公式/三档判定/五步流程）
    ├── ★ asset-spatial-ledger.md            # 16 项资产锁定(A/B/C分级)、短锚点(@asset_name) 与 3D 空间快照
    ├── ★ cinematic-dramaturgy-rules.md      # 电影级视听文法(镜头三任务/三大调度法则/剪辑六律/反形容词转译)
    ├── ★ action-previs-15grid.md            # 15 秒打戏完播潜力评分、动作强度三档(R1/R2/R3)、11 环动力链、防守三态
    ├── ★ xuanhuan-magic-combat.md           # 玄幻法术战斗体系（R3玄幻专用：法宝/五行术法/术法攻防/能量具象/对军清场）
    ├── martial-arts-arsenal.md              # 通用武学与兵器动作资料库 (23门徒手/9套剑法/太刀居合/长柄镰刀/轻功/修仙剑招)
    ├── camera-specs-15rules.md              # 15 秒完播率镜头规格、空间斜角与防穿模铁律
    ├── combat-direction-engine.md           # 通用武打动作导演引擎与完播率动力学 (现代/武侠/仙侠/二次元/科幻全题材)
    ├── combat-rhythm-defense3state.md       # 近景机枪对招、防守三态与大幅闪避法则
    ├── authentic-martial-taxonomy.md        # 全流派武学兵器库与 11 环杀招动力链
    ├── ★ martial-arts-combat-library.md     # 全门派武学 23 门 + 9 套剑法 + 兵器 + 轻功 + 修仙剑招
    ├── ★ wenxi-micro-expression.md          # 文戏情绪六阶段生理递进与对白语速保护 (3.5~5 字/s)
    ├── ★ camera-transitions-6types.md       # “三手法六式”镜头衔接体系与电影级视听省略
    ├── ★ seedance-render-engine.md          # 视频模型三层解耦、时长预算协议 (180s≈14~15组, 每组≤15s)
    ├── ★ comfyui-canvas-automation.md       # 闭源模型与 Canvas 工作流自动化对接引擎
    ├── ★ lighting-and-antifake.md           # 真实光线物理引擎与日景防棚拍假冷光规范
    ├── ★ quality-gate-review.md             # P0/P1/P2 三级独立质检门禁与声音三层相对电平标准
    ├── ★ prompt-feeding-checklist.md        # P4 投喂必查清单（★权威：六步执行序列，防只读单模板漏检）
    ├── action-cinematography-breakdown.md    # 华语动作神作拉片语法（景别阶梯/Eye-Trace/动势衔接/同向加速）
    ├── action-ultimate-finisher.md          # 终结技三幕结构 + 大招运镜 11 模式库 (A~K) + 特效生长三段论
    ├── anime-ultimate-vfx-paradigm.md       # 二次元大招三段式 + 双色粒子配色 + 抽象符纹防乱码
    ├── audiovisual-aesthetic-presets.md     # 六大电影级视听美学预设（诗意/纪实/港派/赛博/水墨/国漫）
    └── platform-safety-compliance-guide.md  # 平台安全合规转译词典（安全默认/强动作非血腥/成人级创作草案）
```

---

## 二、 核心特性：多平台 Agent 与多模型深度兼容

### 1. 多 Agent 运行平台适配
- **WorkBuddy 适配**：支持 P0 立项锁定 → P1 剧本门控 → **P2 数字资产包（资产图先于分镜）** → P3 空间调度 → P4 投喂 → P5 质检六阶段会话流转，自动挂载《剧组_资产图册.md》与 2x2 顶视图；
- **豆包智能体 / 扣子 (Coze) 适配**：支持输出结构化 JSON 块，自动分块（Chunking）防止对话上下文截断；
- **OpenClaw 适配**：原生 CLI 部署与 Tool-Call 完整兼容；
- **Dify / 通用大模型适配**：支持单文件 Prompt 独立运行模式。

### 2. 闭源视频模型适配（主推 Seedance 2.5）
- **Seedance 2.5**：全面支持 15 秒单段高动态生成、双图首尾帧（Start/End Frame）引导、Hit-Stop 物理碰撞顿挫感与 `[SFX: ...]` 原生音效标记；
- **Seedance 2.0 / 即梦 / 可灵**：支持单参考图绑定、5s~15s 提示词解耦与运镜控制参数映射。

---

## 三、 核心工业法则一览

0. **Asset-First 六阶段管线（最高原则）**：全流程严格按 `asset-first-pipeline.md`（★权威）执行 P0 立项锁定 → P1 剧本门控 → **P2 数字资产包**（提取全部实体 → 资产清单确认 → 角色/场景/道具分批出图锁定 → 交付《资产图册》）→ P3 空间调度+分镜 → P4 投喂生成 → P5 质检。**资产图先于分镜，无图不进分镜**（P2/P3 硬门禁）。

1. **剧本五阶门控 (Gate 1~5)**：Premise $\rightarrow$ 30%/50%/20% 结构 $\rightarrow$ 因果节拍表 $\rightarrow$ 世界观与实体边界 $\rightarrow$ 专业剧本页。
2. **《剧组产出册》工业台账**：标准化输出角色（`CHR-`）、声音（`AUD-`）、道具（`PRP-`）、场景（`SCN-`）与分集单元（`U01~Uxx`）。
3. **12 节拍全片情绪张力曲线**：量化 12 个因果驱动节拍点（0~10 分），锁定第 9 节拍 9.5+ 终极爽点反杀。
4. **角色资产板与亲缘推导**：A/B 级 16 项锁，T1（男女主）至 T2（亲属配角）40%~60% 骨相与五官关联遗传推导。
5. **空间顶视图与机位调度 (2x2 网格)**：俯视平面绘制走位与 CAM1~CAM4，180° 轴线防护与合法越轴。
6. **台词七维体检与语速自检**：对白 3.5~5 字/秒，留出 0.3~0.8 秒落口发酵空间，强制语速门禁扫描。
7. **打戏 15 秒动力链 PREVIS（R1/R2/R3 三档）**：0~1.5s 开局硬撞，11 环动力链，防守三态，最后一帧定格。**R3 玄幻档切换法术语言**——法宝媒介+五行术法+术法攻防+能量具象化+对军清场（见 `xuanhuan-magic-combat.md` ★权威），不硬套武侠物理打斗。
8. **时长预算前置协议**：3 分钟剧本强制展开为 14~15 组（每组 $\le 15$ 秒，单组独立可投喂生成）。
9. **P0~P2 独立质检门禁**：阻断超时、跳轴与后台词外显；对白 ($0\text{ dB}$) $>$ 物理音效 ($-6\text{ dB}$) $>$ BGM ($-14\text{ dB}$)。
10. **画幅铁律（用户指令优先）**：最终画幅比例一律以**用户指定为准**——用户说 16:9 必须全部走横屏模板并回填 `aspect_ratio=16:9`，严禁被示例/模板里的 `9:16` 或竖屏构图带偏；用户未指定时才默认 9:16（本 skill 定位竖屏短剧）。生成视频提示词、导出工作流参数、API 载荷时均强制执行。**全流程画幅路由见 `references/aspect-ratio-adaptation.md`（★权威）**。
11. **资产图册唯一事实来源**：《剧组资产图册》（CHR/SCN/PRP 全附资产参考图）是 P3/P4 的唯一权威事实来源；分镜/投喂引用的 `@锚点` 必须指向已锁定资产图，禁止以文字描述替代资产图。

---

## 四、 快速指令路由与模式切换

| 常用指令 | 对应功能与底层库调用 |
|---|---|
| **`/写剧本`** 或 **`初始化项目`** | 启动五阶门控剧本引擎，输出前提、因果节拍表与标准排版剧本。 |
| **`/剧组产出册`** 或 **`/生成台账`** | 启动 P2 数字资产包：输出《完整资产清单》→ 分批出图（角色/场景/道具）→ 交付《资产图册》（CHR/AUD/PRP/SCN/Uxx 全附资产参考图）。 |
| **`/数字资产包`** 或 **`/资产图册`** | P2 核心入口：提取全部实体 → 资产清单确认 → 分批出图锁定 → 交付《资产图册》。 |
| **`/情绪曲线`** 或 **`/情绪节拍`** | 启动 12 节拍情绪量化引擎，输出全片张力诊断表并生成情绪波折折线图。 |
| **`/角色资产板`** 或 **`/角色遗传推导`** | P2c·第一批：T1 男女主锁定脸模 → 亲缘推导 T2/T3 并**直接出图**（非文字描述）→ 交付三栏三视图资产参考图。 |
| **`/顶视图`** 或 **`/机位调度`** | 绘制空间俯视平面机位调度图，标注 CAM1~CAM4 编号与 180° 动作轴线。 |
| **`/做分镜`** | 自动路由文戏微表情流或武戏 15 格动力链 PREVIS，应用三手法六式衔接。 |
| **`/台词诊断`** 或 **`台词体检`** | 启动台词专科医生，输出角色语言指纹、七维诊断与三段式改写。 |
| **`/语速自检`** 或 **`台词语速检查`** | 启动 dialogue-speed-check 语速自检：拆句 $\rightarrow$ 计数 $\rightarrow$ 套档 $\rightarrow$ 判定。 |
| **`/生成视频提示词`** | 输出 Seedance 2.5 / 2.0 / 即梦 / 可灵 15 秒独立三层解耦提示词组（⚠️ 画幅必须以用户指定 16:9 或 9:16 为准，禁止默认回落竖屏）。**投喂前必过清单（按序）：① `seedance-render-engine`（三层解耦+时长预算）→ ② `aspect-ratio-adaptation`（画幅回填）→ ③ `camera-specs-15rules`（镜头五要素+景别阶梯）→ ④ 有对白必过 `dialogue-speed-check`（语速自检）+ `wenxi-micro-expression`（金句发酵）→ ⑤ 战斗段按档切 `xuanhuan-magic-combat`（R3玄幻）/ `action-previs-15grid`（武侠）→ ⑥ 出稿前过 `quality-gate-review`。完整执行序列见 `references/★ prompt-feeding-checklist.md`。** |
| **`/导出工作流参数`** | 导出适用于 WorkBuddy / 豆包工作流 / Canvas / API 的结构化载荷（⚠️ 载荷内 `aspect_ratio` 回填用户指定画幅）。 |
| **`跳过确认，直接出整集`** | **极速直出模式**：后台静默执行全套工业约束，前台直接输出无后台词污染的成品。 |
| **`/审查`** | 启动 P0/P1/P2 独立质检门禁与声音三层相对电平诊断。 |
