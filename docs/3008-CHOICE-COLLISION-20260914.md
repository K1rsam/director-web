# 2026-09-14：成功 Q1 落库冲突与等待选择的重复修复

## 真实故障

用户再次看到“继续完成”。实际任务处于 PARTIAL：Q1 模型调用已 SUCCEEDED，随后 `syncFoundationChoices` 写入 `presentationContract` 报主键唯一约束错误。不是模型没运行，也不是剧本格式错误。

F2 先保存的问题已由 controller 降为 SUGGESTED；Q1 再次提出同一来源、问题键、选项和场范围的必要选择。同步只匹配 PENDING，忽略 SUGGESTED，因此再次创建同一确定性 ID。

此前覆盖了普通首次保存、局部修复和短样本真实调用，没有覆盖 F2 建议被 Q1 再次提出的状态转换。这是验收缺口。

## 修复

- 同身份 SUGGESTED 参与复用；F2 重复保持建议，Q1 明确要求作者决定时提升为 PENDING。保留行 ID，不覆盖已确认答案，不混合不同选项/来源/范围。
- 每次写入刷新批内缓存，避免不同原始范围扣除已确认范围后收敛为同一范围时重复创建。
- 另发现 Q1 已要求选择时，自动修复队列仍把对应 UNRESOLVED preparation 当作修复目标。现在等待选择的关联范围不重复请求；独立字段、其他集及有明确引用的不相交场仍可修复。
- 现有 preparation 没有 decisionId：按明确选择范围和素材场引用判断，缺少引用时保守按集等待。未知选择范围不扩成全局；原始问题仍保留，不伪报全部完成。

## 现场恢复

先备份数据库，在独立副本上重放既有成功响应，再对原任务执行相同恢复。恢复前已核对无活动运行。

实际结果：Q1 已保存覆盖从 0/30 到 30/30；任务 WAITING_USER、error 为 null、必要创作选择 1 项。模型新增调用 0，运行记录新增 0，集 ID、编号和正文哈希一致。没有代替用户选择方案，也没有重新购买 Q1。

## 验证

- 新增 `verify-foundation-choice-idempotency.ts`：SUGGESTED 复用/提升、重复调用、同批范围收敛、确认不可改、选项与来源隔离。
- 新增 `verify-foundation-decision-wait.ts`：等待选择不重复修复、独立问题继续、场范围与未知范围保护。
- 新增 `verify-foundation-decision-wait-controller.ts`：真实隔离 controller 中 F2 建议、Q1 重提选择与未决素材得到 WAITING_USER，只调用 F2/Q1；有另一独立引用缺口时只追加对应局部修复，选择保留且原文不变。主控独立复跑通过。
- 既有 `verify-foundation-choice-runtime.ts` 的旧 fixture 只修改 legacy episodes，实际 applicationScope 未变。用 HEAD 原代码和原 fixture 独立复现失败，再迁移 fixture 到明确范围协议；HEAD 原代码与修改后代码均通过新 fixture，没有通过削弱生产校验掩盖失败。
- 主控再次复跑自动拆场与越界保护用例；构建和类型检查按最终版本执行。

原始响应、数据库副本及恢复脚本留在被忽略的本机 runtime-3008，仓库不包含用户剧本或数据库。后续回归必须覆盖岗位之间的状态转换与成功响应提交，不能仅测试单岗位格式。
