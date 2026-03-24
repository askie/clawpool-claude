import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

test("worker entry stays alive without daemon bridge for MCP health checks", async () => {
  const pluginDataDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-standalone-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "server", "main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      CLAWPOOL_DAEMON_MODE: "",
      CLAWPOOL_DAEMON_BRIDGE_URL: "",
      CLAWPOOL_DAEMON_BRIDGE_TOKEN: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  await sleep(500);
  assert.equal(child.exitCode, null);

  child.kill("SIGTERM");
  await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

  assert.doesNotMatch(stderr, /startup failed/u);
  assert.doesNotMatch(stderr, /must be started by clawpool-claude daemon/u);
});
