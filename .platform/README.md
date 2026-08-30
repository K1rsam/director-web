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

## 日常修改流程

1. 先用 `change-scope.mjs` 判断文件范围。
2. `main-only`：只提交并推送 `main`；重新生成 Sites 时会自动带入公共改动。
3. `sites-only`：只在 overlay 工作树提交并推送 `sites-online`。
4. `both`：先检查线下和 Sites 的运行时差异，再分别提交；不要把生成目录当成第三套源码。
5. `main` 有新的公共提交后，先把 overlay rebase 到最新 `main`，再继续 Sites 专属修改；生成工具始终以已提交的 Git 内容为准。

建议把生成目录当作一次性发布产物；当前已有的 `director-workbench-sites` 源目录仍可用于 Sites 构建和部署，但它不再是公共代码的第二个编辑入口。

## 当前迁移状态

迁移完成前，`dual_until_split` 是明确的临时区。后续把这 55 个同路径差异逐步抽成公共模块后，才把它们从 `dual_until_split` 改为 `common_once` 或专属分类。遇到未归类的新文件，工具会停止并要求先补边界清单，避免误把线下代码发布到 Sites。
