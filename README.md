# Claude ClawPool 插件使用手册

这个插件用于把 ClawPool 聊天接到 Claude Code 里。

配置完成后，你可以直接在 ClawPool 里给某个 agent 发消息，Claude Code 会在当前会话里收到对应的 channel 消息，并可以把回复再发回 ClawPool。插件还支持两类用户侧交互：

1. 当 Claude 需要人类审批时，把审批请求发到 ClawPool
2. 当 Claude 需要补充信息时，把问题发到 ClawPool 并接收回答

如果你关心的是“这个插件怎么用、怎么验证已经跑起来、出了问题先查哪里”，看这份 README 就够了。  
如果你要看协议映射和实现细节，请转到 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 这个插件适合什么场景

- 你已经有可用的 ClawPool Agent API 账号，希望在 Claude Code 里直接收发 ClawPool 消息
- 你想让 Claude 在需要审批或补充输入时，把请求回到 ClawPool，而不是只能在本地终端里处理
- 你在做本地联调，希望快速验证“ClawPool 发消息 -> Claude 收到 -> Claude 回复 -> ClawPool 看见结果”这条链路

## 你先要准备什么

- 已安装并登录 Claude Code，版本不低于 `2.1.80`
- 已安装 Node.js 和 npm
- 你已经拿到这个插件要连接的 ClawPool API Agent 参数：
  - `wsUrl`
  - `agentId`
  - `apiKey`

如果你要联调本地后端，请确认 `wsUrl` 指向本地 Agent API WebSocket。  
如果你要连线上环境，请确认它是对应环境的正式 `wss://...` 地址。

## 第一次使用：最短路径

如果你第一次接这个插件，不要跳着看，直接按下面做。

### 1. 用脚本准备配置并启动 Claude

推荐直接使用仓库根目录的脚本：

```bash
cd /abs/path/to/aibot
./scripts/setup-claude-clawpool-claude-debug.sh --account developer
```

这个脚本会按当前仓库里的 smoke / 联调方式做完下面这些事：

1. 在 `claude_plugins/clawpool-claude` 下执行 `npm install` 和 `npm run build`
2. 写入 `CLAUDE_PLUGIN_DATA/clawpool-claude-config.json`
3. 创建 `${TMPDIR:-/tmp}/claude-clawpool-claude-<account>-workspace`
4. 在这个临时 workspace 写入 `.mcp.json`
5. 从这个临时 workspace 启动 Claude

如果你已经自己准备好了配置和构建产物，也可以只准备环境、不立即启动：

```bash
cd /abs/path/to/aibot
./scripts/setup-claude-clawpool-claude-debug.sh --account developer --no-launch
```

### 2. 启动后先看状态

进入 Claude 后，先执行：

```text
/clawpool-claude:status
```

你最终至少要确认：

1. `config.configured == true`
2. `connection.connected == true`
3. `connection.authed == true`

注意：插件刚启动的前 1 到 2 秒里，`/clawpool-claude:status` 可能会短暂显示 `connecting=true`，或者 `authed=false`。这是连接建立和 `auth_ack` 返回前的瞬时状态，不要用第一次立即查询的结果下结论；等 1 秒后再执行一次 `/clawpool-claude:status`，再看最终值。

### 3. 在 ClawPool 里发第一条私聊消息

1. 给目标 agent 发一条私聊消息
2. 如果当前 allowlist 为空，这条首条私聊会自动绑定并直接进入 Claude
3. 让 Claude 回一句简单消息，例如“已收到”
4. 回到 ClawPool，确认真的收到了回复

如果这 3 步都成功，就说明插件已经安装好、配置好，而且消息链路已经跑通。

## 插件加载后：在 Claude 里配置

只有在插件已经被 Claude Code 正确加载后，下面这些命令才可用。  
如果插件还没安装好，Claude 里不会出现 `/clawpool-claude:configure`。

进入 Claude 会话后，直接执行：

```text
/clawpool-claude:configure <ws_url> <agent_id> <api_key>
```

也支持 JSON 形式：

```text
/clawpool-claude:configure {"ws_url":"wss://...","agent_id":"123","api_key":"ak_xxx"}
```

## 如果你想手动启动 Claude

先说最重要的一点：`claude_plugins/clawpool-claude` 是插件构建目录，不是 Claude 的运行 workspace。  
真正启动 Claude 时，当前目录必须是一个包含 `.mcp.json` 的独立 workspace。

标准启动形式如下：

```bash
cd /tmp/claude-clawpool-claude-developer-workspace && \
CLAUDE_PLUGIN_DATA="$HOME/.claude/channels/clawpool-claude/developer" \
claude \
  --debug-file /tmp/claude-clawpool-claude-developer.log \
  --plugin-dir /abs/path/to/aibot/claude_plugins/clawpool-claude \
  --dangerously-load-development-channels server:clawpool-claude
```

如果你只是想跳过 Claude 本地权限确认，也可以额外追加：

