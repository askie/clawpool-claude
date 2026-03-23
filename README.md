# @dhfpub/clawpool-claude

把 ClawPool 私聊接到 Claude Code 里。

## 你只需要做两步

### 1. 全局安装

```bash
npm install -g @dhfpub/clawpool-claude
```

### 2. 第一次启动时带上连接参数

先在 ClawPool 控制台拿到这 3 个值：

- `wsUrl`
- `agentId`
- `apiKey`

然后在你平时工作的目录里执行：

```bash
clawpool-claude --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

这条命令会自动完成下面几件事：

- 保存连接信息
- 启动本机 `daemon`
- 由 `daemon` 负责后续会话的启动、恢复和消息转发

以后再次启动时，直接执行：

```bash
clawpool-claude
```

## 怎么开始一个 Claude 会话

先在 ClawPool 对应私聊里发送：

```text
open <你的工作目录>
```

`daemon` 会按这个目录启动或恢复对应的 Claude 会话。

如果你已经在 Claude 里，可以执行：

```text
/clawpool:status
```

看到 worker 已经挂到 daemon 上，就说明链路正常。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/clawpool:status` | 看当前连接状态 |
| `/clawpool:access` | 看当前访问控制 |
| `/clawpool:access pair <code>` | 放行新的私聊发送者 |
| `/clawpool:access policy <allowlist\|open\|disabled>` | 切换访问策略 |

连接参数现在只通过本机 CLI 修改，不再在 Claude 会话里修改。

## 审批和提问

当 Claude 需要你确认或补充信息时，消息会回到 ClawPool。你在 ClawPool 里直接回复：

```text
/clawpool-approval <request_id> allow
/clawpool-approval <request_id> deny [原因]
/clawpool-question <request_id> 你的回答
```

## 文件发送

Claude 可以把本地文件回发到 ClawPool。单个文件最大 50MB，只支持常见图片、视频、文档类型。

## 命令选项

```text
clawpool-claude [options]

--ws-url <value>      ClawPool Agent API WebSocket 地址
--agent-id <value>    Agent ID
--api-key <value>     API Key
--data-dir <path>     daemon 数据目录
--chunk-limit <n>     单段文本长度上限
--no-launch           只检查并写好配置，不启动 daemon
--help, -h            显示帮助
```

第一次运行需要传完整参数。后续本地已经有配置时，可以直接运行 `clawpool-claude`。

## 开发时自动编译

如果你在改当前仓库代码，直接运行：

```bash
npm run dev
```

它会持续监听源码变化，并把最新产物自动编译到当前项目的 `dist/index.js`。这条命令只服务本地开发，不影响用户正式安装后的使用流程。
