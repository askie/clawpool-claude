# Claude 渠道结构化卡片载荷方案

## 目标

这份文档只解决一件事：

- 在不破坏当前“文本驱动卡片闭环”的前提下，把 Claude Clawpool 渠道升级成“结构化卡片载荷下发”

这里说的结构化，不是重新发明前端卡片，而是直接对齐 AIBot 前端已经存在的数据模型。

## 一、当前基础判断

先说结论：

1. AIBot 前端已经支持 Claude 相关结构化卡片解码
2. Claude 插件当前还没有主动发送这些结构化载荷
3. 所以这次方案的核心不是“新增前端卡片”，而是“让 Claude 插件按现有格式发出来”

关键事实：

- Agent API 已支持消息 `extra`
- 服务端会把 `extra.biz_card` 标准化投影成 `biz_card`
- AIBot 前端的卡片解码器会先尝试从 `extra.biz_card` 解码
- 如果没有结构化卡片，才会退回当前的“`reply_source + 固定文本格式`”识别路径

这意味着：

- 可以平滑迁移
- 不需要一次切断文本方案
- 甚至可以先双发：保留文本内容，同时补 `extra.biz_card`

## 二、现有前端可直接复用的卡片类型

当前 AIBot 前端已经支持这些结构化卡片类型：

| Claude 场景 | 前端卡片类型 | `biz_card.type` |
| --- | --- | --- |
| Claude 审批请求 | 复用执行审批卡 | `exec_approval` |
| Claude 审批结果 | 复用执行状态卡 | `exec_status` |
| Claude 审批错误状态 | Claude 状态卡 | `claude_status` |
| Claude 提问请求 | Claude 提问卡 | `claude_question` |
| Claude 提问状态 | Claude 状态卡 | `claude_status` |
| Claude 配对提示 | Claude 配对卡 | `claude_pairing` |
| Claude 访问状态 | Claude 状态卡 | `claude_status` |

这里最重要的一点是：

- Claude 审批请求和审批结果，不需要新造专用卡片类型
- 直接复用现有 `exec_approval` / `exec_status`

这样改动最小。

## 三、推荐的发包原则

## 3.1 先保留文本，再加结构化

第一阶段建议：

1. 保留当前文本内容不变
2. 保留当前 `reply_source` 不变
3. 同时在 `extra.biz_card` 中附带结构化卡片载荷

这样能同时满足三件事：

1. 老前端仍然能按文本识别
2. 新前端优先用结构化卡片
3. 出现问题时还能直接回落到文本链路

## 3.2 结构化优先，但不立即删除文本兜底

现有前端解码顺序本来就是：

1. 先解码 `extra.biz_card`
2. 解不出来再按文本规则识别

所以 Claude 侧最稳妥的迁移方式是：

- 先进入“双轨期”
- 等线上稳定后，再评估是否要把部分文本压缩成更短的 fallback

## 3.3 `reply_source` 继续保留

即使进入结构化阶段，也不建议立刻删掉：

- `reply_source`

原因：

1. 现在状态路由和排障已经大量依赖它
2. Claude 状态卡里，`reply_source` 仍然能提供场景语义
3. 兼容期里保留它最稳

## 四、各场景载荷设计

下面的方案都默认：

- 继续使用现有 `send_msg.payload.extra`
- 在 `extra` 里增加 `biz_card`

即：

```json
{
  "reply_source": "claude_permission_request",
  "approval_request_id": "req-123",
  "biz_card": {
    "version": 1,
    "type": "exec_approval",
    "payload": {}
  }
}
```

## 4.1 Claude 审批请求

### 结构化类型

- `biz_card.type = "exec_approval"`

### 推荐 payload

```json
{
  "approval_id": "req-123",
  "approval_slug": "req-123",
  "approval_command_id": "req-123",
  "command": "Tool: Bash\nCommand: pwd",
  "host": "Claude Clawpool",
  "node_id": "",
  "cwd": "",
  "warning_text": "",
  "expires_in_seconds": 600,
  "allowed_decisions": [
    "allow-once",
    "allow-rule:1",
    "deny"
  ],
  "decision_commands": {
    "allow-once": "/clawpool-approval req-123 allow",
    "allow-rule:1": "/clawpool-approval req-123 allow-rule 1",
    "deny": "/clawpool-approval req-123 deny"
  }
}
```

### 字段映射建议

- `approval_id`
  - 直接使用 `request.request_id`
- `approval_slug`
  - 直接使用 `request.request_id`
- `approval_command_id`
  - 直接使用 `request.request_id`
- `command`
  - 直接复用当前 `buildApprovalRequestText()` 里的“工具摘要区”，不要包含 `Approve once:` / `Deny:` 这些操作行
- `host`
  - 固定 `Claude Clawpool`
- `allowed_decisions`
  - 至少包含 `allow-once` 和 `deny`
  - 如果存在规则建议，再补 `allow-rule:N`
- `decision_commands`
  - 直接使用当前文本协议命令

### 为什么复用 `exec_approval`

因为 AIBot 前端现成就支持：

1. 按钮渲染
2. 规则按钮
3. 点击后发出命令
4. 结果状态折叠回原卡片

这条路径最短。

## 4.2 Claude 审批结果

### 成功决策结果

- `biz_card.type = "exec_status"`

### 推荐 payload

允许一次：

```json
{
  "status": "resolved-allow-once",
  "summary": "Approval request req-123 allowed once.",
  "approval_id": "req-123",
  "approval_command_id": "req-123",
  "decision": "allow-once",
  "resolved_by_id": "sender-1",
  "channel_label": "Claude Clawpool"
}
```

按规则允许：

