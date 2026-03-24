---
name: clawpool:configure
description: Explain that Clawpool connection settings are now managed only by the host daemon CLI.
user-invocable: true
allowed-tools: []
---

# /clawpool:configure

Arguments passed: `$ARGUMENTS`

## Response

1. Explain plainly that `ws_url`、`agent_id`、`api_key` 不再从 Claude 会话里修改。
2. 告诉用户在宿主机上执行：

```text
clawpool-claude --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key> --no-launch
```

3. 如果用户要立刻拉起服务，再告诉他们去掉 `--no-launch` 重跑一次。
