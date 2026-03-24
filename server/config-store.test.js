import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { ConfigStore } from "./config-store.js";

test("config store accepts CLAWPOOL_CLAUDE_ENDPOINT as daemon ws env override", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-config-store-"));
  const configPath = path.join(tempDir, "daemon-config.json");
  await writeFile(configPath, `${JSON.stringify({
    schema_version: 1,
    ws_url: "ws://stored.example/ws",
    agent_id: "stored-agent",
    api_key: "stored-key",
    outbound_text_chunk_limit: 1200,
  }, null, 2)}\n`, "utf8");

  const store = new ConfigStore(configPath, {
    env: {
      CLAWPOOL_CLAUDE_ENDPOINT: "ws://127.0.0.1:27189/v1/agent-api/ws?agent_id=2035251418226495488",
      CLAWPOOL_CLAUDE_AGENT_ID: "2035251418226495488",
      CLAWPOOL_CLAUDE_API_KEY: "ak_2035251418226495488_Gyav9cyaOHbAUP7qrOJ4JHv13FR0XgwB",
    },
  });

  await store.load();

  assert.deepEqual(store.getConnectionConfig(), {
    wsURL: "ws://127.0.0.1:27189/v1/agent-api/ws?agent_id=2035251418226495488",
    agentID: "2035251418226495488",
    apiKey: "ak_2035251418226495488_Gyav9cyaOHbAUP7qrOJ4JHv13FR0XgwB",
    outboundTextChunkLimit: 1200,
  });
});
