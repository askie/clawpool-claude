# @dhfpub/clawpool-claude

Claude Code channel plugin —— 把 ClawPool 聊天接到 Claude Code 里。

- 在 ClawPool 里给 agent 发消息，Claude Code 会话里直接收到
- Claude 需要审批或补充信息时，请求会桥接回 ClawPool
- 技术细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)

## 前置要求

- Claude Code ≥ `2.1.80`
- Node.js + npm
- ClawPool Agent API 参数：`wsUrl`、`agentId`、`apiKey`

## 快速开始

### 1. 启动

```bash
cd /path/to/clawpool-claude
./start.sh --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

运行 `./start.sh --help` 查看全部选项。

### 2. 验证

进入 Claude 后执行：

```text
/clawpool:status
```

确认 `configured=true`、`connected=true`、`authed=true`。  
> 刚启动 1–2 秒内状态可能还没就绪，稍等后再查。

### 3. 打通消息

1. 从 ClawPool 给 agent 发一条私聊
2. 首条私聊会自动绑定 sender 并进入 Claude
3. 让 Claude 回复，确认 ClawPool 侧收到

## 常用命令

| 命令 | 用途 |
|------|------|
| `/clawpool:status` | 查看连接和配置状态 |
| `/clawpool:configure <ws_url> <agent_id> <api_key>` | 在会话内配置连接 |
| `/clawpool:access` | 查看访问控制 |
| `/clawpool:access pair <code>` | 配对新 sender |
| `/clawpool:access policy <allowlist\|open\|disabled>` | 切换访问策略 |

## 审批与提问

当 Claude 触发审批或提问时，插件会把请求发到 ClawPool 对应 chat，用户在 chat 内回复：

```text
/clawpool-approval <request_id> allow
/clawpool-approval <request_id> deny [原因]
/clawpool-question <request_id> 你的回答
```

> 审批人需先加入 approver allowlist：`/clawpool:access allow-approver <sender_id>`

## 文件发送

支持 Claude 通过 `reply.files` 发送本地文件到 ClawPool，限制：绝对路径、单文件 ≤ 50MB、仅支持常见图片/视频/文档类型。

## 常见问题

**Claude 里看不到消息？** 检查启动参数是否包含 `--plugin-dir` 和 `--dangerously-load-development-channels server:clawpool-claude`。

**configured=true 但 authed=false？** 等 1–2 秒再查；持续失败则检查 `wsUrl` / `agentId` / `apiKey` 是否正确。

**消息没进 Claude？** 执行 `/clawpool:access` 检查 sender 是否已在 allowlist 中，或用 `pair <code>` 完成配对。
