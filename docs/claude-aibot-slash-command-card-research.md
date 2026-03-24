# Claude 对接文档清单与 AIBot 卡片渲染边界

> 2026-03 更新：这份文档主要保留当时的调研过程。当前仓库已经改成“审批走 Claude 原生 channel permission relay，提问主路径走 Claude `Elicitation` hook”，所以下面不少“当前状态”描述已经过时，只适合拿来理解历史背景。

## 目标

这份文档先回答两个问题：

1. Claude 官方文档里，哪些能力会影响我们做斜杠命令和交互式卡片。
2. 现在 `clawpool-claude` 到底已经做到哪里，哪些地方真的需要 AIBot 侧做交互式卡片渲染。

先把边界讲清楚，再谈渲染方案，避免把「Claude 终端里的斜杠命令」和「AIBot 远端聊天里的交互」混成一件事。

## 一、Claude 官方文档清单

下面这些是这次判断范围里最关键的官方文档。

### 1. Channels reference

- 链接: <https://code.claude.com/docs/en/channels-reference>
- 为什么重要:
  - 说明外部聊天桥接到 Claude 的标准方式是 `claude/channel`
  - 说明消息是以 `notifications/claude/channel` 推进 Claude 会话，不是把远端聊天内容直接当作 Claude 终端输入
  - 说明原生支持的远端权限转发能力是 `claude/channel/permission`

这份文档决定了一个核心事实：

- AIBot 进来的消息，本质上是 channel event
- 不是 Claude Code 本地终端里的 `/xxx` 命令输入

### 2. Built-in commands

- 链接: <https://code.claude.com/docs/en/commands>
- 为什么重要:
  - 这里列出了 Claude Code 内建 `/` 命令全集
  - 很多命令本身依赖终端里的菜单、选择器、对话框、状态页

这份文档用来判断：

- 哪些 `/` 命令天然属于 Claude 终端本地体验
- 哪些命令如果未来真要远端化，会需要额外的交互卡片设计

### 3. Interactive mode

- 链接: <https://code.claude.com/docs/en/interactive-mode>
- 为什么重要:
  - 这里明确 Claude Code 有终端内对话框、菜单、方向键切换、选择器等交互
  - 说明很多 `/` 命令不是简单的一次性文本输出，而是终端 UI 行为

这份文档直接告诉我们：

- 不能把 Claude 终端的交互式 `/` 命令，简单等价成 AIBot 里一条文本消息

### 4. Skills

- 链接: <https://code.claude.com/docs/en/skills>
- 为什么重要:
  - Claude Code 里的自定义 `/命令`，现在统一归到 skills
  - 项目内的 `skills/*/SKILL.md` 正是这套机制

这份文档用来确认：

- 我们仓库里的 `/clawpool:status`、`/clawpool:access` 属于 Claude Code skill 命令
- 这些命令运行位置仍然是 Claude Code 会话侧，不是 AIBot 原生 UI

### 5. Permissions

- 链接: <https://code.claude.com/docs/en/permissions>
- 为什么重要:
  - 这里说明 `/permissions` 是 Claude 终端里的权限管理 UI
  - 说明 Claude 的权限确认分层和工具审批规则

这份文档用来区分：

- Claude 本地权限 UI
- 我们自己桥接出去的远端审批流程

### 6. Hooks reference

- 链接: <https://code.claude.com/docs/en/hooks>
- 为什么重要:
  - 说明 `PreToolUse`、`PermissionRequest`、`Notification`、`Elicitation` 等事件
  - 我们项目里的远端审批、远端追问，本质上就是拿 hooks 接住 Claude 事件后，再转发到 AIBot

这份文档用来确认：

- 当前项目的人机交互不是直接走 Claude 原生 channel permission relay
- 而是走 hooks + 本地存储 + AIBot 文本命令回填

## 二、当前仓库的真实实现

### 2.1 AIBot 到 Claude 的入口不是斜杠命令入口

当前实现里，AIBot 消息进来后会被转成：

