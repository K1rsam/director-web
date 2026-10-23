# 3008 对白保真与后期编辑隔离

本轮在本机既有未提交基线上吸收接点发布提交 `d48e6c5a65df8f17a6b55e414fe652819bc97c0a` 的13项业务差异，不复制发布副本的AOCI资产、不替换本机维护、来源重组及零模型恢复修改。

## 新任务协议

新快照为 `editingHandoffVersion=shot-handoffs-v1`、`generationTextVersion=voice-delivery-v1`，执行稿继续 `seedance-execution-v4`。接点按当前完整稿哈希取相邻两镜与原分段，实际picture/camera/transition写切断/继续相位、离画边、稳定去向、再入画/接触；索引本身不判断语义合格。

对白仍逐字绑定冻结quote，包含原标点、引号与连续分片；说者、声道、源cue/performanceCues保留。3008原本不会给所有speech自动复制cue，本轮修的是vocalization执行标签可带出原cue的出口，并强化三岗演法分层。新稿标签采用稳定声型，真实演法由作者写入delivery/picture/sound；不靠非空字段证明保全，不通过删词或关键词黑名单清洗正文。用户报告的问题稿不在本机，属于预防修复，不声称已经定位那份稿的具体改词事故。

人名/身份条及指定后期编辑叠字写在对应镜头 `postproductionNotes:[{text,sourceRefs}]`，text完整交代准确文字、位置/占幅、样式与入驻退触发。它是单独的编辑资料，不进入通用提示词、单元/分段头、初末态或六栏，连“后期加XXX”的占位说明也不写。没有项目写[]，不创建空表。

后期项目沿原镜头对象穿过分包、完整delta替换、未改保留组和15/30秒容量合并；无需另建顶层合并协议或模型岗位。原源行、onscreenTexts、源事实与引用仍保留，目录不等于逐项上屏。真实牌匾/信件/系统面板、生成负责且确已采用的其它字卡，以及原对白确实提到后期或人名条，按语义和既有决定分别保留；不删源、不新增旁白、不提前揭示。分类和许可仍由读源/采用决定/实际稿审阅，程序只查结构与源坐标。

## 独立交付

- 单集鉴权GET：`?runId=<id>&format=postproduction`，下载名 `postproduction-notes.md`。沿用Markdown的项目权限、冻结任务归属、源版本、必要实际承接及整编完成门。旧无协议任务409，无项目404；不会为了生成空表调用模型。
- 连续制作交付：有项目的集附带 `episodes/episode-xxxx/postproduction-notes.md`，文件与哈希登记在原manifest；生成正文和complete.md不拼接编辑说明。
- 旧无marker的请求、schema、执行稿与既有交付不回迁、不换版、不重跑；旧源与操作指纹仍按原快照重建。3008已有独立源/请求冻结，不复制独立Skill的bundle源锁或改造原生回执。

## 维护同步与验证边界

对照独立Skill路径 `/Users/yue/Documents/ChatGPT/豆包3D/.agents/skills/series-storyboard-director`：v6.5.2接点规则及 `20261023-v6.5.3-dialogue-postproduction` 的对白核源、原声提示不自动投影和独立后期交付已吸收；保留3008三岗、真实输入、冻结请求、选择/取消、队列与收费控制。未复制独立Python/网页/数据库、增加审稿岗位、重做第一阶段或开启生图。

验证包括新行为RED→GREEN、合成真实engine计划/主创/delta整编/容量合并/v4投影、下载与自动交付、旧请求指纹与原稿/回执保全；合成runner只返回固定示例，无provider调用。这证明通道与保全，不证明真实模型已经主动修好任意镜文或成片效果。工程回归、实际冷加载、鉴权运行身份及生产前后对账分别记录在本机私有集成报告，不以本文或HTTP存活代替加载证据。
