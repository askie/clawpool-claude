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

    const listeningLog = await waitFor(async () => {
      const content = await readFile(runtime.stdout_log_path, "utf8").catch(() => "");
      if (!content) {
        return "";
      }
      return hasChannelListeningSignal(content) ? content : "";
    }, {
      timeoutMs: 90_000,
      intervalMs: 500,
    });
    assert.ok(listeningLog, "real Claude startup did not reach channel listening state");
  } finally {
    await workerProcessManager.stopWorker(workerID).catch(() => {});
  }
});

test("e2e: real Claude worker settles inbound events within timeout budget", async () => {
  const realClaudeCommand = resolveRealClaudeCommand();
  assert.ok(
    commandExists(realClaudeCommand),
    `real Claude command is required for e2e test but was not found: ${realClaudeCommand}`,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-real-timeout-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const pluginDataDir = path.join(tempRoot, "plugin-data");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(pluginDataDir, { recursive: true });

  const registerCalls = [];
  const statusCalls = [];
  const composingCalls = [];
  const eventResultCalls = [];

  const bridgeServer = new WorkerBridgeServer({
    token: randomUUID(),
    async onRegisterWorker(payload) {
      registerCalls.push(payload);
      return { ok: true };
    },
    async onStatusUpdate(payload) {
      statusCalls.push(payload);
      return { ok: true };
    },
    async onSetSessionComposing(payload) {
      composingCalls.push(payload);
      return { ok: true };
    },
    async onSendEventResult(payload) {
      eventResultCalls.push(payload);
      return { ok: true };
    },
  });
  await bridgeServer.start();

  const aibotSessionID = randomUUID();
  const claudeSessionID = randomUUID();
  const workerID = randomUUID();
  const workerProcessManager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAUDE_BIN: realClaudeCommand,
      CLAWPOOL_CLAUDE_EVENT_RESULT_TIMEOUT_MS: "2500",
      CLAWPOOL_CLAUDE_EVENT_RESULT_RETRY_TIMEOUT_MS: "1000",
      CLAWPOOL_CLAUDE_COMPOSING_HEARTBEAT_MS: "500",
      CLAWPOOL_CLAUDE_COMPOSING_TTL_MS: "1000",
    },
    packageRoot: process.cwd(),
    async ensureUserMcpServer() {},
  });

  await workerProcessManager.spawnWorker({
    aibotSessionID,
    cwd: workspaceDir,
    pluginDataDir,
    claudeSessionID,
    workerID,
    bridgeURL: bridgeServer.getURL(),
    bridgeToken: bridgeServer.token,
  });

  try {
    const registered = await waitFor(() => (
      registerCalls.find((entry) => (
        normalizeString(entry?.aibot_session_id) === aibotSessionID
        && normalizeString(entry?.worker_id) === workerID
        && normalizeString(entry?.worker_control_url)
        && normalizeString(entry?.worker_control_token)
      )) ?? null
    ), {
      timeoutMs: 90_000,
      intervalMs: 200,
    });
    assert.ok(registered, "worker did not register daemon bridge control endpoint");

    const readyStatus = await waitFor(() => (
      statusCalls.find((entry) => (
        normalizeString(entry?.aibot_session_id) === aibotSessionID
        && normalizeString(entry?.worker_id) === workerID
        && normalizeString(entry?.status) === "ready"
      )) ?? null
    ), {
      timeoutMs: 90_000,
      intervalMs: 200,
    });
    assert.ok(readyStatus, "worker did not reach ready status in real Claude e2e");

    const startupAlreadyBlocking = await workerProcessManager.hasStartupBlockingMcpServerFailure(workerID);
    if (startupAlreadyBlocking) {
      assert.equal(startupAlreadyBlocking, true);
      return;
    }

    const eventID = `evt-real-timeout-${randomUUID()}`;
    const startedAt = Date.now();
    const delivered = await postJSON(
      `${registered.worker_control_url}/v1/worker/deliver-event`,
      registered.worker_control_token,
      {
        event_id: eventID,
        session_id: aibotSessionID,
        msg_id: `msg-${Date.now()}`,
        sender_id: "sender-real-e2e",
        content: "real e2e timeout fallback check",
      },
    );
    assert.equal(delivered.response.status, 200);
    assert.equal(delivered.body?.ok, true);

    const eventResult = await waitFor(() => (
      eventResultCalls.find((entry) => normalizeString(entry?.event_id) === eventID) ?? null
    ), {
      timeoutMs: 30_000,
      intervalMs: 200,
    });

    if (!eventResult) {
      const startupBlockingFailure = await workerProcessManager.hasStartupBlockingMcpServerFailure(workerID);
      assert.equal(
        startupBlockingFailure,
        true,
        "event did not settle and startup blocking failure was not detected",
      );
      return;
    }
    assert.ok(Date.now() - startedAt < 30_000, "inbound event exceeded settle timeout budget");
    assert.equal(
      composingCalls.some((entry) => (
        normalizeString(entry?.ref_event_id) === eventID
        && entry?.active === true
      )),
      true,
    );
    assert.equal(
      composingCalls.some((entry) => (
        normalizeString(entry?.ref_event_id) === eventID
        && entry?.active === false
      )),
      true,
    );
  } finally {
    await workerProcessManager.stopWorker(workerID).catch(() => {});
    await bridgeServer.stop();
  }
});
