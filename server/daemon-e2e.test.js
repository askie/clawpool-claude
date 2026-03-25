import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkerBridgeServer } from "./daemon/worker-bridge-server.js";
import { WorkerProcessManager } from "./daemon/worker-process.js";

const realClaudeE2EEnabled = process.env.CLAWPOOL_ENABLE_REAL_CLAUDE_E2E === "1";
const realClaudeCommand = String(process.env.CLAWPOOL_REAL_CLAUDE_BIN || process.env.CLAUDE_BIN || "claude").trim();

function commandExists(command) {
  if (!command) {
    return false;
  }
  if (command.includes("/") || command.startsWith(".")) {
    const probe = spawnSync("test", ["-x", command], { stdio: "ignore" });
    return probe.status === 0;
  }
  const probe = spawnSync("which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

async function waitFor(check, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) {
      return lastValue;
    }
    await sleep(intervalMs);
  }
  return lastValue;
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function stripTerminalControlSequences(input) {
  return String(input ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/g, "");
}

test("real e2e: spawn real claude command and observe startup auto-confirm markers", async (t) => {
  if (!realClaudeE2EEnabled) {
    t.skip("set CLAWPOOL_ENABLE_REAL_CLAUDE_E2E=1 to run real Claude e2e");
    return;
  }
  if (process.platform !== "darwin") {
    t.skip("real Claude startup prompt auto-confirm e2e currently targets macOS hidden-pty path");
    return;
  }
  if (!commandExists(realClaudeCommand)) {
    t.skip(`real Claude command is not executable: ${realClaudeCommand}`);
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-real-claude-e2e-"));
  const pluginDataDir = path.join(tempRoot, "plugin-data");
  await mkdir(pluginDataDir, { recursive: true });

  const sessionID = "chat-real-claude-e2e";
  const workerID = "worker-real-claude-e2e";
  const claudeSessionID = randomUUID();
  const statusEvents = [];
  let runtime = null;

  const bridgeServer = new WorkerBridgeServer({
    onRegisterWorker: async () => ({ ok: true }),
    onStatusUpdate: async (payload) => {
      statusEvents.push({
        status: String(payload?.status ?? "").trim(),
        ts: Date.now(),
      });
      return { ok: true };
    },
  });
  await bridgeServer.start();

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAUDE_BIN: realClaudeCommand,
    },
    packageRoot: process.cwd(),
    async ensureUserMcpServer() {},
  });

  try {
    runtime = await manager.spawnWorker({
      aibotSessionID: sessionID,
      cwd: process.cwd(),
      pluginDataDir,
      claudeSessionID,
      workerID,
      bridgeURL: bridgeServer.getURL(),
      bridgeToken: bridgeServer.token,
      resumeSession: false,
    });

    const readyStatus = await waitFor(() => {
      return statusEvents.find((item) => item.status === "ready");
    }, { timeoutMs: 90_000 });

    const startupReadySignal = await waitFor(async () => {
      const output = await readText(runtime.stdout_log_path);
      const plainText = stripTerminalControlSequences(output);
      const sawListeningLine = /Listening\s*for\s*channel messages\s*from:\s*server:clawpool-claude/u.test(plainText)
        || /Listening[\s\S]*server:clawpool-claude/u.test(output);
      if (
        output.includes("[clawpool] startup_channel_listening")
        || sawListeningLine
      ) {
        return output;
      }
      return null;
    }, { timeoutMs: 45_000 });

    assert.ok(readyStatus, "real claude worker did not report ready status in time");
    assert.ok(startupReadySignal, "did not observe startup channel listening signal from real claude output");

    const output = await readText(runtime.stdout_log_path);
    const sawConfirmPrompt = output.includes("Enter to confirm")
      || output.includes("I am using this for local development")
      || /Press.*Enter.*(continue|confirm)/u.test(output);
    if (sawConfirmPrompt) {
      assert.match(output, /\[clawpool\] startup_prompt_auto_confirm/u);
    }
  } finally {
    if (runtime?.worker_id) {
      await manager.stopWorker(runtime.worker_id).catch(() => {});
    }
    await bridgeServer.stop();
  }
});