- `notifications/claude/channel`
- 然后以 `<channel ...>消息内容</channel>` 的形式进入 Claude 上下文

也就是说：

- AIBot 发来的 `/something`
- 在当前架构里，本质上仍然是一条 channel message
- 不是 Claude Code 本地输入框里的真实 `/something`

这决定了一个非常关键的边界：

- 现在不能说“Claude 所有斜杠命令已经对接到 AIBot”
- 目前对接的是“远端聊天事件桥接”

### 2.2 当前仓库里真正存在的命令分三层

### A. Claude Code 本地 skill 命令

仓库里已经定义的 Claude skill 命令主要是：

- `/clawpool:status`
- `/clawpool:access`

这些命令的定位是：

- 在 Claude Code 会话里运行
- 调本地 MCP tool
- 返回状态或修改本地访问控制

它们不是 AIBot 原生交互卡片。

### B. AIBot 聊天侧控制命令

当前 daemon 直接在 AIBot 文本里解析的控制命令是：

- `open <cwd>`
- `status`
- `where`
- `stop`

这些命令是桥接层自己的会话控制命令，不是 Claude Code 官方 `/` 命令。

### C. AIBot 聊天侧的人机交互回填命令

当前已经落地的远端交互回填命令是：

- `/clawpool-approval <request_id> allow`
- `/clawpool-approval <request_id> allow-rule <index>`
- `/clawpool-approval <request_id> deny [reason]`
- `/clawpool-question <request_id> 你的回答`
- `/clawpool-question <request_id> 1=first answer; 2=second answer`

这套命令现在已经可用，但还是“文本回复协议”，不是卡片。

### 2.3 命令与卡片判断矩阵

| 类别 | 当前入口 | 当前状态 | 是否应做 AIBot 交互卡片 |
| --- | --- | --- | --- |
| Claude 本地 skill 命令 | `/clawpool:status`、`/clawpool:access` | 已可用，本地执行 | 否 |
| AIBot 会话控制命令 | `open/status/where/stop` | 已可用，文本控制 | 不是当前重点，可做信息卡 |
| 远端审批回填 | `/clawpool-approval ...` | 已可用，纯文本 | 是，优先级最高 |
| 远端提问回填 | `/clawpool-question ...` | 已可用，纯文本 | 是，优先级最高 |
| Claude 内建 `/` 命令 | `/config`、`/permissions`、`/model` 等 | 当前未远端化 | 否，不应误判进本期范围 |
| Claude 原生 permission relay | `notifications/claude/channel/permission_request` | 当前未接入 | 否，本期先不按这条链路做 |

### 2.4 当前远端交互真正接住了什么

当前项目已经桥接了两类 Claude 交互：

### 1. 权限审批

来源：

- `PermissionRequest` hook

当前行为：

- 生成 approval request
- 异步发到 AIBot
- 等待 AIBot 用 `/clawpool-approval ...` 回答

### 2. AskUserQuestion 追问

来源：

- `PreToolUse` hook，针对 `AskUserQuestion`

当前行为：

- 生成 question request
- 异步发到 AIBot
- 等待 AIBot 用 `/clawpool-question ...` 回答

### 2.5 当前没有做成卡片发送

虽然入站事件已经会保存 `biz_card_json`，但当前出站到 AIBot 的实现只有两种：

- 纯文本消息 `msg_type: 1`
- 媒体消息 `msg_type: 2`

现在没有看到任何“主动向 AIBot 下发 biz_card/card payload”的实现。

所以当前状态很明确：

- 远端审批和远端提问已经打通
- 但发给 AIBot 时仍然是纯文本
- 还没有完成交互式卡片渲染

## 三、哪些命令/场景需要 AIBot 侧做交互式卡片

这里要分成“当前必须做”和“不要误判成当前要做”两类。

### 3.1 当前必须做的交互卡片

### 1. Approval 卡片

优先级：最高

原因：

