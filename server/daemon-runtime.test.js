import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { BindingRegistry } from "./daemon/binding-registry.js";
import { DaemonRuntime } from "./daemon/runtime.js";

function makeAibotClient(sent) {
  return {
    ackEvent(eventID, payload) {
      sent.push({ kind: "ack", eventID, payload });
    },
    async sendText(payload) {
      sent.push({ kind: "text", payload });
      return { msg_id: "1" };
    },
  };
}

function makeWorkerProcessManager(calls) {
  const runtimes = new Map();
  return {
    getWorkerRuntime(workerID) {
      return runtimes.get(workerID) ?? null;
    },
    async spawnWorker(input) {
      const runtime = {
        worker_id: input.workerID,
        status: "starting",
      };
      runtimes.set(input.workerID, runtime);
      calls.push({ kind: "spawn", input });
      return runtime;
    },
    async stopWorker(workerID) {
      calls.push({ kind: "stop", workerID });
      const runtime = runtimes.get(workerID);
      if (runtime) {
        runtime.status = "stopped";
      }
      return true;
    },
  };
}

test("daemon runtime open creates a fixed binding and spawns worker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
  });

  await runtime.handleEvent({
    event_id: "evt-1",
    session_id: "chat-1",
    msg_id: "msg-1",
    content: `open ${tempDir}`,
  });

  const binding = registry.getByAibotSessionID("chat-1");
  assert.ok(binding);
  assert.equal(binding.cwd, tempDir);
  assert.equal(workerCalls.length, 1);
  assert.equal(sent.filter((item) => item.kind === "ack").length, 1);
  assert.match(sent.find((item) => item.kind === "text").payload.text, /已新建目录会话/u);
});

test("daemon runtime rejects rebinding an existing aibot session to another cwd", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const otherDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-2",
    claude_session_id: "claude-2",
    cwd: tempDir,
    worker_id: "worker-2",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
  });

  await runtime.handleEvent({
    event_id: "evt-2",
    session_id: "chat-2",
    msg_id: "msg-2",
    content: `open ${otherDir}`,
  });

  assert.equal(workerCalls.length, 0);
  assert.match(sent.find((item) => item.kind === "text").payload.text, /不能改成新目录/u);
});

test("daemon runtime stop marks binding stopped", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-3",
    claude_session_id: "claude-3",
    cwd: tempDir,
    worker_id: "worker-3",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
  });

  await runtime.handleEvent({
    event_id: "evt-3",
    session_id: "chat-3",
    msg_id: "msg-3",
    content: "stop",
  });

  const binding = registry.getByAibotSessionID("chat-3");
  assert.equal(binding.worker_status, "stopped");
  assert.deepEqual(workerCalls, [{ kind: "stop", workerID: "worker-3" }]);
});

test("daemon runtime delivers normal message to ready worker control", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4",
    claude_session_id: "claude-4",
    cwd: tempDir,
    worker_id: "worker-4",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9999",
    worker_control_token: "token-4",
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent(payload) {
          delivered.push(payload);
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleEvent({
    event_id: "evt-4",
    session_id: "chat-4",
    msg_id: "msg-4",
    sender_id: "sender-4",
    content: "hello worker",
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-4");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime forwards stop and revoke to ready worker control", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const deliveredStops = [];
  const deliveredRevokes = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-5",
    claude_session_id: "claude-5",
    cwd: tempDir,
    worker_id: "worker-5",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9998",
    worker_control_token: "token-5",
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent() {
          return { ok: true };
        },
        async deliverStop(payload) {
          deliveredStops.push(payload);
          return { ok: true };
        },
        async deliverRevoke(payload) {
          deliveredRevokes.push(payload);
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleStopEvent({
    event_id: "evt-stop-5",
    session_id: "chat-5",
    stop_id: "stop-5",
  });
  await runtime.handleRevokeEvent({
    event_id: "evt-revoke-5",
    session_id: "chat-5",
    msg_id: "msg-5",
  });

  assert.deepEqual(deliveredStops, [
    {
      event_id: "evt-stop-5",
      session_id: "chat-5",
      stop_id: "stop-5",
    },
  ]);
  assert.deepEqual(deliveredRevokes, [
    {
      event_id: "evt-revoke-5",
      session_id: "chat-5",
      msg_id: "msg-5",
    },
  ]);
});

test("daemon runtime recovers stale worker control before forwarding stop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const deliveredStops = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-6",
    claude_session_id: "claude-6",
    cwd: tempDir,
    worker_id: "worker-6",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9997",
    worker_control_token: "token-6",
  });

  const workerProcessManager = {
    getWorkerRuntime() {
      return null;
    },
    async spawnWorker(input) {
      workerCalls.push({ kind: "spawn", input });
      await registry.markWorkerReady(input.aibotSessionID, {
        workerID: input.workerID,
        workerControlURL: "http://127.0.0.1:9996",
        workerControlToken: "token-6b",
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      return {
        worker_id: input.workerID,
        status: "starting",
      };
    },
    async stopWorker() {
      return true;
    },
  };

  let attempts = 0;
  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager,
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    workerControlClientFactory(binding) {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent() {
          return { ok: true };
        },
        async deliverStop(payload) {
          attempts += 1;
          if (attempts === 1) {
            await registry.markWorkerReady(binding.aibot_session_id, {
              workerID: binding.worker_id,
              workerControlURL: "http://127.0.0.1:9996",
              workerControlToken: "token-6b",
              updatedAt: Date.now(),
              lastStartedAt: Date.now(),
            });
            throw new Error("stale control");
          }
          deliveredStops.push(payload);
          return { ok: true };
        },
        async deliverRevoke() {
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleStopEvent({
    event_id: "evt-stop-6",
    session_id: "chat-6",
    stop_id: "stop-6",
  });

  assert.equal(attempts, 2);
  assert.equal(workerCalls.length, 1);
  assert.deepEqual(deliveredStops, [
    {
      event_id: "evt-stop-6",
      session_id: "chat-6",
      stop_id: "stop-6",
    },
  ]);
});

test("daemon runtime can forward stop and revoke by remembered event route", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const deliveredStops = [];
  const deliveredRevokes = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-7",
    claude_session_id: "claude-7",
    cwd: tempDir,
    worker_id: "worker-7",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9995",
    worker_control_token: "token-7",
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent() {
          return { ok: true };
        },
        async deliverStop(payload) {
          deliveredStops.push(payload);
          return { ok: true };
        },
        async deliverRevoke(payload) {
          deliveredRevokes.push(payload);
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleEvent({
    event_id: "evt-7",
    session_id: "chat-7",
    msg_id: "msg-7",
    sender_id: "sender-7",
    content: "hello remembered route",
  });
  await runtime.handleStopEvent({
    event_id: "evt-7",
    stop_id: "stop-7",
  });
  await runtime.handleRevokeEvent({
    event_id: "evt-7",
    msg_id: "msg-7",
  });

  assert.deepEqual(deliveredStops, [
    {
      event_id: "evt-7",
      stop_id: "stop-7",
    },
  ]);
  assert.deepEqual(deliveredRevokes, [
    {
      event_id: "evt-7",
      msg_id: "msg-7",
    },
  ]);
});
