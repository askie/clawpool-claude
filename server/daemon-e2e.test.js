import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkerProcessManager } from "./daemon/worker-process.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function resolveRealClaudeCommand(env = process.env) {
  if (process.platform === "win32") {
    return env.CLAUDE_BIN || "claude.cmd";
  }
  return env.CLAUDE_BIN || "claude";
}

function commandExists(command) {
  const normalized = normalizeString(command);
  if (!normalized) {
    return false;
  }
  if (path.isAbsolute(normalized) || normalized.includes(path.sep)) {
    try {
      accessSync(normalized, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const locator = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(locator, [normalized], {
    stdio: "ignore",
  });
  return located.status === 0;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
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

function stripTerminalControlSequences(content) {
  return String(content ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/g, "\n");
}

function normalizeRuntimeLog(content) {
  return stripTerminalControlSequences(content)
    .replace(/\s+/gu, " ")
    .trim();
}

function hasStartupPromptText(content) {
  return /Enter to confirm/iu.test(normalizeRuntimeLog(content));
}

function hasStartupPromptAutoConfirmMarker(content) {
  return /\[clawpool\]\s+startup_prompt_auto_confirm/u.test(String(content ?? ""));
}

function hasChannelListeningSignal(content) {
  const raw = String(content ?? "");
  if (/\[clawpool\]\s+startup_channel_listening/u.test(raw)) {
    return true;
  }
  return /Listening for channel messages from: server:clawpool-claude/iu.test(
    normalizeRuntimeLog(content),
  );
}

test("e2e: default path boots real Claude and auto-confirms startup prompts", async () => {
  const realClaudeCommand = resolveRealClaudeCommand();
  assert.ok(
    commandExists(realClaudeCommand),
    `real Claude command is required for e2e test but was not found: ${realClaudeCommand}`,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-real-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const pluginDataDir = path.join(tempRoot, "plugin-data");
  await mkdir(workspaceDir, { recursive: true });

  const workerProcessManager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAUDE_BIN: realClaudeCommand,
    },
    packageRoot: process.cwd(),
    async ensureUserMcpServer() {},
  });

  const workerID = randomUUID();
  const runtime = await workerProcessManager.spawnWorker({
    aibotSessionID: randomUUID(),
    cwd: workspaceDir,
    pluginDataDir,
    claudeSessionID: randomUUID(),
    workerID,
    bridgeURL: "",
    bridgeToken: "",
  });

  try {
    assert.ok(Number(runtime.pid) > 0, "real Claude process pid is missing");

    const startupLog = await waitFor(async () => {
      const content = await readFile(runtime.stdout_log_path, "utf8").catch(() => "");
      if (!content) {
        return "";
      }
      if (hasStartupPromptAutoConfirmMarker(content) || hasChannelListeningSignal(content)) {
        return content;
      }
      if (hasStartupPromptText(content)) {
        return content;
      }
      return "";
    }, {
      timeoutMs: 90_000,
      intervalMs: 500,
    });

    assert.ok(startupLog, "real Claude startup log stayed empty or had no startup state signal");

    if (hasStartupPromptText(startupLog)) {
      assert.equal(
        hasStartupPromptAutoConfirmMarker(startupLog),
        true,
        "startup prompt appeared but auto-confirm marker was not emitted",
      );
    }

    assert.equal(
      hasStartupPromptAutoConfirmMarker(startupLog) || hasChannelListeningSignal(startupLog),
      true,
      "startup log did not expose prompt auto-confirm or channel listening signal",
    );
  } finally {
    await workerProcessManager.stopWorker(workerID).catch(() => {});
  }
});
