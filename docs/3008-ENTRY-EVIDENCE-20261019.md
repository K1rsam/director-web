# 3008 通用入口携证复核（ENG-0003）

状态须分列源码、离线回归、冷加载和原队列生产实证；本文不能代替运行证据。

## 合同

- 新正常整编双 marker 启用 `boundary-entry-review-v3`。`adopted-entry-context-v1` 绑定选定前稿全文、来源、尾态版本和采用谱系，只供证据，不写入 `actual.states`。
- `production-entry-basis-v1` 收集当前范围已付入口，包括前次失败回包。整编逐项 `KEEP/REPLACE/REMOVE`；同键和改键都不能改变 SOURCE/DESIGN 等级。有效退休不在下次基稿中复活。
- `actualDecisions` 完整核对 SOURCE/DESIGN 实际状态与本稿开场，防止作者和整编同时漏报消费。非直连关系不按晚段同词推断继承。
- 逐字证据支持同义状态、SOURCE/DESIGN 缺键和仍消费的旧入口。坐标、正文、来源、前稿或谱系漂移即失效；空入口、空 basis 也不能回退为无条件 `NOT_CONSUMED`。
- 必需差异/漏键证明必须齐全；同值 SOURCE/DESIGN 入口可另携有效证明，逐项校验并原样保留，不能因“多给证据”误拦。额外证明的未知键、坏引文、未决或真实冲突仍关门，不靠过滤原回包放行。
- `KEEP.currentEvidence=[]` 可复用同一原生回包中明确同键 `CONSUMED` 的 actual 消费引文，派生投影记录 `coverageEvidenceSources`。仍完整校验 actual、等级、前稿及开场；非空坏证据、改键、替换或删除不能借此绕过，不回写原回包。
- 新协议失败持久关门，不触发额外收费 full fallback。免费重校后只有通过边界的当前有效后继可销账对应祖先 hold，并保留销账记录；不清除无关 hold。
- 旧 FINAL 不伪迁移。获准的一次免费迁移通过通用 `boundary-review` 入口登记独立证明，保留原文、缺键、原生 request/raw/receipt。未迁移旧请求不偷换新合同；导演精修保持自己的独立合同。

机器只验证绑定、逐字正证和覆盖完整性，不能替代语义判断。新原计划整编负责意义判断；旧稿一次迁移由获准的当前 Host 复核，必须记为人工介入。真实冲突与证据不足仍关门，不能凭字符串相似度放行或猜填 actual。

## 安全加载

沿 `runtime-maintenance-v1` 保留原授权冷加载。`WAIT_ISSUES` 可进入维护，但原停派门禁未真正闭合不能恢复派发。目标能力进入 `requiredCapabilities`，实际新 PID 必须证明已加载；HMR 和源码文件存在不算。

审查在排空期间修改源码时，只有 `RETIRED` 且尚未登记新加载进程，才可用 `safe-switch-3008.mjs retarget OLD_CODE_IDENTITY VERIFICATION_FILE` 受控重绑目标。离线核验文件须绑定新源码、原流程/授权和零生产派发；操作重新核监听启动器、cwd、空闲与已释放租约。旧/新源码及核验摘要留痕，不改变原授权、能力或暂停，不手改维护记录。用户暂停、授权漂移、仍有在途或已开始加载均拒绝。

排空中尚未绑定run的免费创建若由维护门明确返回 `RUNTIME_MAINTENANCE/NOT_SENT`，LOADED恢复先核本集不存在run、原生目录及账本记录，再附本地零派发证明并清理外层占位。原错误保留、不造原生零用量回执；已绑定run、付费UNKNOWN或存在记录时继续关门，不能因恢复而重建或重买。

合法空闲内核可能尚未取得coordinator租约：只有文件读取明确ENOENT、原RESUMED加载证明与当前监听PID/原授权完全一致、全局排空及本机模型/数据库均空闲时可建下一次维护。文件存在但内容为null或其它无效值不是“租约缺失”，必须拒绝；不创建或删除租约凑条件。

## 离线证据入口

