import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerEnvironment } from "./daemon/worker-process.js";

test("buildWorkerEnvironment passes daemon connection config to worker", () => {
  const env = buildWorkerEnvironment({
    baseEnv: { PATH: "/usr/bin" },
    pluginDataDir: "/tmp/plugin-data",
    aibotSessionID: "chat-1",
    claudeSessionID: "claude-1",
    workerID: "worker-1",
    bridgeURL: "http://127.0.0.1:9000",
    bridgeToken: "bridge-token",
    connectionConfig: {
      wsURL: "ws://example.com/ws",
      agentID: "agent-1",
      apiKey: "secret-key",
      outboundTextChunkLimit: 2048,
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CLAUDE_PLUGIN_DATA, "/tmp/plugin-data");
  assert.equal(env.CLAWPOOL_AIBOT_SESSION_ID, "chat-1");
  assert.equal(env.CLAWPOOL_CLAUDE_SESSION_ID, "claude-1");
  assert.equal(env.CLAWPOOL_WORKER_ID, "worker-1");
  assert.equal(env.CLAWPOOL_DAEMON_BRIDGE_URL, "http://127.0.0.1:9000");
  assert.equal(env.CLAWPOOL_DAEMON_BRIDGE_TOKEN, "bridge-token");
  assert.equal(env.CLAWPOOL_WS_URL, "ws://example.com/ws");
  assert.equal(env.CLAWPOOL_AGENT_ID, "agent-1");
  assert.equal(env.CLAWPOOL_API_KEY, "secret-key");
  assert.equal(env.CLAWPOOL_OUTBOUND_TEXT_CHUNK_LIMIT, "2048");
});
