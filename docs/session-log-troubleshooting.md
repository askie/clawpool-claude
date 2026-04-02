# Claude 会话日志排查说明

> 状态：有效文档（持续维护）

## 目标

出现“进程起来了但没结果”“会话反复重启”“消息没有回传”时，统一按这份说明排查。

## 写入规则

每个 AIBot 会话 ID 对应一份独立日志文件：

```text
~/.claude/grix-claude-daemon/sessions/<aibot_session_id>/logs/daemon-session.log
```

说明：

- 一个会话只看一份日志，不会和其他会话混在一起
- daemon 会持续追加写入，按时间顺序记录

## 记录内容

这份会话日志会记录 Claude 调度全过程：

- 收到消息、排队、投递、完成
- worker 进程状态变化（starting / connected / ready / stopped / failed）
- worker_id、worker_pid、claude_session_id
- 进程异常退出、探测失败、超时判定、重拉起
- 与 worker 的通信动作（deliver / stop / revoke / composing）

## 快速排查步骤

1. 先确认服务状态：

```bash
grix-claude status
```

2. 确认会话 ID 后查看该会话日志：

```bash
tail -f ~/.claude/grix-claude-daemon/sessions/<aibot_session_id>/logs/daemon-session.log
```

3. 关注下面这些关键阶段：

- `event_received`：daemon 收到会话消息
- `worker_spawn_requested`：准备拉起 worker
- `worker_spawned`：worker 已拉起（会带 pid）
- `worker_status_updated`：worker 状态变化
- `event_dispatching` / `event_dispatched`：事件投递中 / 投递成功
- `event_completed`：事件完成（有最终结果）
- `worker_process_exit_detected`：进程退出被探测到
- `worker_control_unreachable_detected`：worker 通信不可达
- `worker_mcp_result_timeout_detected`：MCP 结果超时触发回收

## 常见现象判断

- 看到 `worker_spawn_requested` 但长时间没有 `worker_spawned`：
  - 说明拉起失败，继续看 `daemon-service.err.log`
- 反复出现 `worker_process_exit_detected` 后又 `worker_spawn_requested`：
  - 说明进程在崩溃重启循环
- 有 `event_received` 但没有 `event_dispatched`：
  - 说明还没进入可投递状态，重点看 worker 状态与通信探测结果
- 有 `event_dispatched` 但迟迟没有 `event_completed`：
  - 重点看 `worker_mcp_result_timeout_detected` 或中断失败信息

## 关联日志

除了会话日志，还建议同时看：

```text
~/.claude/grix-claude-daemon/service/daemon-service.out.log
~/.claude/grix-claude-daemon/service/daemon-service.err.log
```

前者看服务整体运行，后者看启动错误和关键异常。
