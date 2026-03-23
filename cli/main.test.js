import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { run } from "./main.js";

test("cli run routes daemon subcommand", async () => {
  const outputs = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run(["daemon", "--exit-after-ready"], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /daemon 已启动/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli run routes worker subcommand", async () => {
  const outputs = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run(["worker"], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /worker 命令已就绪/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test("cli daemon subcommand persists daemon config when options are provided", async () => {
  const outputs = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-cli-"));
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };

  try {
    const exitCode = await run([
      "daemon",
      "--exit-after-ready",
      "--data-dir",
      tempDir,
      "--ws-url",
      "ws://127.0.0.1:7777/ws",
      "--agent-id",
      "agent-1",
      "--api-key",
      "key-1",
      "--chunk-limit",
      "2048",
    ], {});
    assert.equal(exitCode, 0);
    assert.match(outputs.join(""), /已配置: yes/u);

    const config = JSON.parse(
      await readFile(path.join(tempDir, "daemon-config.json"), "utf8"),
    );
    assert.equal(config.ws_url, "ws://127.0.0.1:7777/ws");
    assert.equal(config.agent_id, "agent-1");
    assert.equal(config.api_key, "key-1");
    assert.equal(config.outbound_text_chunk_limit, 2048);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});
