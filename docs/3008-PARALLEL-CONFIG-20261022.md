# 可选四路 / 六路连续制作

## 配置与兼容

- 新队列页面默认六路，也可选四路；保存配置本身不派发模型，开始制作仍需原有明确授权。
- 新显式配置使用 `production-parallel-v2`，保存 `laneCount: 4 | 6`。旧 `production-parallel-v1` 无该字段时仍解释为四路，不迁移历史任务。
- 已授权或已有参与 run 的队列禁止改变路数。旧 v1 队列也禁止转成六路。暂停、重新连接和服务重启均保留原路数、原授权、共享账本与原停止线。
- 连续范围按路数分成连续区间；150 集六路为 1–25、26–50、51–75、76–100、101–125、126–150。每路逐集接续，同集最多一个模型请求。
- 新执行器宿主最多六个执行位，但每个 run 依冻结绑定限制：旧绑定仍最多四，新 v2/6 才允许六。可用并发不等于保证吞吐率。
- 仅保存六路而手动推进时不附并行派发 marker；真正启用并行后才绑定冻结协议。带 marker 的任务必须属于原参与清单，不开放旁路。

## 质量、暂停与预算

- 分组边界仍使用真实跨集承接门禁；PRELIMINARY 不计严格完成，UNRESOLVED 阻断相应后续，不因提高并发降低要求。
- 人工暂停阻止后续派发，在途回包自然保留；重新连接不会解除人工暂停。
- 六路共用同一账本，不按路重建或扩限。记录数、已知 Token、单集限制与最终 UNKNOWN 门禁保持；停止线不是费用硬封顶。
- 旧内核不能创建新 v2 并行 run：返回 NOT_SENT，必须在无在途的安全窗口冷加载。不能依靠 HMR 宣称本机原生执行器已升级。

## 免费验证入口

运行 Node 24：

```sh
runtime-3008/node/bin/node --test runtime/production-workflow.test.mjs runtime/production-parallel.test.mjs runtime/production-budget.test.mjs runtime/storyboard-v4/coordinator.test.mjs
runtime-3008/node/bin/node --import tsx scripts/verify-production-workflow-service.ts
runtime-3008/node/bin/node --import tsx scripts/verify-production-parallel-config.ts
runtime-3008/node/bin/node node_modules/typescript/bin/tsc --noEmit --incremental false
```

覆盖四/六路执行位、同集互斥、并发 pump 去重、150 集分组、跨集门禁、真实 worker 补位、暂停与重连、共享预算、旧任务冻结、临时数据库鉴权及配置页面离线渲染。全部使用隔离目录、临时数据库或合成 runner；不使用浏览器，不新增生产模型调用，不重跑已完成内容。工程回归不代表六路真实付费吞吐或作品质量验收。
