# Claude 渠道结构化卡片状态（当前）

> 状态：有效文档（持续维护）

这份文档用于记录“当前已经落地”的结构化卡片做法，不再使用早期“阶段计划”口径。

## 目标

- 统一 Claude 渠道对 AIBot 的结构化卡片载荷
- 保留文本和 `reply_source` 兜底，保证兼容和排障

## 统一信封

当前统一使用：

```json
{
  "reply_source": "...",
  "biz_card": {
    "version": 1,
    "type": "...",
    "payload": {}
  }
}
```

说明：

- `biz_card` 由 `server/message-card-envelope.js` 统一封装
- 前端优先解码 `biz_card`
- 无法解码时回退到 `reply_source + 文本` 兜底

## 已落地卡片类型

| 场景 | `biz_card.type` | 主要构造位置 |
| --- | --- | --- |
| 权限请求（Claude channel permission relay） | `exec_approval` | `server/claude-card-payload.js` + `server/worker/permission-relay-service.js` |
| 权限处理结果（允许/拒绝/转发） | `exec_status` | `server/claude-card-payload.js` + `server/worker/permission-relay-service.js` |
| 权限错误状态（无权限/请求不存在等） | `claude_status` | `server/claude-card-payload.js` + `server/worker/permission-relay-service.js` |
| 提问请求（Elicitation） | `claude_question` | `server/claude-card-payload.js` + `server/worker/elicitation-relay-service.js` |
| 提问状态（成功/失败） | `claude_status` | `server/claude-card-payload.js` + `server/worker/elicitation-relay-service.js` |
| 配对提示 | `claude_pairing` | `server/claude-card-payload.js` + `server/worker/interaction-service.js` |
| 访问状态 | `claude_status` | `server/claude-card-payload.js` + `server/worker/interaction-service.js` + `server/worker/tool-service.js` |
| `open` 缺目录提示 | `claude_open_session` | `server/daemon/control-card.js` + `server/daemon/control-command-handler.js` |

## 交互回填规则

当前保留的兜底命令：

```text
yes <request_id>
no <request_id>
/clawpool-question <request_id> <answer>
/clawpool open <working-directory>
```

说明：

- 卡片可用时，优先用卡片完成交互
- 卡片不可用或排障时，命令兜底必须可用

## 更新约束

后续如果新增卡片类型，必须同时更新：

1. `server/claude-card-payload.js` 或 `server/daemon/control-card.js`
2. 对应服务层发送逻辑
3. 对应测试用例
4. 本文档“已落地卡片类型”表

## 已清理的过期内容

以下旧口径已不再适用：

- “结构化卡片还未发送”
- “仅文本协议，没有结构化卡片”
- 早期分阶段计划（第一阶段/第二阶段/第三阶段）
- 指向旧工作树路径的绝对路径引用
