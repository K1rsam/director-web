# 漫剧老李 AIGC 全流程 Skill · V6.5 Multi-Agent（Short-Drama Director Suite）

面向竖屏短剧、AI 漫剧、短视频剧集全生命周期的工业级导演总控技能包，供 AI 助手 / LLM 调用。
覆盖：**Asset-First 六阶段管线**（立项锁定 → 五阶门控剧本 → 数字资产包 → 分镜 → 视频提示词渲染 → 独立质检）。

> 🔑 **核心理念：资产图先于分镜。** 角色/场景/道具在 P2 数字资产包阶段完成**出图并锁定**（非文字描述），成为《资产图册》唯一权威事实来源，分镜/投喂一律引用已锁定 @资产图。

> **品牌**：漫剧老李 AIGC 全流程 Skill
> **版本**：V6.5 Multi-Agent（多 Agent 平台与 Seedance 2.5 深度适配版）
> **技术标识**：`short-drama-director`（OpenClaw 命令路由用，保持不变）

> ⚠️ 本包是 **给 AI 助手执行的规则库**（OpenClaw Skill / Agent 技能包），不是面向消费者的成品剧本。
> 把 `SKILL.md` 与 `references/` 一起放入你的 Agent 技能目录即可使用。

---

## ✨ 能力总览

| 阶段 | 模块 | 功能 |
|---|---|---|
| 管线 | `asset-first-pipeline` | **Asset-First 六阶段（★权威）**：P0~P5 唯一生产顺序，资产图先于分镜 |
| 画幅 | `aspect-ratio-adaptation` | **画幅自适应路由（★权威）**：横/竖屏全流程裁决，用户指令优先 |
| 平台 | `agent-platform-adapters` | 多 Agent 平台适配（OpenClaw/WorkBuddy/豆包Coze/Dify）+ 豆包 JSON 分块 |
| 剧本 | `screenplay-gate-engine` | 五阶门控（前提/结构/节拍/世界观/专业排版） |
| 台词 | `dialogue-doctor-7d` | 台词七维诊断与三段式重构 |
| 台词 | `dialogue-speed-check` | **强制语速自检**（三档语速/五步流程/拆镜） |
| 资产 | `asset-spatial-ledger` | A/B/C 分级资产锁 + **分批出图执行规范（角色/场景/道具）** + 3D 空间快照 |
| 资产 | `character-lineage-and-sheets` | 角色资产板 + T1→T2→T3 亲缘推导**直接出图** |
| 台账 | `production-ledger-handbook` | 《剧组资产图册》CHR/AUD/PRP/SCN/Uxx + **资产参考图** 工业化台账 |
| 情绪 | `emotion-beat-curve` | 12 节拍全片情绪张力量化 + 可视化曲线 |
| 空间 | `spatial-topview-camera` | 2x2 顶视图机位调度（CAM1~4）+ 180° 轴线 |
| 分镜 | `action-previs-15grid` | 15 秒打戏完播潜力评分 + R1/R2/R3 三档 + 11 环动力链 |
| 分镜 | `xuanhuan-magic-combat` | **玄幻法术战斗（R3专用）**：法宝/五行术法/术法攻防/能量具象/对军清场 |
| 分镜 | `combat-direction-engine` / `combat-rhythm-defense3state` / `camera-specs-15rules` | 武打导演引擎 / 机枪节奏防守三态 / 镜头规格 15 铁律 |
| 分镜 | `wenxi-micro-expression` | 文戏情绪六阶段 + 对白保护 |
| 武学 | `martial-arts-combat-library` / `martial-arts-arsenal` / `authentic-martial-taxonomy` | 23 门武学 + 9 套剑法 + 兵器 + 轻功 + 11 环杀招 |
| 衔接 | `camera-transitions-6types` | 三手法六式镜头衔接 |
| 渲染 | `seedance-render-engine` | 三层解耦提示词模板（16:9 / 9:16，Seedance 2.5） |
| 适配 | `model-adapters` / `comfyui-canvas-automation` | 闭源模型参数适配 + Canvas/API 工作流对接 |
| 合规 | `platform-safety-compliance-guide` | 安全风控转译词典（降低风险，不承诺 100% 通过） |
| 质检 | `quality-gate-review` | P0/P1/P2 独立门禁 + 声音相对电平 |

完整模块清单与权威文件路由见 `SKILL.md`。

---

## 🚀 快速开始（给 AI 助手）

1. 读取 `SKILL.md`，按“六步工作法”执行；
2. 先定**动作强度档**：`R1 写实克制` / `R2 商业高燃（默认）` / `R3 玄幻大招`；
3. 有对白 → 先过 `dialogue-speed-check` 语速自检；
4. 查 `model-adapters` 当前平台能力；
5. 直投公开平台 → 走 `platform-safety-compliance-guide` 安全默认档转译；
6. 交付前过 `quality-gate-review`。

## 🧮 常用指令（SKILL 内注册）

`/写剧本` · `/台词诊断` · `/拆资产` · `/做分镜` · `/语速自检` · `/生成视频提示词` · `/审查` · `跳过确认，直接出整集`

---

## 📦 安装

```bash
# OpenClaw
openclaw skills install ./short-drama-director --as short-drama-director
```

其他 Agent 框架：把整个目录放入技能目录，并在系统提示中引用 `SKILL.md`。

## 🧹 质量自检

仓库内置 `scripts/check_package.py`：

```bash
python3 scripts/check_package.py
```

检查：CR/箭头损坏、孤立 Markdown、模块数量、时间轴一致性、危险词、IP 词等。

---

## 🧱 结构

```
short-drama-director/
├── SKILL.md                     # 总控路由 + 工作法 + 模块清单
├── references/                  # 32 个专业规则库
├── scripts/
│   ├── check_package.py         # 静态自检脚本
│   └── generate_emotion_curve.py# 12 节拍情绪曲线绘制脚本
├── README.md
├── LICENSE
└── CHANGELOG.md
```

## 📄 License

见 [LICENSE](./LICENSE)。

## 🙏 致谢与使用约定

- 本包整理自 AI 短剧/漫剧工业化生产实践，供创作学习使用；
- 涉及真实武术流派、历史地点仅作创作参考；
- 输出内容需自行遵守所在平台的内容规范与版权要求。
