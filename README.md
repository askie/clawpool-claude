# @dhfpub/clawpool-claude

This integration connects Claude to ClawPool ([https://clawpool.dhf.pub/](https://clawpool.dhf.pub/)) so you can manage Claude from the website, with mobile PWA support.

## Quick Start

### 1. Install globally

```bash
npm install -g @dhfpub/clawpool-claude
```

### 2. Install the background service (first time)

Get these 3 values from the ClawPool console first:

- `wsUrl`
- `agentId`
- `apiKey`

Then run:

```bash
clawpool-claude install --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

This command will automatically:

- Save connection settings
- Install a user-level background service
- Start the local `daemon` immediately
- Let `daemon` handle session startup, resume, and message relay

Supported background service managers:

- macOS: `launchd`
- Linux: `systemd --user`
- Windows: Task Scheduler

## Commands you will usually use

```bash
clawpool-claude status
clawpool-claude restart
clawpool-claude stop
clawpool-claude start
clawpool-claude uninstall
```

- `status` checks service and connection status
- `restart` restarts after config changes
- `stop` temporarily stops the background service
- `start` starts the background service again
- `uninstall` removes the background startup entry

## If you only want a temporary foreground run

You can run without installing a background service:

```bash
clawpool-claude --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

If config is already saved locally, you can also just run:

```bash
clawpool-claude
```

## How to start a Claude session

Send this in the related ClawPool private chat:

```text
open <your_working_directory>
```

`daemon` will start or resume the matching Claude session for that directory.

If you are already inside Claude, run:

```text
/clawpool:status
```

If the worker is attached to daemon, the link is healthy.

## Common commands inside Claude

| Command | Purpose |
| --- | --- |
| `/clawpool:status` | Check current connection status |
| `/clawpool:access` | Check current access control |
| `/clawpool:access pair <code>` | Allow a new private-chat sender |
| `/clawpool:access policy <allowlist\|open\|disabled>` | Switch access policy |

Connection parameters are now managed only through local CLI, not from inside Claude sessions.

## Approvals and questions

When Claude needs your confirmation or more information, messages are sent back to ClawPool.

Interactive cards are used by default:

- For approvals, click approve/reject on the card
- For questions, fill the card and submit

Text commands are still available as fallback:

```text
yes <request_id>
no <request_id>
/clawpool-question <request_id> your_answer
```

- Use manual text input only for debugging, troubleshooting, or when cards are unavailable

## File sending

Claude can send local files back to ClawPool. Maximum file size is 50MB, and only common image/video/document formats are supported.

## Log troubleshooting

Each AIBot session ID has an independent log file:

```text
~/.claude/clawpool-claude-daemon/sessions/<aibot_session_id>/logs/daemon-session.log
```

This log records full Claude scheduling flow for that session, including:

- Worker process state changes and PID
- Process relaunch after exit
- Message delivery and result callbacks
- Connectivity probes and timeout decisions

Full troubleshooting steps:

- `docs/session-log-troubleshooting.md`

## CLI commands

```text
clawpool-claude install [options]
clawpool-claude start [options]
clawpool-claude stop [options]
clawpool-claude restart [options]
clawpool-claude status [options]
clawpool-claude uninstall [options]
clawpool-claude [options]
```

`install` is the recommended default. The plain `clawpool-claude [options]` command is better for temporary foreground runs or debugging.

## Common options

```text
--ws-url <value>      ClawPool Agent API WebSocket URL
--agent-id <value>    Agent ID
--api-key <value>     API Key
--data-dir <path>     daemon data directory
--chunk-limit <n>     max text chunk length
--show-claude         show Claude in a visible Terminal window for debugging
--no-launch           validate and save config only, do not start daemon
--help, -h            show help
```

- On first `install` or first foreground run, pass full connection parameters
- If config has already been saved locally, you can omit connection parameters
- Use `--data-dir` to isolate data directories across environments
- `--show-claude` currently supports macOS Terminal only

If Claude seems stuck on the startup confirmation page during development, add `--show-claude` so daemon opens the Claude session in a visible Terminal window.

## Auto-build during development

If you are changing code in this repository, run:

```bash
npm run dev
```

It continuously watches source changes and builds the latest artifacts to:

- `dist/index.js`
- `dist/daemon.js`

For local integration testing, run this in another terminal:

```bash
npm run daemon
```

Then both the daemon process and the worker loaded in Claude sessions will use the latest local build artifacts.

If you want `npm run daemon` to read connection parameters directly from environment variables, run:

```bash
CLAWPOOL_CLAUDE_ENDPOINT='ws://127.0.0.1:27189/v1/agent-api/ws?agent_id=<agent_id>' \
CLAWPOOL_CLAUDE_AGENT_ID='<agent_id>' \
CLAWPOOL_CLAUDE_API_KEY='<api_key>' \
npm run daemon -- --no-launch
```

`CLAWPOOL_CLAUDE_WS_URL` is still supported; if both are provided, daemon prefers environment variable values.
