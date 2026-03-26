import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { HookSignalStore } from "./hook-signal-store.js";
import { DaemonBridgeRuntime } from "./worker/bridge-runtime.js";
import { WorkerBridgeServer } from "./daemon/worker-bridge-server.js";

test("daemon bridge runtime ping includes worker identity and pid", async () => {
  const bridge = new DaemonBridgeRuntime({
    env: {
      CLAWPOOL_CLAUDE_DAEMON_MODE: "1",
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL: "http://127.0.0.1:19999",
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN: "bridge-token",
      CLAWPOOL_CLAUDE_WORKER_ID: "worker-ping",
      CLAWPOOL_CLAUDE_AIBOT_SESSION_ID: "chat-ping",
      CLAWPOOL_CLAUDE_SESSION_ID: "claude-ping",
    },
  });
  await bridge.startControlServer();

  try {
    const response = await fetch(`${bridge.getWorkerControlURL()}/v1/worker/ping`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.getWorkerControlToken()}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.worker_id, "worker-ping");
    assert.equal(payload.aibot_session_id, "chat-ping");
    assert.equal(payload.claude_session_id, "claude-ping");
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.mcp_ready, false);
    assert.equal(payload.mcp_last_activity_at, 0);
  } finally {
    await bridge.stopControlServer();
  }
});

test("daemon bridge runtime does not treat composing heartbeat as MCP activity", async () => {
  const calls = [];
  const server = new WorkerBridgeServer({
    token: "bridge-token",
    async onSetSessionComposing(payload) {
      calls.push(payload);
      return { ok: true };
    },
  });
  await server.start();

  const bridge = new DaemonBridgeRuntime({
    env: {
      CLAWPOOL_CLAUDE_DAEMON_MODE: "1",
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL: server.getURL(),
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN: "bridge-token",
      CLAWPOOL_CLAUDE_WORKER_ID: "worker-ping",
      CLAWPOOL_CLAUDE_AIBOT_SESSION_ID: "chat-ping",
      CLAWPOOL_CLAUDE_SESSION_ID: "claude-ping",
    },
  });
  await bridge.startControlServer();

  try {
    await bridge.setSessionComposing({
      sessionID: "chat-ping",
      active: true,
      ttlMs: 30000,
      refEventID: "evt-activity",
      refMsgID: "msg-activity",
    });

    const response = await fetch(`${bridge.getWorkerControlURL()}/v1/worker/ping`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.getWorkerControlToken()}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].worker_id, "worker-ping");
    assert.equal(calls[0].aibot_session_id, "chat-ping");
    assert.equal(calls[0].claude_session_id, "claude-ping");
    assert.equal(calls[0].pid, process.pid);
    assert.equal(calls[0].session_id, "chat-ping");
    assert.equal(calls[0].active, true);
    assert.equal(payload.mcp_last_activity_at, 0);
  } finally {
    await bridge.stopControlServer();
    await server.stop();
  }
});

test("daemon bridge runtime ping includes latest hook signal snapshot", async () => {
  const pluginDataDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-hook-ping-"));
  const hookSignalStore = new HookSignalStore(path.join(pluginDataDir, "hook-signals.json"));
  await hookSignalStore.recordHookEvent({
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    session_id: "chat-hook",
  }, {
    recordedAt: 321,
  });

  const bridge = new DaemonBridgeRuntime({
    env: {
      CLAWPOOL_CLAUDE_DAEMON_MODE: "1",
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL: "http://127.0.0.1:19999",
      CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN: "bridge-token",
      CLAWPOOL_CLAUDE_WORKER_ID: "worker-hook",
      CLAWPOOL_CLAUDE_AIBOT_SESSION_ID: "chat-hook",
      CLAWPOOL_CLAUDE_SESSION_ID: "claude-hook",
      CLAUDE_PLUGIN_DATA: pluginDataDir,
    },
  });
  await bridge.startControlServer();

  try {
    const response = await fetch(`${bridge.getWorkerControlURL()}/v1/worker/ping`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.getWorkerControlToken()}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.hook_last_activity_at, 321);
    assert.equal(payload.hook_latest_event?.hook_event_name, "PostToolUse");
    assert.equal(payload.hook_latest_event?.detail, "Read");
    assert.equal(payload.hook_recent_events?.length, 1);
  } finally {
    await bridge.stopControlServer();
  }
});