- `runtime/episode-entry-review.test.mjs`：同义、DESIGN、遗漏恢复、证据漂移、等级、空入口失效关门。
- `runtime/storyboard-v4/core/entry-evidence.test.mjs`：完整覆盖、退休、等级、actual 消费、非直连晚段同词。
- `runtime/production-feedback-result-flow.test.mjs`：真实引擎的合成 plan/author/finish、持久停派、免费重校与原生不变；不是生产模型验证。
- 既有边界、维护、精修回归及临时数据库服务检查继续适用。私有 ENG-0003 证据另记真实运行及原生哈希。

## 保留限制

旧稿人工迁移、明确批准的真实正文修正不等于自动语义返修。机器不保证识别所有漏报/同义/否定或完成作品审美验收。Mac 启动器限定、RESUMING 再崩溃保守关门等限制仍须列入最终改进清单；后续通用缺口状态以以下版本化修复及实际加载证据为准。

## ENG-0005：新冻结任务的通用修复

- `model-coordinates-v4`：`feedbackBasis.materialIds` 与 schema/消费/决策的素材ID统一短名和无损恢复。旧v1/v2/v3及原生签名不变，正文中的相同字面不改。
- `production-context-v5`：模型行保留原已存在的 `evidenceRole`，缺失不猜角色；guidance仍不能自证事实。旧v2/v3/v4模型投影保持原样。
- `production-feedback-result-v2`：KEEP只允许同语义、同等级状态增补本次合法事实来源；旧来源不能删改，重复/对白/guidance/未知来源拒绝。`continuation` 必须显式数组。默认全部引文来自末单元，KEEP另须末单元exitState内含旧value的正证；较早KEEP须按序逐项证明全部后续单元同键、同值、同等级持续至末单元。混入末单元无关引文不能跳过持续证明；REPLACE/REMOVE仍只用末单元证据。缺证/矛盾/CHANGED/UNKNOWN继续关门，逐字出处不替代创作语义判断。
- 新普通生产finish的v2双marker必须完整一致；plan/author不误套finish要求，导演精修不升级为普通完整结果合同。维护加载新内核不迁移旧任务：已配对v1/v2各守原版，未标历史任务只沿此前获准的v1激活；v2半边、漂移或未知协议拒绝。已付旧请求逐字重建校验仍是激活前置条件。
- `dialogue-source-link-v1`：只对当前完整原句、精确lineId及单一真实对白行、正确声道/连续片段/合法声窗和唯一事件/工作包归属，派生遗漏的shot.sourceRefs并留坐标审计。原生output/raw不改，不补动作行，不清冲突/未决；现场对白错标系统音不派生。旧无marker不改接收结果，legacy多行对白缺逐行范围不猜。普通采用、精修完整/部分采用均接线；部分改稿碰retained范围仍拒绝。
- 审计增加候选错误代码投影，不再只看operation.error；候选不额外计为模型attempt，输出不包含提示词或错误正文。
- 重启恢复先持内核租约，再核原授权/启动者与新鲜暂停状态。活PID只有在原锁的birth/mtime/ctime均严格早于Mac内核开机时间且二次元数据/内容CAS相同时才封存旧锁；复用PID不收非零信号、不删除旧锁。租约在等待中丢失、同次开机、证据不明或坏锁均拒绝。Mac双击入口直接使用固定Node启动器。
- 已鉴权的单集GET `view=runtime` 仅返回实际原生内核身份，不启动模型；仍先核登录和项目成员权限。源码/HMR/合成加载证明不算真实冷加载，私有ENG-0005另记新PID/cwd、实际能力和150稿/1677原生文件保护。

证据入口：`pfr-v2-review-regression.test.mjs`、`pfr-v2-prepare-review.test.mjs`、`dialogue-source-link-flow.test.mjs`、`restart-safety-review.test.mjs`，以及对应投影、原生边界、维护、临时数据库服务回归。私有验证记录区分首次失败、修后通过、实际加载，不把测试调用数当生产费用。

INC-0006不能按“非blocking”文字直接放行：原稿仍有可见而未知的手臂外观，UNRESOLVED门禁有效；后续已付改稿改变了遮挡画法。该项属于创作语义/结构化处置能力缺口，不伪称确定性接收修复或保证原额外调用可免。全150文字就绪不等于自动导出、逐镜艺术质量、视听或用户验收。
