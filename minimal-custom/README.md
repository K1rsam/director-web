# 极简预设方案（minimal-custom）

一个复刻官方「极简模式」的 DSH Agent 预设，作为你自建的基础版，随你改。

## 这是什么

DSH 的 **Agent 预设** = 一个会话的 Agent 所运行的插件组装：它的工具、人设（提示词）与能力。
「极简模式」是官方 4 个内置预设之一（standard / code / minimal / cordis），本目录是它的用户版副本，包含：

| 文件 | 作用 |
|---|---|
| `agent.cordis.yml` | 预设组合：固定短人设 + 持久 bash + str_replace_editor，无上下文压缩 |
| `preset.yml` | 显示元数据：在 GUI 下拉里显示为「极简模式（自定义）」 |

效果：API 调用本身不变（DeepSeek 官方接口没有"极简"参数），但会话侧最省——
模型只拿两个工具、人设只有一句话、不注入运行时上下文，因此 prompt 更短、行为更可控。

## 安装（你回头要做的）

目录名 `minimal-custom` 就是预设 id（只允许 `[a-z0-9][a-z0-9-]*`），把整个目录拷到 DSH 家目录：

```bash
cp -r minimal-custom ~/.dsh/.agent-presets/
```

> 若 `DSH_HOME` 被改过，以 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/` 为准。

## 选择方式（装好之后三选一）

1. **新建会话时选**：composer（新会话输入框）里的「Agent 预设」下拉 →「极简模式（自定义）」。
   本地自建预设会在列表里带"本地"标记（trust: user）。
2. **设为默认**：编辑 `~/.dsh/settings.yaml`：

   ```yaml
   agent-presets:
     default: minimal-custom
   ```

3. **设置页**：设置 →「Agent 预设」，把默认预设改成它（还能在这里复制、删除、查看）。

⚠️ 预设只在**会话创建那一刻**固定；改预设或默认值只影响之后新建的会话，正在跑的会话不受影响。

## 定制指南

改完文件保存即可，**新建会话**就按新组合挂载，无需重启 DSH。

### 改人设
`agent.cordis.yml` 的 `persona` 条目：

- `text`：人设正文（`complete: true` 表示它就是完整 system prompt，全局身份、Web 指引等都不会再附加，改这里即可整体控制风格）；
- `includeRuntimeContext: false`：不注入运行时上下文快照（保持 `false` 最省 token）。

### 加工具
在文件末尾加一行普通条目即可，例如（插件名取自官方 `standard` 预设，真实可用）：

```yaml
    - id: file-reader
      name: '@deepseek-ai/dsh-tool-fs'          # 文件读写
    - id: file-search
      name: '@deepseek-ai/dsh-tool-fs-search'    # 文件搜索
    - id: web-fetch
      name: '@deepseek-ai/dsh-tool-web'          # 网页抓取
    - id: todo
      name: '@deepseek-ai/dsh-tool-todo'         # 待办列表
    - id: skill
      name: '@deepseek-ai/dsh-tool-skill'        # 技能调用
```

注意：

- 想加的工具如果依赖 host 侧服务（如 jobs / goal / subagent / workflow），不能简单平铺——
  对照官方 `standard` 组合里同一工具行的写法（含 `group` / `isolate`）整体照抄；
- 删工具直接删条目；但 `pty` / `terminal-bash` 是 `persistent-bash` 的依赖，删 `persistent-bash` 时三者一起去；
- 别去改 DSH 安装目录里 `config/agent-presets/` 的内置预设——升级会被覆盖。

## 配套：把 API 侧的思考档位也调省

「极简」只解决会话侧；模型侧的思考档位在 `~/.dsh/settings.yaml` 的 `agent-default-model`：

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high   # 你当前配的是 max
```

DeepSeek 官方 API 只支持 `high` / `max` 两个有效档位（`minimal` / `low` / `medium` 会被忽略、不上送），
想进一步省 token / 更快响应，从 `max` 降到 `high` 即可。