- 这是当前远端审批主流程
- 已经有完整请求数据结构
- 现在只是文本展示，用户输入成本高

建议卡片字段：

- 请求 ID
- 工具名
- 工具摘要
- 关键输入预览
- `Allow once`
- `Deny`
- `Allow rule N`（如果存在建议规则）
- 可选拒绝原因输入框

回填目标：

- 仍然落到现有 approval resolve 流程
- 只是把“手打命令”换成“点卡片提交”

### 2. Question 卡片

优先级：最高

原因：

- 这是当前远端追问主流程
- 已经有 questions、options、multiSelect 这些结构化数据
- 天然适合卡片表单

建议卡片字段：

- Request ID
- 每个问题的 header
- 问题正文
- 单选选项
- 多选选项
- 自由输入框

回填目标：

- 仍然落到现有 question resolve 流程
- 只是把 `/clawpool-question ...` 文本协议换成卡片提交

### 3.2 可以做展示卡，但不应该做成远端可执行交互卡片

### 1. Pairing 提示

当前 sender 未放行时，会发 pairing code。

这个场景可以考虑做成“信息卡”：

- 展示 pairing code
- 展示下一步动作说明

但不建议直接在 AIBot 做“点一下就完成放行”的交互卡片，因为仓库当前设计明确把访问控制变更放在 Claude 侧受信操作里。

### 2. 会话状态提示

像 `open/status/where/stop` 的结果，可以做摘要卡提高可读性，但这不是最优先的交互卡片需求。

### 3.3 现在不要误判为 AIBot 卡片范围的内容

### 1. Claude Code 内建 `/` 命令全集

比如：

- `/config`
- `/permissions`
- `/model`
- `/memory`
- `/mcp`
- `/agents`
- `/tasks`
- `/theme`
- `/diff`

这些命令很多依赖 Claude 终端自身的菜单、页签、选择器、状态面板。

在当前架构下：

- 它们不是通过 AIBot 聊天直接触发的
- 也不是当前 channel bridge 自动需要镜像到 AIBot 的东西

所以现在不能把这些命令都算进“已接入但还差卡片渲染”。

### 2. Claude 原生 channel permission relay

Claude 官方原生方案是：

- channel 声明 `claude/channel/permission`
- Claude 发 `notifications/claude/channel/permission_request`
- 远端返回 allow / deny verdict

但当前项目没有走这条原生链路，而是自己实现了：

- hook 拦截
- request store
- AIBot 文本命令回填

所以当前要做的卡片方案，应当基于现有 approval/question 流程落地，不要误以为仓库已经接上了 Claude 原生 permission relay。

### 3. Claude 终端里的交互通知

`hooks/hooks.json` 里已经监听了：

- `permission_prompt`
- `elicitation_dialog`
- `idle_prompt`

但当前只是记录通知，没有真正往 AIBot 做结构化展示，也没有完成闭环交互。

这说明：

- 仓库已经意识到这些终端通知存在
- 但它们现在还不是已完成的 AIBot 卡片能力

## 四、结论

结论先说清楚：

- 目前“与 Claude 对接后的斜杠命令”并没有完成 AIBot 侧卡片渲染
- 严格来说，当前架构也还没有把 Claude Code 的真实斜杠命令体系整体搬到 AIBot
- 当前真正已经打通、并且最值得先做交互卡片的，是两条远端人机交互链路：
  - approval
  - question

换句话说，当前最合理的方案不是“先做一个通用斜杠命令卡片系统”，而是：

1. 先把 approval 卡片做出来
2. 再把 question 卡片做出来
3. 保留文本命令作为兜底
4. 后面再评估要不要扩展到 pairing 信息卡、状态摘要卡

## 五、与 AIBot 侧文档对齐结果

对照 AIBot 侧文档：

- `/Volumes/disk1/go/src/aibot-openclaw-cards/docs/openclaw_interactive_cards.md`

可以把当前结论拆成两层理解。

### 5.1 已经对齐的部分

