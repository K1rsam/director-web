---
name: unit-duration-policy
description: 项目级 Seedance 单元时长硬门槛与稀有短单元例外
stages: [E3, E4, E5]
---
# Seedance 单元时长政策

- 常规生成单元优先 `13-15秒`；`15秒`是硬上限。
- `10秒`是项目默认下限。低于 `10秒` 默认按 `BLOCKER` 退回，不得只补写一条理由放行。
- 只有明确且不可合并的极少数例外可以低于 `10秒`：场/时空边界、极短反应、道具落点、快速动作切点、声音/视角打断、避免说话人或状态漂移、避免单元超载。
- 例外必须使用 `SHORT_EXCEPTION/<CODE>|<具体不可合并事实>`，允许的 `<CODE>` 为：`SCENE_BOUNDARY`、`SHORT_REACTION`、`PROP_LANDING`、`QUICK_ACTION_CUT`、`SOUND_VIEW_BREAK`、`DRIFT_PREVENTION`、`OVERLOAD_AVOIDANCE`。
- “本场分镜时长组合余数不足12秒”“场次边界余数”等泛化理由无效。
- 低于 `4秒` 一律退回；每集短例外最多 `min(2, max(1, floor(单元数×10%)))` 个。
- E3/E5 必须以确定性校验结果为准，不得用模型主观裁定覆盖上述门槛。
