# 承接漏键与局部返修回执：完整结果协议 v1

## 原因

十次同类卡点不能算十次根治：此前逐次核源、登记免费边界review只恢复了本次任务，没有形成自动复核的产品路径。

1. `entry` 是本集消费者真正依赖的事项，前集 `exit` 不一定列全。137、27集连作者初稿都已漏对应状态；合并delta之前的exit也无法补出它们。缺失不等于相反，SOURCE标签本身也不等于语义验证。
2. INC-0007-R1 的delta正确重建了完整正文，却替换了采用owner；后续只读取局部反馈，完整尾态5项缩为1项，素材消费8项缩为0项。直接union旧entry/needs/conflicts/exit会复活失效内容，也不是通用修复。

## 通用路径

新协议 `production-feedback-result-v1` 在**原计划的整编调用**中完成，不新增审稿模型/调用，也不改变模型档位、预算停止线或专业质量约束。

- 新网页创建的production context保存能力版本，新run的规则快照也冻结版本；双重匹配才启用。旧run、旧规则、旧原生FINAL不自动升格或补写。
- 整编冻结实际采用基稿的hash、尾态、素材原consumer与原snapshot出处。`resultRevision`逐项保留、替换或退役；不能漏项、错基稿、假引文、替换后复活旧键，或删除仍由未改单元消费的素材。
- 完整有效尾态作为独立派生投影供下一集读取；素材变更门追溯原consumer的冻结供给，不能把R1的空素材回执解释成“原稿没有依赖”，也不能说R1自己新消费了8项。
- 旧entry/needs/conflicts不随正文谱系复活。完整重写可明确退役不再使用的旧依赖，不形成永久粘连。
- 同ID素材更新使用显式REPLACE退休旧消费世代并绑定本次新snapshot；原consumer出处与当前支持单元范围分离，单元改名不丢依赖。局部开场返修只继承当前范围，不因共享整集运输candidateId误带整集尾态。
- 已选真实前尾的SOURCE漏键，由原整编同时返回 `entryEvidence`：前尾与本次完成稿均有合法坐标、逐字引文和语义复核结论。只接受验证过的前源动作坐标，不用对白/guidance或DESIGN冒充。无证据/不确定/漂移继续阻断。
- 通过后仍保留 `missingKeys`，另记 `sourceReviewedKeys` 与绑定稿源身份的review hash；不向actual补键，不伪造继承，不把NOT_CONSUMED写成MATCHED。已知actual/锁定约定/明确冲突仍优先阻断。

`nativeBoundaryEntryReview`校验的是**已有原整编的语义复核证据**。逐字证据合法不是自然语言结论必然正确，不能把机器校验当作源文保真、视听质量或用户验收。

## 代码入口

- `runtime/storyboard-v4/core/production-feedback-result.mjs`：冻结谱系、完整结果决策、派生尾态及素材consumer。
- `runtime/storyboard-v4/core/pipeline.mjs`：公共采用路径（包括恢复/重校共用）、素材变更门、免费刷新、只读冻结请求重建。
- `runtime/episode-boundary.mjs`：真实尾态选择与原整编SOURCE证据复核；旧人工review路径仍保留。
- `runtime/storyboard-v4/core/core.mjs`：新规则冻结、原整编schema/提示与基稿传输；无新版本的历史请求字节保持。
- `lib/storyboard-service.ts`：只对新创建网页run声明能力；不修改运行中coordinator或在途快照。

## 离线验收与部署边界

新增用例：R1局部delta保全、逐键替换/退役、错误基稿/错hash/假引文拒绝、原素材consumer变更、恢复/刷新幂等、SOURCE合法证明/缺证/旧协议/已知冲突/前尾漂移，以及真实公共采用路径。所有modelRunner均为本地合成桩；不使用生产engine恢复或重校接口冒充回归。

已付回包审计私有证据：`runtime-3008/moushi150-monitor-20261018/generic-native-audit-20261018T174140273Z.json`。10份冻结请求的提示、schema和三指纹相同，20个原生文件字节保护；确认旧R1仍为5→1/8→0的历史回执，未制造新协议原生证明。原回执与旧稿保留。

**当前运行中内核尚未加载本补丁。** 原生ESM有缓存；HMR仅更新hook/读层，不证明旧coordinator升级。`shutdown()`会cancel在途，不可用于本次切换。现有stop(drain)也不是全部CLI回包自然排空，不能以旧维护脚本、PID或锁文件操作冒充安全热更。

本次先交付源码与离线证据。原任务自然进入安全空闲后，再新鲜核PID/cwd/租约/真实在途/共享DISPATCHING/模型进程/数据库任务，按既有安全入口冷加载；不能以本文件或测试PASS声称已经在线生效。若要求运行期间提前切换，还缺保原授权的维护静默门与恢复证明；不得擅自扩大本轮工程范围或费用权限。

历史原生FINAL没有新协议证明时保持严格；本补丁不自动补造旧R1尾态，也不重买稿。新的真实矛盾、重要源文裁决和未知费用仍可能需要人工决定。需将“通用源码/离线已验证”“当前内核已加载”“真实生产验证”分别列入最终改进清单。

## 后续监督

原自动化3008-150保持原队列、授权和10分钟间隔。每次返回实际文字采用X/150（在途、PRELIMINARY及阶段回包不计入）。最终列出事件号、人工动作次数、额外唯一attempt及input/cache/output/total、原生FINAL耗时与等待墙钟、费用未知null，并按通用能力及仍需人工的缺口区分。本次工程离线验证新增生产调用0、额外生产Token0；不代表原计划制作或Codex工程推理本身没有资源消耗。
