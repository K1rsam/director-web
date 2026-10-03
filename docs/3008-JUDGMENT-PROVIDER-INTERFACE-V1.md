# 语义判断接口 V1：Jev与无Jev替换说明

2026-09-28。对应`lib/semantic-judgment.ts`。本轮实现provider边界、关闭模式、结构校验、校准gate和缓存键；**尚未接入第一阶段/网页，也没有实现自动CLI回退或持久化缓存**。后续供应商变化不应迫使标准剧本包和第三阶段一起改。

## 1. 四个责任边界

1. 程序提供最小必要原文、真实候选和源版本；做格式、引用、数字、覆盖及保真检查。
2. provider只返回有限判断，不重写剧本。
3. gate按实际评测的策略决定是否需要复核；没有策略默认review。这个gate不代替原文保真、权限或制作可用性门。
4. 业务调度决定采用、补候选、调用现有P1/Q1局部推理、等待或向用户核对；provider不得偷偷重试/重跑全剧。

## 2. 请求接口

```ts
type SemanticJudgmentRequest = {
  scope: { accountId: string; projectId: string; sourceVersion: string; questionVersion: string };
  state: string | JsonObject | JsonArray;
  questions: Record<string, ChoiceQuestion | NoulQuestion | ScoreQuestion>;
};
```

这是说明性签名，项目完整TS类型见源码。scope来自受信服务端上下文；不要把认证凭据放进state。questionId只定位结果，**不会作为问题内容送给模型**；instructions必须独立完整。相互依赖的问题分请求，不能假定同一batch后题看到前题答案。

| 问题 | 字段 | 用法 |
| --- | --- | --- |
| choice | type=choice、instructions、criteria对象 | 从已有候选ID选择，通常包含none/unknown。仅真正完备集合可显式candidateCoverage=complete-set |
| noul | type=noul、instructions、可选true/false条件 | 一个是/否命题；Jev返回P(yes)，不是“程度” |
| score | type=score、instructions、2–10个有序描述 | 仅有明确排序消费者时使用，不用综合分掩盖严重错误 |

Choice最多255选项。`candidateCoverage`是本项目元数据，不传给官方HTTP接口；它是调用者对候选集合的声明，不是模型证明。源里可能有漏提实体时必须保留未知/补提出口。

## 3. 统一结果

共同字段：`status/reason/scope/requestFingerprint/providerId/probabilityKind/model/answers/usage/httpStatus/policyVersion`。

| status | 含义 |
| --- | --- |
| review | 已得到类型化答案但未通过对应校准策略，或未知/低把握；不能自动变成源事实 |
| complete | 显式匹配的gate通过；**不是事实一定正确、全剧已审完或允许调用第三阶段** |
| unavailable | 关闭或缺凭据；没有发起本次模型请求 |
| failed | 请求/响应/网络/服务/超时等失败；不是no、空资料或PASS |

answers保留每题原始分布与规范化值：

- Choice：choice、probabilities、confidence。
- Noul：Jev为noul数值、decision=null，没有独立confidence；无概率替代后端可以提供noul=null与decision布尔，但仍须业务校验。
- Score：score、probabilities、confidence、legend。字符串等级必须与请求同值；结构化等级仅接受JSON深等价结构或其JSON编码字符串，不能接受自由摘要后假设次序相同。规范legend从请求重建。

probabilityKind区分`jev-distribution / self-reported / none`。普通LLM自报0.99不是Jev校准概率；不能复用Jev阈值。即使unknown/none概率很高也保留review，它最多说明候选里没有合适答案，不赋予身份合并/原文删除权限。

usage.inputTokens/outputTokens只保存合法已知计数，未知为null。异常响应即使model字段缺失，也保留已收到的合法计数；没有完整回包时不编费用。调用数、请求是否发送和费用由业务审计另记，不能把Token数当价格。

## 4. 实际导出函数

```ts
createJevProvider({ apiKey, fetch?, timeoutMs?, model? }): SemanticProvider
createDisabledProvider(): SemanticProvider
semanticRequestFingerprint(request): string | null
validateSemanticResult(request, candidate): SemanticJudgmentResult
gateSemanticResult(request, candidate, policy?): SemanticJudgmentResult
buildSemanticCacheKey(request, { providerId, modelVersion, policyVersion }): string | null
```

`SemanticProvider.evaluate(request)`返回Promise结果。构造与导入无推理副作用；Jev仅在显式evaluate时发送一次请求。每次调用固定本次key/fetch/model/timeout快照，发送和返回消毒使用同一份配置；在途轮换不能让旧凭据漏出，新配置只影响后续调用。端点固定HTTPS，禁止跳转携带凭据；Authorization只在header，错误正文不回显。默认不重试，超时覆盖响应读取；响应体上限2MiB，超量取消并失败。