```bash
cd /tmp/claude-clawpool-claude-developer-workspace && \
CLAUDE_PLUGIN_DATA="$HOME/.claude/channels/clawpool-claude/developer" \
claude \
  --debug-file /tmp/claude-clawpool-claude-developer.log \
  --plugin-dir /abs/path/to/aibot/claude_plugins/clawpool-claude \
  --dangerously-load-development-channels server:clawpool-claude \
  --dangerously-skip-permissions
```

注意两点：

1. `--dangerously-skip-permissions` 这一行前面也必须带续行反斜杠 `\`，否则它不会真正传给 `claude`
2. 这个参数会直接跳过 Claude 本地审批，因此也不会触发远程审批桥接；如果你要验证 ClawPool / Aibot 侧能否收到审批请求，就不要带这个参数

其中：

1. `/tmp/claude-clawpool-claude-developer-workspace/.mcp.json` 必须存在，并且里面要有名为 `clawpool-claude` 的 MCP server
2. `CLAUDE_PLUGIN_DATA` 下必须已经有 `clawpool-claude-config.json`，或者你准备在会话里手动执行 `/clawpool-claude:configure`
3. 必须带上 `--dangerously-load-development-channels server:clawpool-claude`

如果只传了 `--plugin-dir`，skills 和 hooks 可能会加载，但 channel 本身不会按预期注册起来。

## 启动后先做什么

进入 Claude 会话后，先执行：

```text
/clawpool-claude:status
```

你至少要确认这几项是正常的：

1. `config.configured == true`
2. `connection.connected == true`
3. `connection.authed == true`
4. `hints` 里不再提示缺少启动参数

如果你在 Claude 刚启动后立刻执行 `/clawpool-claude:status`，可能会短暂看到：

1. `connection.connecting == true`
2. `connection.connected == true` 但 `connection.authed == false`

这通常只是初始化窗口还没过去。等 1 到 2 秒再执行一次 `/clawpool-claude:status`，再看最终结果。

如果这里都不对，先不要继续测试收发消息，优先把配置和连接状态修好。

如果你在 Claude 里根本找不到 `/clawpool-claude:configure` 或 `/clawpool-claude:status`，先不要继续看后面的配置步骤，说明插件还没有正确加载。先回到上面的“第一次使用：最短路径”和“手动启动 Claude”两节，把安装和启动补完整。

## 第一条消息怎么打通

插件默认使用 `allowlist` 策略，但现在对“allowlist 为空时的首次私聊 sender”会自动绑定。

### 默认行为：首次私聊自动绑定

1. 在 ClawPool 里给目标 agent 发一条消息
2. 如果当前 allowlist 还是空的，而且这是私聊消息，这条消息会直接进入 Claude
3. 插件会把这条消息对应的 `sender_id` 自动加入 allowlist
4. 让 Claude 回一句话，确认 ClawPool 侧能收到回复

这条路径只适用于 allowlist 还是空的、并且是首次私聊 sender 的情况。  
它不是长期开放模式，也不会自动放行后续陌生 sender。

### 后续陌生 sender 怎么处理

当 allowlist 已经不为空后，新的陌生私聊 sender 不会再被自动放行，而是回到原来的配对流程：

1. 陌生 sender 发消息
2. ClawPool 侧收到 pairing code
3. Claude 侧管理员执行 `/clawpool-claude:access pair <code>`
4. 配对完成后，该 sender 才会进入 allowlist

## 你应该怎么验证“已经真的生效”

建议按下面顺序验证：

1. 在 Claude 里执行 `/clawpool-claude:status`，确认已连接且已鉴权
2. 从 ClawPool 给 agent 发一条消息
3. 在 Claude 会话里看到对应 channel 消息
4. 让 Claude 回复一句简单文本，例如“已收到”
5. 回到 ClawPool，确认这条回复真的出现

只要这 5 步都成立，就说明核心链路已经打通。

## 日常会用到的命令

### 查看状态

```text
/clawpool-claude:status
```

适合确认当前配置、连接状态、访问策略和插件给出的下一步提示。

### 配置连接信息

直接在 Claude 会话里手动配置即可：

```text
/clawpool-claude:configure <ws_url> <agent_id> <api_key>
```

也支持 JSON 形式：

```text
/clawpool-claude:configure {"ws_url":"wss://...","agent_id":"123","api_key":"ak_xxx"}
```

### 管理访问控制

查看当前 access 状态：

```text
/clawpool-claude:access
```

常用操作：

```text
/clawpool-claude:access pair <code>
/clawpool-claude:access deny <code>
/clawpool-claude:access allow <sender_id>
/clawpool-claude:access remove <sender_id>
/clawpool-claude:access allow-approver <sender_id>
/clawpool-claude:access remove-approver <sender_id>
/clawpool-claude:access policy <allowlist|open|disabled>
```

其中：

- `allowlist`：只有已允许的 sender 才能把消息送进 Claude
- `open`：持续开放所有 sender；首个 sender 进入后会自动收紧回 `allowlist`
- `disabled`：直接关闭这个 channel 的消息入口

## 审批和补充提问怎么用

### Claude 需要审批时

如果 Claude 在当前 ClawPool 对话里触发了审批请求，插件会把审批提示发回同一个 ClawPool chat。  
用户需要在那个 chat 里回复类似下面的命令：

```text
/clawpool-claude-approval <request_id> allow
/clawpool-claude-approval <request_id> allow-rule <index>
/clawpool-claude-approval <request_id> deny 可选原因
```

注意两点：

1. 审批人必须已经在 approver allowlist 里
2. 审批命令必须在发起该请求的同一个 ClawPool chat 内回复

另外要注意：

1. 当前 Claude 启动命令如果带了 `--dangerously-skip-permissions`，这类审批根本不会产生，所以也不会桥接到 ClawPool / Aibot
2. 要测试远程审批，必须用不带 `--dangerously-skip-permissions` 的启动命令，并先执行 `/clawpool-claude:access allow-approver <sender_id>`

### Claude 需要补充输入时

插件会把问题发回当前 ClawPool chat。  
用户可以在 chat 中直接回复：

```text
/clawpool-claude-question <request_id> 你的回答
```

如果是多问题场景，可以这样答：

```text
/clawpool-claude-question <request_id> 1=第一个答案; 2=第二个答案
```

同样要求在发起该请求的同一个 ClawPool chat 内回答，否则不会生效。

## 发文件有什么要求

插件支持 Claude 通过 `reply.files` 把本地文件发回 ClawPool，但有几个限制是用户会直接碰到的：

1. 只能传本机绝对路径
2. 单文件上限 50MB
3. 只支持当前 app 已公开支持的图片、视频、常见文档和压缩文件类型
4. 如果一次发多个文件，插件会拆成多条消息发送

如果你看到文件没有发出去，先检查路径是不是绝对路径，以及文件大小和类型是否符合要求。

## 常见问题

### 1. Claude 里看不到任何 ClawPool 消息

先检查三件事：

1. 当前工作目录里有没有 `.mcp.json`
2. 启动参数里有没有 `--plugin-dir /abs/path/to/aibot/claude_plugins/clawpool-claude`
3. 启动参数里有没有 `--dangerously-load-development-channels server:clawpool-claude`

只要少一个，channel 都可能起不来。

### 2. `/clawpool-claude:status` 里 configured=true，但 authed=false

如果这是 Claude 刚启动后的第一次查询，先等 1 到 2 秒再执行一次 `/clawpool-claude:status`。  
只有在重复查询后依然保持 `authed=false`，才通常表示 `wsUrl`、`agentId`、`apiKey` 这组配置不匹配，或者目标 backend 不可达。回头检查你输入的这三个值是否正确。

### 3. 我发了消息，但没有进入 Claude

最常见原因是 sender 还没有通过 access 控制。  
如果这是第一个私聊 sender，正常应当自动绑定并直接进入 Claude。  
如果当前已经有其他 sender 在 allowlist 里，再执行 `/clawpool-claude:access` 看当前策略和 allowlist，再决定是：

- 用 `/clawpool-claude:access pair <code>` 完成配对
- 临时用 `/clawpool-claude:access policy open` 放开更多 sender

如果后端日志里看到的是 `agent_api_channel_unavailable`，优先排查本机是不是同时跑了多个 Claude 会话。  
这种情况下 backend 会看到 agent 一直“connected successfully”，但真正消费 channel 消息的前台会话并不稳定。先把旧 Claude 进程全部退出，只保留一个从 `main` 工作目录启动的会话，再重试。

如果后端日志里看到的是同一个 `msg_id` 被反复重试，而且结果一直是 `claude_result_timeout`，优先排查是不是有旧失败 event 被持久化了。  
插件会把 event 状态持久化到 `${CLAUDE_PLUGIN_DATA}/event-states/` 和 `${CLAUDE_PLUGIN_DATA}/session-contexts/`。如果这条旧 event 之前已经 `notification_dispatched_at` 过，后续重试会按重复事件处理，不会重新走“首条私聊自动绑定”。  
这种情况下：

1. 退出当前 Claude 会话
2. 删除 `${CLAUDE_PLUGIN_DATA}/event-states/` 里对应的旧 event 文件
3. 删除 `${CLAUDE_PLUGIN_DATA}/session-contexts/` 里对应的旧 session 文件
4. 重新启动 Claude
5. 从手机端发一条全新的文本，不要点旧失败气泡的重试

如果清理后再次重试，后端日志里应该能看到 `bootstrapped sender allowlist sender=...`，随后 Claude 才会继续回消息。

### 4. 审批命令或问题回答没有生效

先确认是不是这两个问题之一：

1. 你不是在原来的那个 ClawPool chat 里回复
2. 审批人没有被加入 approver allowlist

这两种情况插件都会拒绝回写给 Claude。

### 5. 我只想看技术实现，不想看用户手册

看这里：

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [docs/claude_clawpool-claude_local_debug.md](../../docs/claude_clawpool-claude_local_debug.md)

## 进一步说明

当前这套接入方式首先面向本地开发和联调，不是 marketplace 一键安装型插件。  
如果你是在这个仓库里调试 Claude + ClawPool 的消息链路，这份 README 就是推荐入口。
