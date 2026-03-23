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
    sendEventResult(payload) {
      sent.push({ kind: "event_result", payload });
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

test("daemon runtime restores persisted binding and does not require open again", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const initialRegistry = new BindingRegistry(bindingFile);
  await initialRegistry.load();
  await initialRegistry.createBinding({
    aibot_session_id: "chat-1b",
    claude_session_id: "claude-1b",
    cwd: tempDir,
    worker_id: "worker-1b",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: {
      getWorkerRuntime() {
        return null;
      },
      async spawnWorker(input) {
        workerCalls.push({ kind: "spawn", input });
        await registry.markWorkerReady(input.aibotSessionID, {
          workerID: input.workerID,
          workerControlURL: "http://127.0.0.1:9991",
          workerControlToken: "token-1b",
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
    },
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
    event_id: "evt-1b",
    session_id: "chat-1b",
    msg_id: "msg-1b",
    sender_id: "sender-1b",
    content: "resume without open",
  });

  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].input.resumeSession, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-1b");
  assert.equal(
    sent.some((item) => item.kind === "text" && /先发送 open/u.test(item.payload.text)),
    false,
  );
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

test("daemon runtime resumes the bound Claude session when restarting a stopped worker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4b",
    claude_session_id: "claude-4b",
    cwd: tempDir,
    worker_id: "worker-4b",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: {
      getWorkerRuntime() {
        return null;
      },
      async spawnWorker(input) {
        workerCalls.push({ kind: "spawn", input });
        await registry.markWorkerReady(input.aibotSessionID, {
          workerID: input.workerID,
          workerControlURL: "http://127.0.0.1:9994",
          workerControlToken: "token-4b",
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
    },
    workerRestartDeliveryDelayMs: 0,
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
    event_id: "evt-4b",
    session_id: "chat-4b",
    msg_id: "msg-4b",
    sender_id: "sender-4b",
    content: "hello again",
  });

  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].input.resumeSession, true);
  assert.equal(workerCalls[0].input.claudeSessionID, "claude-4b");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-4b");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime respawns when binding is stopped even if local runtime is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4c",
    claude_session_id: "claude-4c",
    cwd: tempDir,
    worker_id: "worker-4c",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const workerProcessManager = makeWorkerProcessManager(workerCalls);
  workerProcessManager.getWorkerRuntime = () => ({
    worker_id: "worker-4c",
    status: "starting",
  });
  workerProcessManager.spawnWorker = async (input) => {
    workerCalls.push({ kind: "spawn", input });
    await registry.markWorkerReady(input.aibotSessionID, {
      workerID: input.workerID,
      workerControlURL: "http://127.0.0.1:9993",
      workerControlToken: "token-4c",
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    return {
      worker_id: input.workerID,
      status: "starting",
    };
  };

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager,
    workerRestartDeliveryDelayMs: 0,
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
    event_id: "evt-4c",
    session_id: "chat-4c",
    msg_id: "msg-4c",
    sender_id: "sender-4c",
    content: "wake up again",
  });

  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].input.resumeSession, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-4c");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime waits for ready before delivering to a connected worker bridge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d",
    claude_session_id: "claude-4d",
    cwd: tempDir,
    worker_id: "worker-4d",
    worker_status: "connected",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9992",
    worker_control_token: "token-4d",
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
    event_id: "evt-4d",
    session_id: "chat-4d",
    msg_id: "msg-4d",
    sender_id: "sender-4d",
    content: "send on connected bridge",
  });

  assert.equal(workerCalls.length, 0);
  assert.equal(delivered.length, 0);
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime flushes the first pending event after worker bridge becomes ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d2",
    claude_session_id: "claude-4d2",
    cwd: tempDir,
    worker_id: "worker-4d2",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: {
      getWorkerRuntime() {
        return null;
      },
      async spawnWorker(input) {
        workerCalls.push({ kind: "spawn", input });
        return {
          worker_id: input.workerID,
          status: "starting",
        };
      },
      async stopWorker() {
        return true;
      },
    },
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
        async deliverEvent(payload) {
          delivered.push({
            via: binding.worker_control_url,
            payload,
          });
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleEvent({
    event_id: "evt-4d2",
    session_id: "chat-4d2",
    msg_id: "msg-4d2",
    sender_id: "sender-4d2",
    content: "deliver after connect",
  });

  assert.equal(delivered.length, 0);
  assert.equal(workerCalls.length, 1);

  const previousBinding = registry.getByAibotSessionID("chat-4d2");
  const connectedBinding = await registry.markWorkerConnected("chat-4d2", {
    workerID: "worker-4d2",
    workerControlURL: "http://127.0.0.1:99921",
    workerControlToken: "token-4d2",
    updatedAt: Date.now(),
    lastStartedAt: Date.now(),
  });
  await runtime.handleWorkerStatusUpdate(previousBinding, connectedBinding);

  assert.equal(delivered.length, 0);

  const readyBinding = await registry.markWorkerReady("chat-4d2", {
    workerID: "worker-4d2",
    workerControlURL: "http://127.0.0.1:99921",
    workerControlToken: "token-4d2",
    updatedAt: Date.now(),
    lastStartedAt: Date.now(),
  });
  await runtime.handleWorkerStatusUpdate(connectedBinding, readyBinding);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.event_id, "evt-4d2");
  assert.equal(delivered[0].via, "http://127.0.0.1:99921");
});

test("daemon runtime delivers to a ready worker even when local runtime snapshot is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4e",
    claude_session_id: "claude-4e",
    cwd: tempDir,
    worker_id: "worker-4e",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9990",
    worker_control_token: "token-4e",
  });

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-4e",
        status: "stopped",
      };
    },
    async spawnWorker(input) {
      workerCalls.push({ kind: "spawn", input });
      await registry.markWorkerReady(input.aibotSessionID, {
        workerID: input.workerID,
        workerControlURL: "http://127.0.0.1:9989",
        workerControlToken: "token-4e-next",
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
        async deliverEvent(payload) {
          delivered.push({
            via: binding.worker_control_url,
            payload,
          });
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleEvent({
    event_id: "evt-4e",
    session_id: "chat-4e",
    msg_id: "msg-4e",
    sender_id: "sender-4e",
    content: "trust the bridge status",
  });

  assert.equal(workerCalls.length, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].via, "http://127.0.0.1:9990");
  assert.equal(delivered[0].payload.event_id, "evt-4e");
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
    workerRestartDeliveryDelayMs: 0,
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

test("daemon runtime fails an unfinished event when worker stops mid-processing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-8",
    claude_session_id: "claude-8",
    cwd: tempDir,
    worker_id: "worker-8",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9988",
    worker_control_token: "token-8",
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
    workerControlClientFactory(binding) {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent(payload) {
          delivered.push({
            via: binding.worker_control_url,
            payload,
          });
          return { ok: true };
        },
      };
    },
  });

  await runtime.handleEvent({
    event_id: "evt-8",
    session_id: "chat-8",
    msg_id: "msg-8",
    sender_id: "sender-8",
    content: "finish after restart",
  });

  const previousBinding = registry.getByAibotSessionID("chat-8");
  await runtime.handleWorkerStatusUpdate(previousBinding, {
    ...previousBinding,
    worker_status: "stopped",
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].via, "http://127.0.0.1:9988");
  assert.equal(
    sent.some((item) => item.kind === "text" && /没有处理完成/u.test(item.payload.text)),
    true,
  );
  assert.deepEqual(
    sent.find((item) => item.kind === "event_result")?.payload,
    {
      event_id: "evt-8",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});
