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

function hasChannelListeningSignal(content) {
  const raw = String(content ?? "");
  if (/\[clawpool\]\s+startup_channel_listening/u.test(raw)) {
    return true;
  }
  return /Listening for channel messages from: server:clawpool-claude/iu.test(
    normalizeRuntimeLog(content),
  );
}

async function readRuntimeLogs(runtime) {
  const [stdoutContent, stderrContent] = await Promise.all([
    readFile(runtime.stdout_log_path, "utf8").catch(() => ""),
    readFile(runtime.stderr_log_path, "utf8").catch(() => ""),
  ]);
  return `${stdoutContent}\n${stderrContent}`;
}

async function readTextFile(filePath) {
  return readFile(filePath, "utf8").catch(() => "");
}

function traceLineIndex(content, { stage, includes = [] } = {}) {
  const expectedStage = normalizeString(stage);
  if (!expectedStage) {
    return -1;
  }
  const lines = stripTerminalControlSequences(content).split("\n");
  return lines.findIndex((line) => (
    line.includes(`stage=${expectedStage}`)
    && includes.every((item) => line.includes(item))
  ));
}

function emitDiagnostic(label, payload) {
  if (process.env.CLAWPOOL_CLAUDE_E2E_DEBUG !== "1") {
    return;
  }
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  console.error(`[e2e:mcp] ${label}\n${body}`);
}

function parseOptionalPauseMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

