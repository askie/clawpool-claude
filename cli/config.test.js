import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { loadConfig, resolveDataDir, resolveServerEntryPath } from "./config.js";

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
      GRIX_CLAUDE_ENDPOINT: "ws://env.example/ws",
      GRIX_CLAUDE_API_KEY: "env-key",
    },
    args: {
      wsUrl: "wss://example.com/ws",
      agentId: "agent-1",
      chunkLimit: "2048",
    },
  });

  assert.deepEqual(config, {
    schema_version: 1,
    ws_url: "ws://env.example/ws",
    agent_id: "agent-1",
    api_key: "env-key",
    outbound_text_chunk_limit: 2048,
  });
});

test("resolveServerEntryPath prefers source entry when source and dist both exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grix-config-source-entry-"));
  const sourceDir = path.join(tempDir, "server");
  const distDir = path.join(tempDir, "dist");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(sourceDir, "main.js"), "export default 1;\n", "utf8");
  await writeFile(path.join(distDir, "index.js"), "export default 2;\n", "utf8");

  assert.equal(resolveServerEntryPath(tempDir), path.join(sourceDir, "main.js"));
});

test("resolveServerEntryPath falls back to dist entry when source is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grix-config-dist-entry-"));
  const distDir = path.join(tempDir, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "index.js"), "export default 2;\n", "utf8");

  assert.equal(resolveServerEntryPath(tempDir), path.join(distDir, "index.js"));
});
