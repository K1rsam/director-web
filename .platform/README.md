# `main` 与 `sites-online` 的源码边界

这两个分支不是两套需要手工重复上传的完整项目：

- `main` 是唯一的公共基线，也保留线下 Prisma、本地流水线和本地工具。
- `sites-online` 是基于 `main` 的 Sites overlay，只记录 Sites/D1/线上 Runner 的差异。
- Sites 发布前，用 `.platform/materialize-sites.mjs` 把 `main` 与 overlay 合成为一份完整 Sites 源码；公共文件来自 `main`，overlay 文件覆盖同路径差异。
- Git 分支本身不会动态读取另一个分支，所以必须通过这个生成步骤实现“Sites 读取 main 公共代码”。

## 改文件时看哪里

| 分类 | 应修改 | 说明 |
| --- | --- | --- |
| `common_once` | `main` | 公共文件，Sites 生成时自动继承 |
| `dual_until_split` | 两边都检查 | 目前同一路径仍有线下/Sites 差异，暂时不能只改一边 |
| `sites_only` | `sites-online` | D1、线上 Runner、Sites hosting 等专属代码 |
| `local_only` | `main` | Prisma、本地服务、本地 CLI、线下工具等 |

### 诊断日志的改动范围

- `lib/diagnostic-log.ts`、`public/runner/diagnostic-log.mjs`、公共 Runner 里的记录协议：`common_once`，只改 `main`，Sites 生成时自动继承。
- `lib/local-diagnostic-log.ts`、线下角色调用和本地任务脚本：`local_only`，只改 `main`，负责把详细日志保存到用户电脑。
- `app/api/runner/diagnostics/**`、`lib/runner-diagnostics.ts`、`app/runner/diagnostic-log-panel.tsx`、Sites 下载器：`sites_only`，只改 `sites-online`，负责接收、授权上传和查看日志。
- 仍标记为 `dual_until_split` 的样式文件：两边都要检查；公共业务逻辑不需要重复维护。

日志策略固定为：Runner 对启动、连接、任务失败自动上传脱敏的最小日志；详细堆栈、标准输出和标准错误只在用户从 Sites 点击“上传详细诊断”并且 Runner 在线响应后上传。线下版本只保留本地详细 JSONL，不自动把详细内容上传到服务器。

先用变更判定工具：

```text
node .platform/change-scope.mjs app/page.tsx
node .platform/change-scope.mjs app/api/runner/jobs/claim/route.ts
```

## 生成 Sites 源码

在独立的工作树中生成一个新的目标目录，避免覆盖已有 Sites 工作目录：

```text
node .platform/materialize-sites.mjs `
  --main E:\codex-data\director-web `
  --overlay E:\codex-data\director-web-sites-overlay `
  --target E:\codex-data\director-workbench-sites-materialized
```

生成目录包含完整 Sites 源码，但不包含 `.platform` 工具目录，也不会把线下专属文件带到 Sites。

### Mac / Linux 示例

从仓库根目录执行；以下两个相邻目录应尚不存在：

```bash
git fetch origin
git worktree add -b sites/mac-next ../director-web-sites origin/sites-online
node .platform/materialize-sites.mjs --main . --overlay ../director-web-sites --target ../director-web-sites-build
```

这里生成的是发布源码目录；依赖安装、平台构建和发布仍需按 Sites 工具及该目录平台配置完成。不能把生成源码等同于已经更新线上。当前交接与 3180 参考见 [2026-09-05 交接说明](../docs/HANDOFF-2026-09-05.md)。

## 日常修改流程

1. 先用 `change-scope.mjs` 判断文件范围。
2. `main-only`：只提交并推送 `main`；重新生成 Sites 时会自动带入公共改动。
3. `sites-only`：只在 overlay 工作树提交并推送 `sites-online`。
4. `both`：先检查线下和 Sites 的运行时差异，再分别提交；不要把生成目录当成第三套源码。
5. `main` 有新的公共提交后，先把 overlay rebase 到最新 `main`，再继续 Sites 专属修改；生成工具始终以已提交的 Git 内容为准。

建议把生成目录当作一次性发布产物；当前已有的 `director-workbench-sites` 源目录仍可用于 Sites 构建和部署，但它不再是公共代码的第二个编辑入口。

## 当前迁移状态

迁移完成前，`dual_until_split` 是明确的临时区。后续把这 55 个同路径差异逐步抽成公共模块后，才把它们从 `dual_until_split` 改为 `common_once` 或专属分类。遇到未归类的新文件，工具会停止并要求先补边界清单，避免误把线下代码发布到 Sites。
