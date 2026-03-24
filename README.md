# @dhfpub/clawpool-claude

把 ClawPool 私聊接到 Claude Code 里。

## 最简单的用法

### 1. 全局安装

```bash
npm install -g @dhfpub/clawpool-claude
```

### 2. 第一次安装后台服务

先在 ClawPool 控制台拿到这 3 个值：

- `wsUrl`
- `agentId`
- `apiKey`

然后执行：

```bash
clawpool-claude install --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

这条命令会自动完成下面几件事：

- 保存连接信息
- 安装当前用户自己的后台服务
- 立即启动本机 `daemon`
- 由 `daemon` 负责后续会话的启动、恢复和消息转发

支持的后台方式：

- macOS: `launchd`
- Linux: `systemd --user`
- Windows: 任务计划

## 之后你通常只会用这几个命令

```bash
clawpool-claude status
clawpool-claude restart
clawpool-claude stop
clawpool-claude start
clawpool-claude uninstall
```

- `status` 看服务和连接状态
- `restart` 改完配置后重启
- `stop` 临时停掉后台服务
- `start` 重新拉起后台服务
- `uninstall` 删除后台启动项

## 如果你只想临时前台运行

不装后台服务也可以，直接执行：

```bash
clawpool-claude --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

后续本地已经有配置时，也可以直接运行：

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

## Claude 里的常用命令

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
yes <request_id>
no <request_id>
/clawpool-question <request_id> 你的回答
```

- 审批卡直接点按钮就行，手输时只需要 `yes <request_id>` 或 `no <request_id>`
- 提问卡直接在卡片里填完提交，不需要复制命令
- 只有调试或兜底时，才需要手工输入 `/clawpool-question ...`

## 文件发送

Claude 可以把本地文件回发到 ClawPool。单个文件最大 50MB，只支持常见图片、视频、文档类型。

## CLI 命令

```text
clawpool-claude install [options]
clawpool-claude start [options]
clawpool-claude stop [options]
clawpool-claude restart [options]
clawpool-claude status [options]
clawpool-claude uninstall [options]
clawpool-claude [options]
```

推荐优先用 `install`。默认命令 `clawpool-claude [options]` 更适合临时前台运行或者调试。

## 常用选项

```text
--ws-url <value>      ClawPool Agent API WebSocket 地址
--agent-id <value>    Agent ID
--api-key <value>     API Key
--data-dir <path>     daemon 数据目录
--chunk-limit <n>     单段文本长度上限
--show-claude         开发调试时把 Claude 拉到可见的 Terminal 窗口
--no-launch           只检查并写好配置，不启动 daemon
--help, -h            显示帮助
```

- 第一次执行 `install` 或前台启动时，需要传完整连接参数
- 后续如果本地已经保存过配置，可以省略连接参数
- `--data-dir` 用来指定单独的数据目录，适合多套环境分开跑

开发时如果你怀疑 Claude 卡在启动确认页，可以加 `--show-claude`，这样 daemon 会把对应 Claude 会话直接拉到一个可见的 Terminal 窗口里。

## 开发时自动编译

如果你在改当前仓库代码，直接运行：

```bash
npm run dev
```

它会持续监听源码变化，并把最新产物自动编译到当前项目的 `dist/index.js`。这条命令只服务本地开发，不影响用户正式安装后的使用流程。