```json
{
  "status": "resolved-allow-rule",
  "summary": "Approval request req-123 allowed with saved rule 2.",
  "detail_text": "Saved rule: 2",
  "approval_id": "req-123",
  "approval_command_id": "req-123",
  "decision": "allow-rule",
  "resolved_by_id": "sender-1",
  "channel_label": "Claude Clawpool"
}
```

拒绝：

```json
{
  "status": "resolved-deny",
  "summary": "Approval request req-123 denied.",
  "approval_id": "req-123",
  "approval_command_id": "req-123",
  "decision": "deny",
  "resolved_by_id": "sender-1",
  "channel_label": "Claude Clawpool"
}
```

### 非成功状态

像这些情况：

- 审批请求不存在
- 当前聊天不匹配
- 当前 sender 不是 approver
- 请求已经不是 pending

不建议硬塞进 `exec_status`。

建议改为：

- `biz_card.type = "claude_status"`

payload 例子：

```json
{
  "category": "approval",
  "status": "error",
  "summary": "Approval request req-404 was not found.",
  "reference_id": "req-404"
}
```

## 4.3 Claude 提问请求

### 结构化类型

- `biz_card.type = "claude_question"`

### 推荐 payload

```json
{
  "request_id": "question-1",
  "questions": [
    {
      "index": 1,
      "header": "Environment",
      "prompt": "Choose the deployment target.",
      "options": ["prod", "staging"],
      "multi_select": false
    }
  ],
  "answer_command_hint": "/clawpool-question question-1 your answer",
  "footer_text": "Free text is allowed when none of the listed options fit."
}
```

### 字段映射建议

- `request_id`
  - 直接使用 `request.request_id`
- `questions`
  - 直接从 `request.questions` 映射
- `options`
  - 只传 label 数组即可
- `multi_select`
  - 对应现有 `multiSelect`
- `answer_command_hint`
  - 继续保留，便于复制命令兜底
- `footer_text`
  - 继续保留当前的自由输入提示

## 4.4 Claude 提问状态

### 结构化类型

- `biz_card.type = "claude_status"`

### 推荐 payload

成功：

```json
{
  "category": "question",
  "status": "success",
  "summary": "Question request question-1 answers recorded.",
  "reference_id": "question-1"
}
```

错误：

```json
{
  "category": "question",
  "status": "error",
  "summary": "Question request question-1 was not found.",
  "reference_id": "question-1"
}
```

## 4.5 Claude 配对提示

### 结构化类型

- `biz_card.type = "claude_pairing"`

### 推荐 payload

```json
{
  "pairing_code": "XRWEF5",
  "instruction_text": "Ask the Claude Code user to run /clawpool:access pair <code> with this code to approve the sender.",
  "command_hint": "/clawpool:access pair <code>"
}
```

## 4.6 Claude 访问状态

### 结构化类型

- `biz_card.type = "claude_status"`

### 推荐 payload

配对成功：

```json
{
  "category": "access",
  "status": "success",
  "summary": "Paired! Say hi to Claude."
}
```

已禁用：

```json
{
  "category": "access",
  "status": "warning",
  "summary": "Claude Clawpool access is currently disabled for this channel."
}
```

不在 allowlist：

```json
{
  "category": "access",
  "status": "warning",
  "summary": "This sender is not allowlisted for the Claude Clawpool channel."
}
```

## 五、Claude 侧改造点

Claude 插件侧实际只需要做两类改动。

## 5.1 给出站消息补 `extra.biz_card`

当前这些位置最关键：

1. `server/worker/human-loop-service.js`
   - 审批请求
   - 提问请求
   - 审批状态回复
   - 提问状态回复
2. `server/worker/interaction-service.js`
   - pairing 提示
   - access 状态
3. `server/worker/tool-service.js`
   - 配对通过/拒绝后的 access 状态

改造方式不是新增新消息类型，而是：

- 在现有 `bridge.sendText({ extra })` 里补 `extra.biz_card`

## 5.2 把结构化 payload 构造独立出来

建议新增一个单独模块，例如：

- `server/claude-card-payload.js`

按单一职责拆成这些函数：

- `buildClaudeApprovalCardExtra(request)`
- `buildClaudeApprovalStatusCardExtra(input)`
- `buildClaudeQuestionCardExtra(request)`
- `buildClaudeQuestionStatusCardExtra(input)`
- `buildClaudePairingCardExtra(input)`
- `buildClaudeAccessStatusCardExtra(input)`

这样能避免把文本文案构造和卡片 payload 构造继续混在一起。

## 六、迁移顺序

### 第一阶段

只做双发，不改前端逻辑：

1. Claude 插件继续发原文本
2. 同时补 `extra.biz_card`
3. 保留 `reply_source`

验收标准：

1. 老前端还能继续按文本识别
2. 新前端优先走结构化解码
3. 审批卡、提问卡、配对卡、访问状态卡都不回退

### 第二阶段

补结构化测试：

1. Claude 插件侧增加 payload builder 单测
2. AIBot 前端增加 Claude 结构化载荷解码测试
3. 端到端脚本验证点击后仍然回发原命令协议

### 第三阶段

观察线上稳定后，再决定是否压缩文本 fallback。

但短期内不建议删除文本，因为：

1. 文本仍然便于人工排障
2. 老消息历史回放仍然依赖文本
3. `reply_source + 文本` 现在已经稳定

## 七、最终建议

当前最合理的方向不是继续只靠文本猜卡片，也不是直接推翻重做，而是：

1. 复用 AIBot 前端已经存在的 `exec_approval` / `exec_status` / `claude_question` / `claude_status` / `claude_pairing`
2. Claude 插件补发 `extra.biz_card`
3. 保留当前文本协议和 `reply_source` 作为兼容层
4. 先完成审批、提问、配对、访问状态四条结构化链路

这样改动最小，收益最大，也最符合现有代码和前端能力。