Jev的真实HTTP边界为POST `https://api.typesafe.ai/v1/systemone`，body只含state/model/questions，返回model/answers/usage。本项目没安装新SDK，使用Node fetch封装；官方协议变更先更新provider，不让业务直接依赖供应商原响应。[官方API](https://docs.typesafe.ai/api)

## 5. 无Jev版本怎样替换

### 路径A：程序快通道＋现有P1/Q1处理歧义（最少新依赖）

- 已知场头、明确标记、精确引用、既有唯一别名、格式/数字/版本检查交程序。
- 程序不能确定的对象进入现有P1/Q1局部工作，保持源片段与允许字段，不全文重写。
- Jev关闭不应阻止保存原稿、零模型预览、查看旧成果和其它独立可完成对象；该业务调度仍待接线。

### 路径B：普通模型的有限结构化回答

复用现有本机CLI/API，给相同scope/state/候选和完整问题，只要求候选ID、布尔或有序等级；原文仍由程序复制。适配器负责映射为共同结果，并使用`semanticRequestFingerprint`生成绑定，再调用`validateSemanticResult`。

```ts
// 伪代码：没有调用CLI，也不是已实现的回退器。
const fingerprint = semanticRequestFingerprint(request);
// 1. 用现有执行器取得受约束的原始答案；保留回包。
// 2. 映射providerId、实际model、scope、fingerprint和typed answers。
// 3. 没有可靠概率时：probabilityKind="none"，相关概率/confidence为null。
// 4. validateSemanticResult(request, candidate)；默认review。
// 5. 由该后端自己评测过的业务策略处理，不套Jev gate。
```

Jev gate当前只适用于匹配的Jev分布、模型与问题版本；非Jev策略未实现，不伪造通过。后端选择由服务端注册表控制，不能让浏览器伪造providerId或自行声明“已校准”。

### 任务与替代方案对照

| 原用途 | 无Jev最近似方案 | 注意 |
| --- | --- | --- |
| 段落类型/边界 | 规则明确部分直接处理，歧义局部Choice式提示 | 混合块留混合/未知，不强塞一类 |
| 断行续句 | 相同说者/明确结构先判，模糊处问有限是/否 | 不因拼块决定擅删原始分隔符 |
| 人物/变体归属 | 源名/已证实别名精确匹配，余下候选交现有模型 | 候选缺失先补提，不把none当该人物不存在 |
| 证据支持/冲突 | 程序定位原句，再局部推理核支持/矛盾/不足 | 字面存在不代表语义支持；AI互相同意不等于真值 |
| 复核优先级 | 明确严重性/影响范围先用程序排序 | 无评分校准不照抄概率阈值 |
| 全剧方向定稿 | 同版完整覆盖后一次简短综合＋真实确认 | 不用局部标签多数票代替全剧情绪判断 |

真正的外观、空间、表演与分镜仍交创作模型；它们本来就不应依赖Jev生成。

## 6. gate、缓存与故障合同

- gate要求policyVersion/calibrationId/providerId/modelVersion/questionVersion及每题阈值都匹配；这些字符串本身不证明真实校准，生产必须从受信评测/策略存储读取。
- 没有通用0.9阈值；Noul中间值待复核，Choice/Score看各自分布。不把不同模型、不同问题或两种概率定义共用阈值。[官方置信度](https://docs.typesafe.ai/confidence)
- 缓存key覆盖账号、项目、源、实际state、问题/候选、问题/策略和固定模型版本；latest/default/auto/stable别名不作为不可变版本缓存。这里只生成key，尚无持久缓存实现。
- 401/422/429/529、超时、非法JSON、缺题、非法概率、未知候选、超量响应分型处理，不回显带凭据的原错误；失败无自动付费重试。
- 来源或候选变化后旧结果失效。未知费用保留；不要靠重复点按钮或自动换provider掩盖结果不明。
- 真剧本外发TypeSafe前须有项目授权与最小片段范围；合成接通测试不是自动获得真剧本外发权限。

## 7. 替换供应商的验收

同一批有人工标注的中文剧本难例，对比候选召回、自动接受覆盖、错说者/声道/事实归属、保真与异常回退。全部输入/输出和回退计入合格包总成本/时延，不能只比单个回答长度。

当前离线测试覆盖的是接口、约束、降级与失败行为，不证明业务准确率。若真实连接测试另有记录，也只证明合成请求能往返，不把一个0.97写成剧本97%准确率。

后续接口有实质变化新增V1.1/V2；依赖方按版本适配，旧说明与回执保留。第三阶段只消费可靠标准资料，不必感知Jev是否存在。