test("e2e: real Claude ready ping is weaker than an active probe", async () => {
  const realClaudeCommand = resolveRealClaudeCommand();
  assert.ok(
    commandExists(realClaudeCommand),
    `real Claude command is required for e2e test but was not found: ${realClaudeCommand}`,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-real-mcp-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const pluginDataDir = path.join(tempRoot, "plugin-data");
  const debugLogPath = path.join(tempRoot, "worker-debug.log");
  const pauseMs = parseOptionalPauseMs(process.env.CLAWPOOL_CLAUDE_E2E_PAUSE_MS);
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(pluginDataDir, { recursive: true });

  const timeline = [];
  const statusCalls = [];
  const eventResultCalls = [];
  let currentWorkerControlURL = "";
  let currentWorkerControlToken = "";
  let connectedPing = null;

  const bridgeServer = new WorkerBridgeServer({
    token: randomUUID(),
    async onRegisterWorker(payload) {
      currentWorkerControlURL = normalizeString(payload?.worker_control_url);
      currentWorkerControlToken = normalizeString(payload?.worker_control_token);
      timeline.push({
        type: "register",
        at: Date.now(),
        worker_id: normalizeString(payload?.worker_id),
        claude_session_id: normalizeString(payload?.claude_session_id),
        worker_control_url: currentWorkerControlURL,
      });
      return { ok: true };
    },
    async onStatusUpdate(payload) {
      const status = normalizeString(payload?.status);
      statusCalls.push(payload);
      timeline.push({
        type: "status",
        at: Date.now(),
        status,
        worker_id: normalizeString(payload?.worker_id),
        claude_session_id: normalizeString(payload?.claude_session_id),
      });

      if (status === "connected" && currentWorkerControlURL && currentWorkerControlToken) {
        const ping = await postJSON(
          `${currentWorkerControlURL}/v1/worker/ping`,
          currentWorkerControlToken,
          {},
        );
        assert.equal(ping.response.status, 200);
        connectedPing = ping.body;
        timeline.push({
          type: "ping_after_connected",
          at: Date.now(),
          payload: connectedPing,
        });
      }

      return { ok: true };
    },
    async onSendEventResult(payload) {
      eventResultCalls.push(payload);
      timeline.push({
        type: "event_result",
        at: Date.now(),
        event_id: normalizeString(payload?.event_id),
        status: normalizeString(payload?.status),
        code: normalizeString(payload?.code),
        msg: normalizeString(payload?.msg),
      });
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
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: process.env.CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW === "1"
        ? "1"
        : "0",
      CLAUDE_BIN: realClaudeCommand,
      CLAWPOOL_CLAUDE_TRACE_LOG: "1",
      CLAWPOOL_CLAUDE_E2E_DEBUG: "1",
      CLAWPOOL_CLAUDE_E2E_DEBUG_LOG: debugLogPath,
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
    claudeSessionID,
    workerID,
    bridgeURL: bridgeServer.getURL(),
    bridgeToken: bridgeServer.token,
  });

  try {
    const startupObserved = await waitFor(async () => {
      const content = await readFile(runtime.stdout_log_path, "utf8").catch(() => "");
      if (hasChannelListeningSignal(content)) {
        return {
          kind: "listening",
          content,
        };
      }
      const debugContent = await readTextFile(debugLogPath);
      if (traceLineIndex(debugContent, {
        stage: "worker_status_requested",
        includes: ["status=ready"],
      }) >= 0) {
        return {
          kind: "ready",
          content: debugContent,
        };
      }
      return null;
    }, {
      timeoutMs: 90_000,
      intervalMs: 500,
    });
    assert.ok(startupObserved, "real Claude startup did not reach listening or ready state");

    const registered = await waitFor(() => (
      timeline.find((entry) => entry.type === "register") ?? null
    ), {
      timeoutMs: 90_000,
      intervalMs: 200,
    });
    assert.ok(registered, "worker did not register daemon bridge control endpoint");

    const connectedStatus = await waitFor(() => (
      statusCalls.find((entry) => normalizeString(entry?.status) === "connected") ?? null
    ), {
      timeoutMs: 90_000,
      intervalMs: 200,
    });
    assert.ok(connectedStatus, "worker did not emit connected status");

    const readyStatus = await waitFor(() => (
      statusCalls.find((entry) => normalizeString(entry?.status) === "ready") ?? null
    ), {
      timeoutMs: 90_000,
      intervalMs: 200,
    });
    assert.ok(readyStatus, "worker did not emit ready status");

    assert.ok(connectedPing, "connected-status probe did not capture worker ping payload");
    assert.equal(connectedPing?.mcp_ready, false);

    const readyPingResult = await waitFor(async () => {
      const ping = await postJSON(
        `${currentWorkerControlURL}/v1/worker/ping`,
        currentWorkerControlToken,
        {},
      );
      if (ping.response.status !== 200 || ping.body?.mcp_ready !== true) {
        return null;
      }
      return ping;
    }, {
      timeoutMs: 30_000,
      intervalMs: 200,
    });
    assert.ok(readyPingResult, "worker ping did not report mcp_ready=true after ready status");
    timeline.push({
      type: "ping_after_ready",
      at: Date.now(),
      payload: readyPingResult.body,
    });
    assert.equal(readyPingResult.body?.mcp_ready, true);

    const eventID = `evt-real-mcp-probe-${randomUUID()}`;
    const delivered = await postJSON(
      `${currentWorkerControlURL}/v1/worker/deliver-event`,
      currentWorkerControlToken,
      {
        payload: {
          event_id: eventID,
          session_id: aibotSessionID,
          msg_id: `msg-${Date.now()}`,
          sender_id: "sender-real-mcp-probe",
          content: [
            "HEALTH PROBE.",
            "For this message do exactly two tool calls and nothing else.",
            "First call the status tool with no arguments.",
            'Then call the complete tool for the current channel event_id with status "responded", code "probe_pong", and msg "pong".',
            "Do not send any visible reply.",
          ].join(" "),
        },
      },
    );
    assert.equal(delivered.response.status, 200);
    assert.equal(delivered.body?.ok, true);
    timeline.push({
      type: "probe_delivered",
      at: Date.now(),
      event_id: eventID,
    });

    const eventResult = await waitFor(() => (
      eventResultCalls.find((entry) => normalizeString(entry?.event_id) === eventID) ?? null
    ), {
      timeoutMs: 30_000,
      intervalMs: 200,
    });
    const startupBlockingFailure = await workerProcessManager.hasStartupBlockingMcpServerFailure(workerID);
    const runtimeLog = await readRuntimeLogs(runtime);
    const finalDebugLog = await readTextFile(debugLogPath);
    const probeStatus = normalizeString(eventResult?.status);
    const probeCode = normalizeString(eventResult?.code);
    const probeMsg = normalizeString(eventResult?.msg);

    const readyLine = traceLineIndex(finalDebugLog, {
      stage: "worker_status_requested",
      includes: ["status=ready"],
    });
    const deliverEventLine = traceLineIndex(finalDebugLog, {
      stage: "deliver_event_received",
      includes: [`event_id=${eventID}`],
    });
    const channelNotificationLine = traceLineIndex(finalDebugLog, {
      stage: "channel_notification_dispatched",
      includes: [`event_id=${eventID}`],
    });
    const statusCallLine = traceLineIndex(finalDebugLog, {
      stage: "mcp_call_tool_received",
      includes: ["tool_name=status"],
    });
    const completeCallLine = traceLineIndex(finalDebugLog, {
      stage: "mcp_call_tool_received",
      includes: ["tool_name=complete", `event_id=${eventID}`],
    });

    assert.ok(readyLine >= 0, "did not capture ready status request in runtime log");
    assert.ok(deliverEventLine >= 0, "did not capture probe event delivery in debug log");
    assert.ok(channelNotificationLine >= 0, "did not capture probe channel notification dispatch");
    assert.ok(readyLine < deliverEventLine, "probe event was delivered before ready was reported");
    assert.ok(
      deliverEventLine <= channelNotificationLine,
      "channel notification was dispatched before the probe event reached the worker",
    );

    if (probeStatus === "responded" && probeCode === "probe_pong" && probeMsg === "pong") {

      const probePingResult = await waitFor(async () => {
        const ping = await postJSON(
          `${currentWorkerControlURL}/v1/worker/ping`,
          currentWorkerControlToken,
          {},
        );
        if (ping.response.status !== 200 || ping.body?.mcp_ready !== true) {
          return null;
        }
        if (
          Number(ping.body?.mcp_last_activity_at ?? 0)
          < Number(readyPingResult.body?.mcp_last_activity_at ?? 0)
        ) {
          return null;
        }
        return ping;
      }, {
        timeoutMs: 30_000,
        intervalMs: 200,
      });
      assert.ok(probePingResult, "worker ping did not report probe activity");
      timeline.push({
        type: "ping_after_probe",
        at: Date.now(),
        payload: probePingResult.body,
      });
      assert.equal(probePingResult.body?.mcp_ready, true);

      if (statusCallLine >= 0 && completeCallLine >= 0) {
        assert.ok(readyLine < statusCallLine, "active probe tool call happened before ready was reported");
        assert.ok(statusCallLine < completeCallLine, "complete tool call happened before status tool call");
      }
    } else {
      if (eventResult) {
        assert.equal(probeStatus, "failed");
        assert.equal(probeCode, "claude_result_timeout");
      } else {
        assert.equal(
          startupBlockingFailure,
          true,
          "probe event did not settle and startup MCP failure was not recorded",
        );
      }
      assert.match(
        runtimeLog,
        /(\[clawpool\]\s+startup_mcp_server_failed|MCP\s+server\s+failed)/iu,
      );
      timeline.push({
        type: "probe_failed",
        at: Date.now(),
        status: probeStatus,
        code: probeCode,
        msg: probeMsg,
        startup_blocking_failure: startupBlockingFailure,
      });
    }

    emitDiagnostic("timeline", timeline);
    emitDiagnostic(
      "trace_lines",
      stripTerminalControlSequences(finalDebugLog)
        .split("\n")
        .filter((line) => (
          (line.includes("stage=worker_status_requested") && line.includes("status=ready"))
          || line.includes("stage=deliver_event_received")
          || line.includes("stage=channel_notification_dispatched")
          || line.includes("stage=mcp_call_tool_received")
          || line.includes("stage=mcp_call_tool_completed")
        )),
    );
    emitDiagnostic("worker_logs", {
      stdout_log_path: runtime.stdout_log_path,
      stderr_log_path: runtime.stderr_log_path,
      debug_log_path: debugLogPath,
    });
    if (pauseMs > 0) {
      emitDiagnostic("pause_before_cleanup_ms", pauseMs);
      await sleep(pauseMs);
    }
  } finally {
    await workerProcessManager.stopWorker(workerID).catch(() => {});
    await bridgeServer.stop();
  }
});
