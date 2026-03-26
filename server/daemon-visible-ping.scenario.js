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
import { WorkerBridgeServer } from "./daemon/worker-bridge-server.js";

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

async function postJSON(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function stripTerminalControlSequences(content) {
  return String(content ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/g, "\n");
}

function hasChannelListeningSignal(content) {
  const normalized = stripTerminalControlSequences(content);
  return /Listening for channel messages from: server:clawpool-claude/iu.test(normalized);
}

function parsePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

async function main() {
  const realClaudeCommand = resolveRealClaudeCommand();
  assert.ok(
    commandExists(realClaudeCommand),
    `real Claude command is required but was not found: ${realClaudeCommand}`,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-visible-ping-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const pluginDataDir = path.join(tempRoot, "plugin-data");
  const debugLogPath = path.join(tempRoot, "worker-debug.log");
  const pauseMs = parsePositiveInt(process.env.CLAWPOOL_CLAUDE_VISIBLE_PING_PAUSE_MS, 20_000);
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(pluginDataDir, { recursive: true });

  const timeline = [];
  let workerControlURL = "";
  let workerControlToken = "";

  const bridgeServer = new WorkerBridgeServer({
    token: randomUUID(),
    async onRegisterWorker(payload) {
      workerControlURL = normalizeString(payload?.worker_control_url);
      workerControlToken = normalizeString(payload?.worker_control_token);
      timeline.push({
        type: "register",
        at: Date.now(),
        worker_control_url: workerControlURL,
      });
      return { ok: true };
    },
    async onStatusUpdate(payload) {
      timeline.push({
        type: "status",
        at: Date.now(),
        status: normalizeString(payload?.status),
      });
      return { ok: true };
    },
    async onSendText(payload) {
      timeline.push({
        type: "send_text",
        at: Date.now(),
        text: String(payload?.text ?? ""),
        event_id: normalizeString(payload?.event_id),
      });
      return {
        ok: true,
        msg_id: `msg-${Date.now()}`,
      };
    },
    async onSendEventResult(payload) {
      timeline.push({
        type: "event_result",
        at: Date.now(),
        status: normalizeString(payload?.status),
        code: normalizeString(payload?.code),
        msg: normalizeString(payload?.msg),
        event_id: normalizeString(payload?.event_id),
      });
      return { ok: true };
    },
  });
  await bridgeServer.start();

  const aibotSessionID = randomUUID();
  const workerID = randomUUID();
  const workerProcessManager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "1",
      CLAWPOOL_CLAUDE_TRACE_LOG: "1",
      CLAWPOOL_CLAUDE_E2E_DEBUG: "1",
      CLAWPOOL_CLAUDE_E2E_DEBUG_LOG: debugLogPath,
      CLAUDE_BIN: realClaudeCommand,
      CLAWPOOL_CLAUDE_EVENT_RESULT_TIMEOUT_MS: "15000",
      CLAWPOOL_CLAUDE_EVENT_RESULT_RETRY_TIMEOUT_MS: "2000",
      CLAWPOOL_CLAUDE_COMPOSING_HEARTBEAT_MS: "500",
      CLAWPOOL_CLAUDE_COMPOSING_TTL_MS: "1000",
    },
    packageRoot: process.cwd(),
    async ensureUserMcpServer() {},
  });

  const runtime = await workerProcessManager.spawnWorker({
    aibotSessionID,
    cwd: workspaceDir,
    pluginDataDir,
    claudeSessionID: randomUUID(),
    workerID,
    bridgeURL: bridgeServer.getURL(),
    bridgeToken: bridgeServer.token,
  });

  try {
    const startupObserved = await waitFor(async () => {
      const stdoutContent = await readFile(runtime.stdout_log_path, "utf8").catch(() => "");
      if (hasChannelListeningSignal(stdoutContent)) {
        return true;
      }
      const debugContent = await readFile(debugLogPath, "utf8").catch(() => "");
      return debugContent.includes("status=ready") ? true : null;
    }, {
      timeoutMs: 90_000,
      intervalMs: 500,
    });
    assert.ok(startupObserved, "Claude did not reach listening or ready state");

    await waitFor(() => (
      timeline.find((entry) => entry.type === "status" && entry.status === "ready") ?? null
    ), {
      timeoutMs: 30_000,
      intervalMs: 200,
    });

    const eventID = `evt-visible-ping-${randomUUID()}`;
    const delivered = await postJSON(
      `${workerControlURL}/v1/worker/deliver-event`,
      workerControlToken,
      {
        payload: {
          event_id: eventID,
          session_id: aibotSessionID,
          msg_id: `msg-${Date.now()}`,
          sender_id: "visible-ping-user",
          content: "ping",
        },
      },
    );
    assert.equal(delivered.response.status, 200);
    assert.equal(delivered.body?.ok, true);
    timeline.push({
      type: "probe_delivered",
      at: Date.now(),
      event_id: eventID,
      content: "ping",
    });

    console.log(`visible_claude_window: opened`);
    console.log(`worker_control_url: ${workerControlURL}`);
    console.log(`debug_log: ${debugLogPath}`);
    console.log(`event_id: ${eventID}`);
    console.log(`now_waiting_ms: ${pauseMs}`);

    await sleep(pauseMs);

    const finalDebugLog = await readFile(debugLogPath, "utf8").catch(() => "");
    const finalStdoutLog = await readFile(runtime.stdout_log_path, "utf8").catch(() => "");
    console.log("timeline:");
    console.log(JSON.stringify(timeline, null, 2));
    console.log("debug_log_tail:");
    console.log(finalDebugLog.split("\n").slice(-40).join("\n"));
    console.log("stdout_log_tail:");
    console.log(stripTerminalControlSequences(finalStdoutLog).split("\n").slice(-40).join("\n"));
  } finally {
    await workerProcessManager.stopWorker(workerID).catch(() => {});
    await bridgeServer.stop();
  }
}

await main();
