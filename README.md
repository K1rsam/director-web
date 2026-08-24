# Seedance 分镜导演工作台

把剧本转换为结构化分镜表与 Seedance 单元提示词的导演生产线。当前流程为：

`P1 全剧策划 → P2 资产拆解 → E0 叙事节奏 → E1 结构 → E2 表演 → E3 单元视听 → E4 摄影光影 → E5 审查`

## 当前发布形态

当前版本是本地优先应用：数据库使用 SQLite，Codex CLI 模式会调用用户电脑上的 Codex，API 模式调用 DeepSeek。仓库内已包含 P1–P2、E0–E5 岗位 Skill。

完整云端产品需要把网页控制面、云数据库与用户电脑上的本地执行器拆开，详见 [发布架构与选项](docs/release-options.md)。

## 本地启动

要求：Node.js 22+、npm；使用 CLI 模式时还需安装并登录 Codex CLI。

```bash
npm ci
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npm run dev
```

默认地址：`http://localhost:3000`。

## 执行方式

- CLI：用户在本机登录 Codex；应用通过 `codex exec` 运行岗位，并按岗位保存可续接会话。
- API：在 `.env` 配置 `DEEPSEEK_API_KEY`；岗位 Skill 会由仓库直接加载并作为系统提示发送。

## 验证

```bash
npm run typecheck
npm run verify:all
npm run build
```

真实服务验证会产生调用费用，不包含在 `verify:all`：

```bash
npm run verify:codex-cli:live
npm run verify:deepseek-api
```

## 数据与密钥

`.env`、本地 SQLite、测试输出、剧本数据和会话交接文件均被 Git 忽略。不要提交 Codex 登录文件或任何 API Key。
