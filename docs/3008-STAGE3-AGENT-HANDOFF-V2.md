# 第三阶段上游消费补充 V2

2026-09-28。只追加至V1，不取代旧协议文档；未来用户通知第三阶段新版后，以此逐项核对新版真实消费者。

## 当前3008接线

新任务binding：`inputProtocol=upstream-material-v2`。旧`standard-episode-v1`和无标记/`legacy`继续原方法，不能统一重算旧inputHash。

共享入口：`lib/episode-upstream-material.ts::readProductionEpisodeHandoff`。前端按集预览、下载、新任务准备均走它。访问授权在页面/API完成；只读入口不生成、不确认、不写任务。非生产来源条目不能当制作正文。

基础包仍含原文、标准包/保真回执、场次、必要资产、前情、事实和已确认条件。新增：

```ts
packet.upstream = {
  version: 'EPISODE_UPSTREAM_V1',
  seriesDirection: { status: 'CONFIRMED'|'UNCONFIRMED'|'STALE', projection: null|{
    schemaVersion, id, revision, sourceVersion, cardHash, brief
  }},
  assetDesigns: [/* 本集相关状态，供页面核对，不整份送模型 */],
  modelDesigns: [{ assetKey, adoptionVersion, brief,
    materialAvailability: 'TEXT_ONLY'|'REFERENCE_AVAILABLE',
    references: [{id, description, available}]
  }],
  policy: '表达/设计非剧情事实；参考说明不等于读取图片像素'
}
```

`materialVersion`保护预览→下载期间的资料一致性，不代替第三阶段的语义指纹。

## 第三阶段必须尊重的边界

- 只用已确认的全剧brief。新草稿不能替换在用方向；主调不覆盖原文事实、对白、揭示时间，也不强迫每集同一种情绪结构。
- 只用本集/必要派生依赖中有效采用的简述。提示词READY不是采用证明；过期/撤销记录不能成为新任务输入。设计补足不是作者设定或剧情事实。
- 参考文件仅能说明文件可用与用户填写说明；没有多模态读取就不得说看过图像，更不能由文件存在推断成片质量。
- 备注、关系背景、情绪线索、知识揭示、空间约束与创作指导保留为辅助，不当说者。辅助`contextRefs`不能自证`entryFacts`。
- 新协议增加可引用的背景/历史上下文行，原句与坐标不改写。只能核对到本集/前场正文的内容才作为源证据，其余保守标为guidance；不能因为一句话来自背景库就强制解释成当前可见事实。
- 输入身份只跟随实际消费材料变化。无关全剧文档修订、其它集设计或新草稿不能使本集成果无故陈旧；本集解析、有效方向、采用设计与必要上下文变化必须识别。

## 标准包兼容

普通节点仍使用`DIRECTOR_STANDARD_SCRIPT_SLICE_V1`和既有V1回执。明确同行多说者`DIALOGUE_GROUP`及冒号后的表演提示/声道头使用`STANDARD_SCRIPT_PLAN_V2`/`DIRECTOR_STANDARD_SCRIPT_SLICE_V2`；源物理行索引保持V1。存在后置提示才加`receipt.checks.postColonCues`，既有普通V1和不含后置提示的GROUP V2回执保持原值。

GROUP父节点拥有完整源行，子对白仅引用自身说者/声道/正文片段，不重复计入字符覆盖；接收端校对每条物理行证据。引号内假说者、合并行伪证、丢失对白不得通过。手工核对不能把整个GROUP改标动作/备注来绕开对白。

新路径可接收`姓名：（表演提示）台词`，如“林岚：（压住颤音）我不是来认输的。”拆为源cue与纯台词，仍逐字绑定原句，不运行时偷剥正文。只有声明说者/明确音轨证明的头有效；双cue、嵌套、混用不明声道或引述内容明确诊断。旧`standard-episode-v1`的接收和事实解析显式`postColonCue:false`，不重写旧任务材料。

## 留给新版第三阶段的进一步优化

1. 将已采用设计简述明确用于演员/空间/道具连续性，而不复制整份素材提示词。
2. 输出缺少的具体素材需求，定位主体/变体/集场，回流第二阶段；源文或身份歧义才回第一阶段。
3. 增加对未来信息泄露、旁白无实体入场、状态解除时间和关系指代的真实语义评测。
4. 如果新版改用不同证据模型，迁移须保留来源域、原句、坐标与辅助/事实边界，不能把旧guidance全提升为facts。
5. 当前未改创作岗位、审查评分或自动重跑；新增消费桥接不是第三阶段全栈重构完成。

具体实现事件追加于 [变更台账](3008-STAGE3-CHANGELOG.md)，新稿测试记录见 [整合报告V3](3008-UPSTREAM-INTEGRATION-20260928-V3.md)。
