import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, resolveDataDir } from "./config.js";

test("resolveDataDir prefers explicit input over environment", () => {
  assert.equal(
    resolveDataDir({
      dataDir: "/tmp/custom-data",
      env: {
        CLAUDE_PLUGIN_DATA: "/tmp/env-data",
      },
    }),
    "/tmp/custom-data",
  );
});

test("loadConfig merges stored values with cli input and environment", async () => {
  const tempDir = path.join(process.cwd(), "tmp-config-test");
  const config = await loadConfig({
    dataDir: tempDir,
    env: {
      CLAWPOOL_API_KEY: "env-key",
    },
    args: {
      wsUrl: "wss://example.com/ws",
      agentId: "agent-1",
      chunkLimit: "2048",
    },
  });

  assert.deepEqual(config, {
    schema_version: 1,
    ws_url: "wss://example.com/ws",
    agent_id: "agent-1",
    api_key: "env-key",
    outbound_text_chunk_limit: 2048,
  });
});
