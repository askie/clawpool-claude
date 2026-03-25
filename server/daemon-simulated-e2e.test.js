import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { BindingRegistry } from "./daemon/binding-registry.js";
import { MessageDeliveryStore } from "./daemon/message-delivery-store.js";
import { WorkerBridgeServer } from "./daemon/worker-bridge-server.js";
import { WorkerProcessManager } from "./daemon/worker-process.js";
import { DaemonRuntime } from "./daemon/runtime.js";
import { shouldIgnoreWorkerStatusUpdate } from "./daemon/main.js";

// NOTE:
// This suite intentionally uses a fake Claude process for deterministic
// failure-injection scenarios. The real Claude command e2e smoke test is in
// server/daemon-e2e.test.js.

function makeAibotClient(sent) {
  return {
    ackEvent(eventID, payload) {
      sent.push({ kind: "ack", eventID, payload });
    },
    sendEventResult(payload) {
      sent.push({ kind: "event_result", payload });
    },
    async sendText(payload) {
      sent.push({ kind: "text", payload });
      return { msg_id: "1" };
    },
  };
}

async function waitFor(check, { timeoutMs = 8000, intervalMs = 50 } = {}) {
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

function isProcessRunning(pid) {
  const normalizedPID = Number(pid);
  if (!Number.isFinite(normalizedPID) || normalizedPID <= 0) {
    return false;
  }
  try {
    process.kill(Math.floor(normalizedPID), 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function writeFakeClaudeScript(tempRoot, { mode = "ready", readyDelayMs = 0 } = {}) {
  const scriptPath = path.join(tempRoot, `fake-claude-${mode}.mjs`);
  await writeFile(scriptPath, `#!/usr/bin/env node
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const mode = ${JSON.stringify(mode)};
const readyDelayMs = Number(${JSON.stringify(readyDelayMs)});

if (mode === "auth_fail") {
  process.stderr.write("Please run /login · API Error: 401\\n");
  await sleep(20);
  process.exit(1);
}

const bridgeURL = String(process.env.CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL ?? "").trim();
const bridgeToken = String(process.env.CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN ?? "").trim();
const workerID = String(process.env.CLAWPOOL_CLAUDE_WORKER_ID ?? "").trim();
const aibotSessionID = String(process.env.CLAWPOOL_CLAUDE_AIBOT_SESSION_ID ?? "").trim();
const claudeSessionID = String(process.env.CLAWPOOL_CLAUDE_SESSION_ID ?? "").trim();
const pluginDataDir = String(process.env.CLAUDE_PLUGIN_DATA ?? "").trim();

if (!bridgeURL || !bridgeToken || !workerID || !aibotSessionID || !claudeSessionID) {
  process.stderr.write("missing daemon bridge env\\n");
  process.exit(2);
}

async function post(pathname, payload) {
  const response = await fetch(\`\${bridgeURL}\${pathname}\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: \`Bearer \${bridgeToken}\`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(\`bridge \${pathname} failed status=\${response.status} body=\${text}\`);
  }
}

const basePayload = {
  worker_id: workerID,
  aibot_session_id: aibotSessionID,
  claude_session_id: claudeSessionID,
  pid: process.pid,
  worker_control_url: "http://127.0.0.1:1",
  worker_control_token: "stub-token",
};

await post("/v1/worker/register", {
  ...basePayload,
  cwd: process.cwd(),
  plugin_data_dir: pluginDataDir,
});
await post("/v1/worker/status", {
  ...basePayload,
  status: "connected",
});
if (readyDelayMs > 0) {
  await sleep(readyDelayMs);
}
await post("/v1/worker/status", {
  ...basePayload,
  status: "ready",
});

const hold = setInterval(() => {}, 1000);
const shutdown = () => {
  clearInterval(hold);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
await new Promise(() => {});
`, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function postBridgeStatus(bridgeServer, payload) {
  const response = await fetch(`${bridgeServer.getURL()}/v1/worker/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bridgeServer.token}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
}

async function createHarness({
  mode = "ready",
  readyDelayMs = 0,
  runtimeOptions = {},
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const fakeClaudePath = await writeFakeClaudeScript(tempRoot, { mode, readyDelayMs });

  const sent = [];
  const bindingRegistry = new BindingRegistry({
    bindingFilePath: path.join(tempRoot, "binding-registry.json"),
    workerRuntimeFilePath: path.join(tempRoot, "binding-registry.worker-runtimes.json"),
  });
  await bindingRegistry.load();
  const messageDeliveryStore = new MessageDeliveryStore(path.join(tempRoot, "message-delivery-state.json"));
  await messageDeliveryStore.load();

  const workerProcessManager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAUDE_BIN: fakeClaudePath,
    },
    packageRoot: process.cwd(),
    async ensureUserMcpServer() {},
  });

  let runtime = null;
  const bridgeServer = new WorkerBridgeServer({
    onRegisterWorker: async (payload) => {
      const aibotSessionID = String(payload?.aibot_session_id ?? "").trim();
      const existing = bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (!existing) {
        return { ok: false, reason: "binding_not_found" };
      }
      await bindingRegistry.markWorkerStarting(aibotSessionID, {
        workerID: String(payload?.worker_id ?? "").trim(),
        workerPid: Number(payload?.pid ?? 0),
        workerControlURL: String(payload?.worker_control_url ?? "").trim(),
        workerControlToken: String(payload?.worker_control_token ?? "").trim(),
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      return { ok: true };
    },
    onStatusUpdate: async (payload) => {
      const aibotSessionID = String(payload?.aibot_session_id ?? "").trim();
      const status = String(payload?.status ?? "").trim();
      const previousBinding = bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (!previousBinding) {
        return { ok: false, reason: "binding_not_found" };
      }
      if (shouldIgnoreWorkerStatusUpdate(previousBinding, payload)) {
        return { ok: true };
      }
      let nextBinding = null;
      if (status === "failed") {
        nextBinding = await bindingRegistry.markWorkerFailed(aibotSessionID, {
          updatedAt: Date.now(),
          lastStoppedAt: Date.now(),
        });
      } else if (status === "stopped") {
        nextBinding = await bindingRegistry.markWorkerStopped(aibotSessionID, {
          updatedAt: Date.now(),
          lastStoppedAt: Date.now(),
        });
      } else if (status === "connected") {
        nextBinding = await bindingRegistry.markWorkerConnected(aibotSessionID, {
          workerID: String(payload?.worker_id ?? "").trim(),
          workerPid: Number(payload?.pid ?? 0),
          workerControlURL: String(payload?.worker_control_url ?? "").trim(),
          workerControlToken: String(payload?.worker_control_token ?? "").trim(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      } else {
        nextBinding = await bindingRegistry.markWorkerReady(aibotSessionID, {
          workerID: String(payload?.worker_id ?? "").trim(),
          workerPid: Number(payload?.pid ?? 0),
          workerControlURL: String(payload?.worker_control_url ?? "").trim(),
          workerControlToken: String(payload?.worker_control_token ?? "").trim(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      }
      await runtime?.handleWorkerStatusUpdate?.(previousBinding, nextBinding);
      return { ok: true };
    },
  });
  await bridgeServer.start();

  let spawnCalls = 0;
  const originalSpawnWorker = workerProcessManager.spawnWorker.bind(workerProcessManager);
  workerProcessManager.spawnWorker = async (...args) => {
    spawnCalls += 1;
    return originalSpawnWorker(...args);
  };

  runtime = new DaemonRuntime({
    env: {
      ...process.env,
      HOME: os.homedir(),
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempRoot,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAUDE_BIN: fakeClaudePath,
    },
    bindingRegistry,
    workerProcessManager,
    aibotClient: makeAibotClient(sent),
    bridgeServer,
    messageDeliveryStore,
    workerRuntimeHealthCheckMs: 0,
    ...runtimeOptions,
  });

  return {
    tempRoot,
    workspaceDir,
    sent,
    bindingRegistry,
    messageDeliveryStore,
    workerProcessManager,
    bridgeServer,
    runtime,
    getSpawnCalls() {
      return spawnCalls;
    },
    async cleanup() {
      for (const binding of bindingRegistry.listBindings()) {
        const workerID = String(binding?.worker_id ?? "").trim();
        if (workerID) {
          await workerProcessManager.stopWorker(workerID).catch(() => {});
        }
      }
      await runtime.close();
      await bridgeServer.stop();
    },
  };
}

async function openSession(runtime, sessionID, workspaceDir, index) {
  await runtime.handleEvent({
    event_id: `evt-e2e-open-${index}`,
    session_id: sessionID,
    msg_id: `msg-e2e-open-${index}`,
    sender_id: "sender-e2e-open",
    content: `open ${workspaceDir}`,
  });
}

async function waitForReadyBinding(bindingRegistry, sessionID, timeoutMs = 6000) {
  return waitFor(() => {
    const binding = bindingRegistry.getByAibotSessionID(sessionID);
    if (!binding) {
      return null;
    }
    if (binding.worker_status !== "ready") {
      return null;
    }
    if (!binding.worker_id || !binding.worker_pid) {
      return null;
    }
    return binding;
  }, { timeoutMs });
}

test("e2e: open creates worker and second open on same cwd does not respawn", async () => {
  const harness = await createHarness();
  const sessionID = "chat-e2e-open";
  try {
    await openSession(harness.runtime, sessionID, harness.workspaceDir, 1);
    const readyBinding = await waitForReadyBinding(harness.bindingRegistry, sessionID);
    assert.ok(readyBinding);
    assert.equal(harness.getSpawnCalls(), 1);

    await openSession(harness.runtime, sessionID, harness.workspaceDir, 2);
    assert.equal(harness.getSpawnCalls(), 1);
    assert.equal(
      harness.sent.some((item) => item.kind === "text" && /当前会话已经绑定/u.test(String(item?.payload?.text ?? ""))),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});

test("e2e: while worker is starting, repeated open coalesces to one spawn", async () => {
  const harness = await createHarness({
    readyDelayMs: 300,
  });
  const sessionID = "chat-e2e-open-coalesce";
  try {
    const first = openSession(harness.runtime, sessionID, harness.workspaceDir, 1);
    await sleep(30);
    const second = openSession(harness.runtime, sessionID, harness.workspaceDir, 2);
    await Promise.all([first, second]);

    const readyBinding = await waitForReadyBinding(harness.bindingRegistry, sessionID);
    assert.ok(readyBinding);
    assert.equal(harness.getSpawnCalls(), 1);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: worker process crash is detected and next ensureWorker can recover", async () => {
  const harness = await createHarness();
  const sessionID = "chat-e2e-crash";
  try {
    await openSession(harness.runtime, sessionID, harness.workspaceDir, 1);
    const beforeCrash = await waitForReadyBinding(harness.bindingRegistry, sessionID);
    assert.ok(beforeCrash);
    const oldPid = Number(beforeCrash.worker_pid ?? 0);
    assert.equal(isProcessRunning(oldPid), true);

    process.kill(oldPid, "SIGKILL");
    await waitFor(() => !isProcessRunning(oldPid), { timeoutMs: 3000 });
    assert.equal(isProcessRunning(oldPid), false);

    const changed = await harness.runtime.reconcileWorkerProcess(
      harness.bindingRegistry.getByAibotSessionID(sessionID),
    );
    assert.equal(changed, true);
    assert.equal(harness.bindingRegistry.getByAibotSessionID(sessionID)?.worker_status, "stopped");

    await harness.runtime.ensureWorker(harness.bindingRegistry.getByAibotSessionID(sessionID));
    const recovered = await waitForReadyBinding(harness.bindingRegistry, sessionID);
    assert.ok(recovered);
    assert.equal(harness.getSpawnCalls(), 2);
    assert.notEqual(Number(recovered.worker_pid ?? 0), oldPid);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: auth-failed worker enters cooldown and immediate user event does not respawn", async () => {
  const harness = await createHarness({
    mode: "auth_fail",
    runtimeOptions: {
      authFailureCooldownMs: 60_000,
    },
  });
  const sessionID = "chat-e2e-auth-fail";
  try {
    await openSession(harness.runtime, sessionID, harness.workspaceDir, 1);
    const initialBinding = await waitFor(() => harness.bindingRegistry.getByAibotSessionID(sessionID), {
      timeoutMs: 3000,
    });
    assert.ok(initialBinding);
    const workerID = String(initialBinding.worker_id ?? "");
    assert.ok(workerID);
    await waitFor(
      async () => harness.workerProcessManager.hasAuthLoginRequiredError(workerID),
      { timeoutMs: 3000, intervalMs: 50 },
    );

    const changed = await harness.runtime.reconcileWorkerProcess(
      harness.bindingRegistry.getByAibotSessionID(sessionID),
    );
    assert.equal(changed, true);
    assert.equal(harness.bindingRegistry.getByAibotSessionID(sessionID)?.worker_status, "stopped");
    assert.equal(harness.getSpawnCalls(), 1);

    await harness.runtime.handleEvent({
      event_id: "evt-e2e-auth-fail-user-msg",
      session_id: sessionID,
      msg_id: "msg-e2e-auth-fail-user-msg",
      sender_id: "sender-e2e-auth-fail",
      content: "hello after auth failure",
    });

    assert.equal(harness.getSpawnCalls(), 1);
    assert.equal(
      harness.sent.some(
        (item) => item.kind === "event_result"
          && item.payload?.event_id === "evt-e2e-auth-fail-user-msg"
          && item.payload?.code === "claude_auth_login_required",
      ),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});

test("e2e: stale stopped status from old claude session is ignored", async () => {
  const harness = await createHarness();
  const sessionID = "chat-e2e-stale-status";
  try {
    await openSession(harness.runtime, sessionID, harness.workspaceDir, 1);
    const firstReady = await waitForReadyBinding(harness.bindingRegistry, sessionID);
    assert.ok(firstReady);
    const oldClaudeSessionID = String(firstReady.claude_session_id);

    await harness.runtime.rotateClaudeSession(firstReady);
    const stopped = await harness.bindingRegistry.markWorkerStopped(sessionID, {
      updatedAt: Date.now(),
      lastStoppedAt: Date.now(),
    });
    await harness.runtime.ensureWorker(stopped);
    const secondReady = await waitForReadyBinding(harness.bindingRegistry, sessionID, 8000);
    assert.ok(secondReady);
    assert.notEqual(String(secondReady.claude_session_id), oldClaudeSessionID);

    await postBridgeStatus(harness.bridgeServer, {
      worker_id: secondReady.worker_id,
      aibot_session_id: sessionID,
      claude_session_id: oldClaudeSessionID,
      pid: secondReady.worker_pid,
      status: "stopped",
    });
    await sleep(100);

    const current = harness.bindingRegistry.getByAibotSessionID(sessionID);
    assert.equal(current?.worker_status, "ready");
    assert.equal(String(current?.claude_session_id), String(secondReady.claude_session_id));
  } finally {
    await harness.cleanup();
  }
});
