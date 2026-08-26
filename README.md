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
npm run database:migrate
npm run dev
```

默认地址：`http://localhost:3000`。

升级已有数据库前先停止正在运行的网站。迁移命令会自动建立带时间戳的 SQLite 备份，并识别早期由 `prisma db push` 写入的旧结构；若检测到结构只完成了一部分，会停止升级而不继续改库。

## 私有测试账号

当前版本不开放注册。首次运行时，在本机设置临时密码并初始化账号：

```bash
TEST_ACCOUNT_INITIAL_PASSWORD='<仅在本机填写>' npm run accounts:seed
```

系统会建立 `tester01`、`tester02`、`tester03`、`tester04`、`tester05` 五个账号；命令可重复运行，不会重复创建。无归属的历史项目会自动分配给 `tester01`，每个账号之后只能看到和操作自己的项目。

登录会话默认保持 30 天。需要更换某个账号的密码时运行：

```bash
TEST_ACCOUNT_INITIAL_PASSWORD='<新密码>' npm run accounts:seed -- --rotate tester01
```

换密会同时退出该账号的现有会话。临时弱密码只适合私有测试，公开访问前必须更换；密码不要写入源码、README 或提交到 Git。

## 执行方式

- CLI：用户在本机登录 Codex；应用通过 `codex exec` 运行岗位，并按岗位保存可续接会话。
- API：登录后打开“API 与 CLI”，输入自己的 DeepSeek Key，系统先调用 `/models` 验证，再按当前账号加密保存。项目选择 API 后，流水线读取项目管理员账号的凭证；Key 不写入浏览器 `localStorage`。保留 `.env` 中的 `DEEPSEEK_API_KEY` 作为本机兼容回退。
- CLI：在“API 与 CLI”点击本机检测，系统只检查 `codex --version` 和 `codex login status`，不消耗模型额度；通过后项目可继续使用本机 Codex 执行链路。

账号级 API 凭证使用 `DIRECTOR_CREDENTIAL_KEY` 加密后写入 SQLite。复制 `.env.example` 后，请在本机设置一个随机的 32+ 字符值；该值不能提交到 Git，也不能在更换后忘记备份，否则已保存的凭证无法解密。

## 验证

```bash
npm run typecheck
npm run verify:provider-credentials
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