按“当前这套文本驱动卡片流程”来看，Claude 侧和 AIBot 侧是对齐的。

#### 1. Claude 审批卡链路已对齐

Claude 侧当前行为：

- 发 `extra.reply_source = "claude_permission_request"`
- 发固定审批文本
- 等待 AIBot 回 `/clawpool-approval ...`

AIBot 侧当前行为：

- 按 `reply_source + 固定文本格式` 识别审批卡
- 按钮点击后回发 `/clawpool-approval ...`
- 后续结果消息再识别成审批状态卡

这条链路现在是闭环的。

#### 2. Claude 提问卡链路已对齐

Claude 侧当前行为：

- 发 `extra.reply_source = "claude_ask_user_question"`
- 发固定提问文本
- 等待 AIBot 回 `/clawpool-question ...`

AIBot 侧当前行为：

- 按 `reply_source + 固定文本格式` 识别提问卡
- 支持单选、多选、自由输入
- 提交后回发 `/clawpool-question ...`

这条链路现在也是闭环的。

#### 3. Claude 配对卡和访问状态卡也对齐

Claude 侧当前行为：

- sender 未放行时发固定 pairing 文本
- access 结果发 `extra.reply_source = "claude_channel_access"`

AIBot 侧当前行为：

- pairing 按固定文本识别成配对卡
- access 状态按 `claude_channel_access` 识别成状态卡

所以“前端能不能把这几类消息渲染出来”这件事，当前答案是能。

### 5.2 还没有完全对齐的部分

真正没有完全对齐的，不是前端渲染，而是“完成态”的定义。

#### 1. AIBot 文档里的“已完成”

AIBot 侧文档里，“Claude 审批卡 / 提问卡 / 配对卡 / 访问状态卡已完成”的含义更接近：

- 前端已经能识别这些消息
- 前端已经能把它们渲染成卡片
- 审批卡和提问卡已经能把用户操作回发成现有文本命令

#### 2. Claude 侧文档里的“还没完成卡片渲染”

这份文档里说“还没有完成交互式卡片渲染”，指的是：

- Claude 插件当前没有主动发送结构化 `biz_card`
- Claude 插件当前仍然只发文本消息和媒体消息
- 现在的卡片效果依赖 AIBot 前端对固定文本的识别，不是插件原生下发卡片

所以这两个说法并不是互相否定，而是站位不同：

- AIBot 侧说的是“前端渲染能力和现有流程已经完成”
- Claude 侧说的是“插件侧还没有进入结构化卡片下发阶段”

### 5.3 当前最准确的统一口径

现在可以把口径更新成下面这句话：

- Claude Clawpool 渠道的审批、提问、配对、访问状态，已经完成“结构化卡片 + 文本兜底”的双轨闭环；
- `open` 命令在“缺少工作目录”这个场景下，也已经补成了交互卡片；
- AIBot 前端会优先走结构化卡片，解不出来时再回退到 `reply_source + 固定文本格式`。

这样说最贴近当前实现，也把“结构化卡片已落地”和“文本兜底仍保留”同时说清楚。

如果要继续往前做结构化载荷方案，见：

- `/Volumes/disk1/go/src/clawpool-claude-wt-slash-cards/docs/claude-aibot-structured-card-payload-plan.md`

## 六、建议的落地顺序

### 第一阶段

已经完成：

- approval card
- question card
- pairing info card
- access / question / approval status card
- `open` 缺目录交互卡

当前要求：

- 卡片提交后仍直接走现有文本命令协议
- 保留 `/clawpool-approval`、`/clawpool-question`、`/clawpool open` 兜底

### 第二阶段

如果产品目标变成“远端也要像 Claude 终端一样操作更多 `/命令`”，那就不是单纯做卡片渲染了，而是要单独设计：

- 远端命令执行入口
- 命令权限边界
- 终端交互状态映射
- 选择器/表单/分页在 AIBot 的等价物

这会是另一条产品和架构线，不应混入当前 approval/question 卡片项目里。
