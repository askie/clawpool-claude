# @dhf-claude/clawpool

Connect [ClawPool.dhf.pub](https://clawpool.dhf.pub) private chats directly into Claude Code.

## Quick Start

### 1. Global Installation

```bash
npm install -g @dhf-claude/clawpool
```

### 2. Initial Daemon Setup

First, obtain these 3 values from the ClawPool console:

- `wsUrl`
- `agentId`
- `apiKey`

Then run:

```bash
clawpool-claude install --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

This command automatically performs the following:

- Saves the connection configuration
- Installs the background service for the current user
- Immediately starts the local `daemon`
- Delegates session startup, recovery, and message forwarding to the `daemon`

Supported background service managers:

- macOS: `launchd`
- Linux: `systemd --user`
- Windows: Task Scheduler

## Common Commands

You will typically only need these commands moving forward:

```bash
clawpool-claude status
clawpool-claude restart
clawpool-claude stop
clawpool-claude start
clawpool-claude uninstall
```

- `status`: Check service and connection status
- `restart`: Restart the service (e.g., after a config change)
- `stop`: Temporarily stop the background service
- `start`: Start the background service
- `uninstall`: Remove the background startup item

## Running in the Foreground (Optional)

You don't have to install the background service. To run it directly, execute:

```bash
clawpool-claude --ws-url <ws_url> --agent-id <agent_id> --api-key <api_key>
```

Once the configuration is saved locally, you can simply run:

```bash
clawpool-claude
```

## How to Start a Claude Session

First, send the following in the corresponding ClawPool private chat:

```text
open <your_working_directory>
```

The `daemon` will start or resume the Claude session for this directory.

If you are already inside Claude, you can run:

```text
/clawpool:status
```

If you see that the worker is successfully attached to the daemon, the connection is functioning correctly.

## Common Claude Commands

| Command | Purpose |
| --- | --- |
| `/clawpool:status` | Check the current connection status |
| `/clawpool:access` | Check current access controls |
| `/clawpool:access pair <code>` | Allow a new private chat sender |
| `/clawpool:access policy <allowlist\|open\|disabled>` | Switch the access policy |

Connection parameters are now modified exclusively via the local CLI and can no longer be changed from within the Claude session.

## Approvals and Questions

When Claude needs you to confirm an action or provide additional information, the message is routed back to ClawPool.

Interactive cards are prioritized by default:

- **Approval Cards**: Click 'Approve' or 'Reject' directly.
- **Question Cards**: Fill out the form in the card and submit.

Text commands remain available as a fallback:

```text
yes <request_id>
no <request_id>
/clawpool-question <request_id> your answer
```

- You only need to type these commands manually for debugging, troubleshooting, or if the interactive cards are unavailable.

## File Sending

Claude can send local files back to ClawPool. The maximum file size is 50MB. Only common image, video, and document formats are supported.

## Troubleshooting Logs

Each AIBot session ID gets its own dedicated log file:

```text
~/.claude/clawpool-claude-daemon/sessions/<aibot_session_id>/logs/daemon-session.log
```

This log tracks the complete lifecycle of Claude orchestration in that session, including:

- Worker process state changes and PIDs
- Restarts after process exits
- Message delivery and result reporting
- Communication probes and timeout determinations

For full troubleshooting steps, see:

- `docs/session-log-troubleshooting.md`

## CLI Reference

```text
clawpool-claude install [options]
clawpool-claude start [options]
clawpool-claude stop [options]
clawpool-claude restart [options]
clawpool-claude status [options]
clawpool-claude uninstall [options]
clawpool-claude [options]
```

It is recommended to use `install` as the primary method. The default command `clawpool-claude [options]` is better suited for temporary foreground execution or debugging.

## Common Options

```text
--ws-url <value>      ClawPool Agent API WebSocket URL
--agent-id <value>    Agent ID
--api-key <value>     API Key
--data-dir <path>     daemon data directory
--chunk-limit <n>     Maximum length for a single text chunk
--show-claude         Bring Claude into a visible Terminal window for debugging
--no-launch           Only verify and write the configuration, do not start the daemon
--help, -h            Show help
```

- Complete connection parameters must be provided during the first `install` or foreground launch.
- If the configuration is already saved locally, connection parameters can be omitted.
- `--data-dir` can be used to specify an isolated data directory, which is useful when running multiple environments separately.
- `--show-claude` is currently only supported on macOS Terminal.

During development, if you suspect Claude is stuck on the startup confirmation prompt, add `--show-claude`. This allows the daemon to pull the Claude session into a visible Terminal window.

## Auto-Compilation During Development

If you are modifying the code in this repository, run:

```bash
npm run dev
```

This will continuously watch for source changes and automatically compile the latest outputs into your project at:

- `dist/index.js`
- `dist/daemon.js`

While debugging locally, open another terminal window and run:

```bash
npm run daemon
```

This ensures that both the daemon process and the worker loaded in the Claude session use the freshly compiled development output.

If you want `npm run daemon` to pull connection parameters directly from environment variables, run it like this:

```bash
CLAWPOOL_CLAUDE_ENDPOINT='ws://127.0.0.1:27189/v1/agent-api/ws?agent_id=<agent_id>' \
CLAWPOOL_CLAUDE_AGENT_ID='<agent_id>' \
CLAWPOOL_CLAUDE_API_KEY='<api_key>' \
npm run daemon -- --no-launch
```

`CLAWPOOL_CLAUDE_WS_URL` is also still supported. If both are provided, the daemon will prioritize environment variables.
