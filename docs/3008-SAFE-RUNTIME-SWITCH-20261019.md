# 3008 原授权安全冷切换

本机运维入口：`runtime-3008/node/bin/node scripts/safe-switch-3008.mjs`。这是已有3008内核的维护能力，不是新制作队列、模型调用或授权重签。当前进程监督器仅验证macOS固定3008启动器；Windows拒绝执行，不声称跨平台已验证。

## 操作

1. `begin WORKFLOW_ID ORIGINAL_AUTHORIZED_AT`：新鲜核监听PID、父启动器、cwd、coordinator租约及原worker归属；保存源码身份与维护意图，关闭新准入。原在途自然回包，禁止cancel或删除锁。仅对已证明未绑定run的模块加载前失败追加零派发证据。
2. `status`：读取维护阶段和真实在途阻断。DRAINING不等于已排空；用户另行暂停或授权/源/停止线变化均阻断恢复。
3. `load`：等待原worker、完整onSettled、公共写入、coordinator与账本排空；退役并释放租约后再核本机模型进程、数据库在途及PID/cwd。只关闭已验证空闲Web进程，使用原启动器冷加载整图。新进程须提供真实内核协议与源码身份，不能用HTTP存活、HMR或旧缓存冒充加载。中途失败保留维护门及证据，复用同一维护记录续接，不建替代workflow。
4. `resume`：免费核当前原启动者成员权限和真实双源、选定版本，激活真正未完成的原run。只追加完整结果协议两个marker与审计记录；逐旧operation重建完整冻结请求，核原生FINAL及字节hash。已有完成稿一律跳过，缺原生证明、保存待恢复正文、最终UNKNOWN、源变化及用户暂停均不自动越过。恢复原authorizedAt/authorizedBy，不调用startParallel重签。

持久维护状态在数据根`runtime-maintenance/documents/current.json`，运维wx证据在私有`runtime-3008/maintenance-audit/`。信号仅唤醒持久意图绑定的当前PID；不是授权。PREPARED与RESUMING阶段崩溃后继续保持付费准入关闭，显式续接仍核原归属。恢复前源码改变会拒绝加载，不自动接受新hash。

LOADED阶段若已验证的新Web进程死亡、原维护暂停仍在，可通过`load`为当前固定启动器的新PID重新核验。RESUMING期间若Web再次崩溃或执行权/租约不能证明释放，保守停门、保留状态，尚未承诺无人值守跨进程恢复，不强杀或删锁。

## 零派发与旧回执

Node模块加载失败只有在预算适配器边界之前、原生attempt目录/账本attempt/候选均不存在时才可追加`budgeted-pre-dispatch-absence-v1`本地证明。证明绑定原attempt、指纹、错误和本地回执，任一漂移即失效；实际native request/receipt优先，不能被本地证明覆盖。保留原UNKNOWN错误与本地占位回执，另列`localVerifiedOutcome=NOT_SENT`。无原生回执的input/cache/output/total/模型耗时保持null，不能编造0 Token FINAL。

若下一个operation还未建立、故障只在`web.error`，则另核全部已有operation原生FINAL，追加绑定run/plan/原operations/错误的`preparation-before-next-operation-v1`证明。此类恢复不新建attempt，也不把上一个已付plan/author标成NOT_SENT；后续仍由原协调器选择下一正常岗位。

维护控制本身不派发模型；恢复后原授权队列的正常计划/作者/整编仍是真实付费生产，不能说成免费，也不能算维护额外付费验证。源码、离线回归、实际加载、自然生产使用四层证据分别报告。已完成旧R1缺新原生证明时不伪迁移、不重买；新的正常finish才形成完整结果及SOURCE证据，重要真实源文冲突仍需用户裁决。

## 离线边界

维护测试覆盖在途与onSettled屏障、不取消模型、用户暂停/授权/源/限额漂移、未知版本失败关闭、崩溃续接、旧冻结请求/回执不变、实际新PID内核证明与Node混合模块加载竞态；服务适配器使用临时数据库并禁网。测试不是实际睡眠/断网、Windows进程切换、模型语义、视听成片或用户验收。
