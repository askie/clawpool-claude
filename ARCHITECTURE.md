# ClawPool Claude 工作方式

`clawpool-claude` 做三件事：

1. 接收 ClawPool 发来的消息
2. 把消息送进 Claude Code
3. 把 Claude 的回复、审批请求、追问再发回 ClawPool

## 系统总览图

```mermaid
flowchart LR
  CP["ClawPool 私聊"]
  DA["Daemon"]
  BR["固定绑定和运行状态"]
  PM["Worker 进程管理"]
  WK["Claude Worker"]
  CC["Claude Code 会话"]
  MCP["MCP 工具调用"]

  CP --> DA
  DA --> BR
  DA --> PM
  PM --> WK
  WK --> CC
  CC --> MCP
  MCP --> WK
  WK --> DA
  DA --> CP
```

## 用户启动链路

正式使用推荐先安装后台服务：

```bash
clawpool-claude install --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

这一步会自动：

1. 保存连接配置
2. 安装并启动本机 `daemon`
3. 等待 ClawPool 会话发来 `open <cwd>`，再由 `daemon` 拉起或恢复 Claude 会话

后续日常只需要 `status`、`restart`、`stop`、`start`、`uninstall` 这组命令。

前台直跑 `clawpool-claude` 只建议用于临时调试或本地联调。

## Claude 进程管理流程图

```mermaid
flowchart TD
  A["收到 ClawPool 事件"] --> B{"是否 open <cwd> 命令"}

  B -- "是" --> C{"当前会话是否已有绑定"}
  C -- "否" --> D["创建固定绑定和 Claude 会话 ID"]
  C -- "是" --> E["校验目录一致"]
  D --> F["ensureWorker"]
  E --> F

  B -- "否" --> G{"是否存在固定绑定"}
  G -- "否" --> H["返回 open 工作目录卡片并结束"]
  G -- "是" --> I["记录待投递事件"]

  F --> J{"已有存活 worker 进程"}
  J -- "是" --> K["直接复用进程"]
  J -- "否" --> L{"是否可恢复 Claude 会话"}
  L -- "是" --> M["按原会话恢复启动 worker"]
  L -- "否" --> N["轮换 Claude 会话 ID 并冷启动 worker"]

  M --> O["worker 注册并上报 connected 和 ready"]
  N --> O

  I --> P["按会话串行投递事件"]
  K --> P
  O --> P

  P --> Q["worker 执行 Claude 交互并回传结果"]
  Q --> R["daemon 回传 ClawPool 并清理待投递状态"]
```

## 可靠性流程图（MCP 为核心指标）

```mermaid
flowchart TD
  A["周期健康检查"] --> B["枚举 starting connected ready 绑定"]
  B --> C["读取最新 binding 与 runtime"]
  C --> D{"runtime pid 是否存活"}

  D -- "否" --> E["标记 worker_exited 并置 stopped"]
  D -- "是" --> F["探测 worker ping"]

  F --> G{"ping 是否成功"}
  G -- "否" --> H["累计探测失败次数"]
  G -- "是" --> L{"身份是否一致<br/>worker_id session_id claude_session_id pid"}

  L -- "否" --> H
  L -- "是" --> M{"MCP 交互是否健康"}
  M -- "否" --> H
  M -- "是" --> N["计算结果超时集合<br/>基准=max(事件活跃时间, 最新 mcp_last_activity_at)"]

  H --> I{"失败次数达到阈值"}
  I -- "否" --> J["暂不判死 等下一轮"]
  I -- "是" --> K["标记 worker_control_unreachable 并置 stopped"]

  N --> O{"存在超时事件"}
  O -- "否" --> P["判定健康 保留运行"]
  O -- "是" --> Q["标记 mcp_result_timeout 并置 stopped"]

  E --> R["中断并失败当前待处理事件"]
  K --> R
  Q --> R
```

## MCP 心跳接收规则（防误判）

```mermaid
flowchart TD
  A["收到 session-composing 心跳"] --> B{"包含 ref_event_id"}
  B -- "否" --> Z["忽略"]
  B -- "是" --> C["查找 pending 事件"]

  C --> D{"事件状态是 dispatching 或 delivered"}
  D -- "否" --> Z
  D -- "是" --> E{"会话 ID 匹配"}
  E -- "否" --> Z
  E -- "是" --> F{"worker_id 匹配当前绑定"}
  F -- "否" --> Z
  F -- "是" --> G{"pid 匹配 runtime pid 或持久化 worker_pid"}
  G -- "否" --> Z
  G -- "是" --> H{"claude_session_id 匹配"}
  H -- "否" --> Z
  H -- "是" --> I{"event.last_worker_id 匹配"}
  I -- "否" --> Z
  I -- "是" --> J["刷新该事件活跃时间 updated_at"]
  J --> K["后续超时判断使用最新活跃时间"]
```

## 审批和追问

当 Claude 需要审批或补充信息时：

1. 审批走 Claude 原生 channel permission relay
2. worker 把审批请求发回对应的 ClawPool chat，并复用 AIBot 审批卡
3. 用户点卡片按钮，或手工回复 `yes <request_id>` / `no <request_id>`
4. verdict 直接回送给 Claude

补充提问主路径改成 Claude 官方 `Elicitation`：

1. Claude 触发表单型 `Elicitation`
2. hook 把请求落到本地数据目录，并映射成现有的提问卡片
3. worker 把提问卡发回对应的 ClawPool chat
4. 用户直接在卡片里提交答案
5. hook 读到结果后，再按 Claude 的 `Elicitation` 结果格式回送

不适合当前卡片的提问类型，会继续留在 Claude 本地处理。

## 本地数据

默认 daemon 数据目录是：

```text
~/.claude/clawpool-claude-daemon
```

这里会保存：

- 连接配置
- 绑定关系
- worker 运行状态（含 worker_pid）
- worker 运行日志
- 每个会话独立的 daemon 调度日志（`sessions/<aibot_session_id>/logs/daemon-session.log`）
- 每个会话独立的插件数据目录
- 访问控制
- 审批请求
- 用户输入请求
- 会话上下文
- 事件状态

排查步骤详见：

- `docs/session-log-troubleshooting.md`

## Claude 侧依赖

Claude 会话里仍然会有一份对应当前会话的本地 worker。它只服务当前目录和当前 Claude 会话，不再直接连接 ClawPool。worker 入口是打包后的：

```text
dist/index.js
```
