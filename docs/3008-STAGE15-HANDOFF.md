# 3008 / 1.5 阶段

基线：`handoff/3008-stage1-20260912`。本功能分支：`handoff/3008-stage1.5`，不合并 main 或回写基线。

沿用 `3008-MAC-HANDOFF.md` 的安装和环境设置。项目页进入“1.5 · 资产形象设计”。本阶段可选，不阻挡第二阶段。

功能包括：资产专属文字提示词、来源形象依赖、视图模板、参考图上传、画质/比例/数量、提示词导出，以及独立滚动的资产与设置面板。图片 API 尚未接入，模型入口和生成历史仅为预留。

P3 默认勾选完成后生成人物资产提示词；可取消。第一阶段完成后启动独立文字任务，可停止和继续。后台运行需保留 Node、tsx 及 `scripts/asset-prompt-worker.ts`；运行路径为项目根目录。已有剧不会因为更新代码自动重跑 P3。

提示词与图片设置保存在独立 SceneSnapshot 中。上传图片默认保存在 `outputs/asset-references`，可用 `DIRECTOR_ASSET_REFERENCE_DIR` 指定目录。迁移用户数据时需另外迁移该目录和数据库；本源码分支不携带这些私人数据。

## 准确性边界

P3/F2 与 Q1 按需加载 `prompts/foundation/asset-subject-boundaries-v1.md`。独立文字设计规则为 `prompts/asset-image-design-v1.md`。当前外观检索采用保守主体和场次归属索引；第一阶段资料与原文节选可在面板中展开核对。此机制可能漏收或误判，不代表语义准确性已完成验收，也尚未实现 P3 结构化外貌事实卡的完整验证闭环。

## 验证

- `npm run typecheck`
- `npx tsx scripts/verify-asset-appearance-boundaries.ts`
- `npx tsx scripts/verify-asset-prompt-queue.ts`
- `npx tsx scripts/verify-p3-asset-boundaries.ts <一致性数据库备份>`
- `npx tsx scripts/verify-asset-prompt-automation.ts <一致性数据库备份>`

后两项复制备份到隔离测试库，不调用真实文字模型。局部真实文字生成和读回曾通过；空队列后台检查不等同于整剧自动生成验收。图片生成和浏览器视觉验收尚未完成。
