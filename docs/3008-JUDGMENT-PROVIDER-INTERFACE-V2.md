# 局部解析判断接线与无Jev替代 V2

2026-09-28。补充V1的纯接口，旧文保留。业务生产准确率未校准，默认所有候选仍由人确认。

## 实际调用边界

入口为`script-reception/route.ts`；服务`lib/script-resolution-service.ts`，Jev适配`lib/script-resolution-judgment.ts`，保真应用`lib/script-resolution-plan.ts`。actor取登录会话，sourceVersion取当前原文，不接受客户端伪造“已确认/已校准”或完整改写稿。

人工核对最多连续101行；模型建议一次选择最多30行，最多32行含邻接上下文、6000字符。只判8个受控类型之一或UNKNOWN：动作、对白、连续性、情绪线索、关系背景、知识揭示、空间约束、创作指导。说者与声道由原文头解析，不能由Jev自由创作。

服务端可选项目原CLI/API或Jev。Jev需单独明确外发同意，凭据仅服务端；未配置是NOT_SENT，不自动回退。固定模型版本由服务端配置；模型/问题版本变化后不能拿旧概率称已经校准。

## 请求/返回的最小形状

```ts
type Input = {projectId,episodeId,provider:'CLI'|'API',episode,
  startLine,endLine,lines:[{line,text}]};
type Judgment = {choice:null|{type,speaker?,channel?},note,usage?};
```

Jev使用一个Choice问题，显式UNKNOWN。回执含requestedModel/actualModel、概率类型、分布/置信度、数值用量或null、requestFingerprint/questionVersion及NOT_SENT/RESPONDED/UNKNOWN；不包含密钥、原始stderr或隐藏推理。

外层记录RUNNING、CANDIDATE、NO_SUGGESTION、NOT_SENT、UNKNOWN、ERROR、STALE。原文或核对修订改变，候选只保留历史不再应用。已发送但结果未知不等于没消耗。

## 防重复与恢复

- 同项目/集/源版本/核对修订/行范围/服务/问题版本构成尝试范围；当前尝试CAS占位，运行中拒绝重复。
- 已返回建议只读找回，不再次收费；没有建议也保留其回执与已知用量。
- 执行进程消失或35分钟租约过期标为UNKNOWN，不自动重跑。用户明确风险并携带旧attemptId才可重试；迟到旧结果只能进不可变审计，不能覆盖新尝试。
- 手工核对始终可用。确认调用程序保真编译；所有字来自原范围。未知/混合边界不靠整稿生成修补。

## Jev不可用时

1. 首选直接人工核对局部类型，不消耗模型，也不改变标准包协议。
2. 选择现有项目CLI/API提供同形状候选，不能伪造Jev概率；没有可靠概率就为null。
3. 若替换其它服务，实现相同judge回调即可，保留源范围、尝试记录、UNKNOWN恢复和保真确认层。新服务需自己的评测，不能照搬Jev阈值。
4. 不删除Jev历史；第三阶段只消费最后通过确认/编译的材料，不依赖当时用了哪家服务。

参考官方接口：[API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)。本轮只有离线假服务验证，未发真实Jev请求或读取凭据值。
