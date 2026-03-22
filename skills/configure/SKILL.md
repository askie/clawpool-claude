---
name: configure
description: Configure the Clawpool channel and inspect whether the websocket bridge is ready. Use when the user wants to set ws_url, agent_id, api_key, or check setup status.
user-invocable: true
allowed-tools:
  - mcp__clawpool-claude__configure
  - mcp__clawpool-claude__status
---

# /clawpool-claude:configure

Arguments passed: `$ARGUMENTS`

## Dispatch

### No args

Call the `status` tool once and summarize:

1. Whether config is present
2. Whether websocket is connected and authenticated
3. The current access policy
4. The startup hints returned by the plugin

### JSON args

If `$ARGUMENTS` looks like a JSON object, parse it and call `configure` exactly once with:

- `ws_url`
- `agent_id`
- `api_key`
- `outbound_text_chunk_limit` when present

### Positional args

If `$ARGUMENTS` is not JSON, collect:

1. `ws_url`
2. `agent_id`
3. `api_key`

Do not guess missing secrets. If any required value is missing, ask the user for it. Once all three exist, call `configure` exactly once.

## Response

After a successful configure call:

1. Show the returned status
2. Tell the user that channel delivery requires launching Claude with:
   `cd /tmp/claude-clawpool-claude-<account>-workspace && CLAUDE_PLUGIN_DATA=/abs/path/to/claude-data/clawpool-claude claude --plugin-dir /abs/path/to/claude_plugins/clawpool-claude --dangerously-load-development-channels server:clawpool-claude`
3. If the plugin still is not authenticated, point them to the returned hints instead of inventing extra troubleshooting steps
