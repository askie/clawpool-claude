# ClawPool Claude 工作方式

`clawpool-claude` 做三件事：

1. 接收 ClawPool 发来的消息
2. 把消息送进 Claude Code
3. 把 Claude 的回复、审批请求、追问再发回 ClawPool

## 用户启动链路

正式使用时，入口只有一个：

```bash
clawpool-claude
```

第一次运行时带上 `wsUrl`、`agentId`、`apiKey`。命令会自动：

1. 保存连接配置
2. 把 `clawpool-claude` 写入 Claude 用户级 MCP
3. 启动 Claude，并启用这个通道

后续再次启动时，不需要再传这 3 个参数。

## 消息链路

1. ClawPool 用户给 agent 发私聊
2. `clawpool-claude` 收到消息并做发送者校验
3. 消息进入 Claude 当前会话
4. Claude 调用 `reply`、`complete`、`delete_message` 等能力
5. 结果再发回 ClawPool

## 审批和追问

当 Claude 需要审批或补充信息时：

1. 请求先落到本地数据目录
2. 插件把请求发回对应的 ClawPool chat
3. 用户在 ClawPool 里用命令回复
4. 结果再回写给 Claude

## 本地数据

默认数据目录是：

```text
~/.claude/clawpool-claude
```

这里会保存：

- 连接配置
- 访问控制
- 审批请求
- 提问请求
- 会话上下文
- 事件状态

## Claude 侧依赖

这个项目用 Claude 插件加本地 MCP server 的组合来接入通道能力。MCP server 入口是打包后的：

```text
dist/index.js
```
