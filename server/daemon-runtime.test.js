import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { BindingRegistry } from "./daemon/binding-registry.js";
import { MessageDeliveryStore } from "./daemon/message-delivery-store.js";
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
    markWorkerRuntimeStopped(workerID, { exitCode = 0, exitSignal = "" } = {}) {
      const runtime = runtimes.get(workerID);
      if (!runtime) {
        return null;
      }
      runtime.status = "stopped";
      runtime.exit_code = exitCode;
      runtime.exit_signal = exitSignal;
      calls.push({ kind: "mark_stopped", workerID, exitCode, exitSignal });
      return { ...runtime };
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

function assertRespondedEventResult(sent, eventID) {
  assert.deepEqual(
    sent.find((item) => item.kind === "event_result" && item.payload.event_id === eventID)?.payload,
    {
      event_id: eventID,
      status: "responded",
    },
  );
}

function assertOpenWorkspaceCard(payload, {
  summaryText,
  detailText,
} = {}) {
  assert.equal(payload.text, summaryText);
  assert.deepEqual(payload.extra?.biz_card, {
    version: 1,
    type: "claude_open_session",
    payload: {
      summary_text: summaryText,
      detail_text: detailText,
      command_prefix: "/clawpool open",
      command_hint: "/clawpool open <working-directory>",
      initial_cwd: "",
    },
  });
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertUUID(value) {
  assert.match(String(value ?? ""), uuidPattern);
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
  assertRespondedEventResult(sent, "evt-1");
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
    async claudeSessionExists() {
      return true;
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
  assertRespondedEventResult(sent, "evt-3");
});

test("daemon runtime missing binding replies without leaving the event pending", async () => {
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
    event_id: "evt-missing",
    session_id: "chat-missing",
    msg_id: "msg-missing",
    content: "1",
  });

  assert.equal(workerCalls.length, 0);
  assertOpenWorkspaceCard(sent.find((item) => item.kind === "text")?.payload, {
    summaryText: "当前会话还没有绑定目录。",
    detailText: "发送 open <目录> 来创建会话。",
  });
  assertRespondedEventResult(sent, "evt-missing");
});

test("daemon runtime missing binding control commands send only the open workspace card", async () => {
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

  for (const content of ["status", "where", "stop"]) {
    await runtime.handleEvent({
      event_id: `evt-${content}`,
      session_id: `chat-${content}`,
      msg_id: `msg-${content}`,
      content,
    });
  }

  assert.equal(workerCalls.length, 0);
  const textReplies = sent.filter((item) => item.kind === "text");
  assert.equal(textReplies.length, 3);
  for (const reply of textReplies) {
    assertOpenWorkspaceCard(reply.payload, {
      summaryText: "当前会话还没有绑定目录。",
      detailText: "发送 open <目录> 来创建会话。",
    });
  }
  for (const eventID of ["evt-status", "evt-where", "evt-stop"]) {
    assertRespondedEventResult(sent, eventID);
  }
});

test("daemon runtime invalid control command replies without timing out", async () => {
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
    event_id: "evt-invalid",
    session_id: "chat-invalid",
    msg_id: "msg-invalid",
    content: "open",
  });

  assert.equal(workerCalls.length, 0);
  assertOpenWorkspaceCard(sent.find((item) => item.kind === "text")?.payload, {
    summaryText: "open 缺少目录路径。",
    detailText: "请输入工作目录来启动或恢复 Claude 会话。",
  });
  assertRespondedEventResult(sent, "evt-invalid");
});

test("daemon runtime open command with missing directory replies with open workspace card", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const missingDir = path.join(tempDir, "missing-dir");
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
    event_id: "evt-open-missing-dir",
    session_id: "chat-open-missing-dir",
    msg_id: "msg-open-missing-dir",
    content: `/clawpool open ${missingDir}`,
  });

  assert.equal(workerCalls.length, 0);
  assertOpenWorkspaceCard(sent.find((item) => item.kind === "text")?.payload, {
    summaryText: "指定路径不存在。",
    detailText: "发送 open <目录> 来创建会话。",
  });
  assertRespondedEventResult(sent, "evt-open-missing-dir");
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
    async claudeSessionExists() {
      return true;
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

test("daemon runtime queues a second session event until the first one completes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-serial",
    claude_session_id: "claude-serial",
    cwd: tempDir,
    worker_id: "worker-serial",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9998",
    worker_control_token: "token-serial",
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
    event_id: "evt-serial-1",
    session_id: "chat-serial",
    msg_id: "msg-serial-1",
    sender_id: "sender-serial",
    content: "first",
  });
  await runtime.handleEvent({
    event_id: "evt-serial-2",
    session_id: "chat-serial",
    msg_id: "msg-serial-2",
    sender_id: "sender-serial",
    content: "second",
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-serial-1");
  assert.equal(runtime.getPendingEvent("evt-serial-2")?.delivery_state, "pending");

  await runtime.handleEventCompleted("evt-serial-1");

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].event_id, "evt-serial-2");
  assert.equal(runtime.getPendingEvent("evt-serial-2")?.delivery_state, "delivered");
});

test("daemon runtime does not flush a queued event while another session event is still in flight", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  const binding = await registry.createBinding({
    aibot_session_id: "chat-serial-ready",
    claude_session_id: "claude-serial-ready",
    cwd: tempDir,
    worker_id: "worker-serial-ready",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9997",
    worker_control_token: "token-serial-ready",
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

  await runtime.trackPendingEvent({
    event_id: "evt-serial-ready-1",
    session_id: "chat-serial-ready",
    msg_id: "msg-serial-ready-1",
    sender_id: "sender-serial-ready",
    content: "first",
  });
  await runtime.markPendingEventDelivered("evt-serial-ready-1", binding);
  await runtime.trackPendingEvent({
    event_id: "evt-serial-ready-2",
    session_id: "chat-serial-ready",
    msg_id: "msg-serial-ready-2",
    sender_id: "sender-serial-ready",
    content: "second",
  });

  await runtime.handleWorkerStatusUpdate(binding, {
    ...binding,
    worker_status: "ready",
  });

  assert.equal(delivered.length, 0);

  await runtime.handleEventCompleted("evt-serial-ready-1");

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-serial-ready-2");
});

test("daemon runtime can release queued events when delivered in-flight blocking is disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-serial-free",
    claude_session_id: "claude-serial-free",
    cwd: tempDir,
    worker_id: "worker-serial-free",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:99971",
    worker_control_token: "token-serial-free",
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
    deliveredInFlightMaxAgeMs: 0,
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
    event_id: "evt-serial-free-1",
    session_id: "chat-serial-free",
    msg_id: "msg-serial-free-1",
    sender_id: "sender-serial-free",
    content: "first",
  });
  await runtime.handleEvent({
    event_id: "evt-serial-free-2",
    session_id: "chat-serial-free",
    msg_id: "msg-serial-free-2",
    sender_id: "sender-serial-free",
    content: "second",
  });

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].event_id, "evt-serial-free-1");
  assert.equal(delivered[1].event_id, "evt-serial-free-2");
  assert.equal(runtime.getPendingEvent("evt-serial-free-2")?.delivery_state, "delivered");
});

test("daemon runtime retries one time when flushing a queued event fails transiently", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  let attempts = 0;
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  const binding = await registry.createBinding({
    aibot_session_id: "chat-flush-retry",
    claude_session_id: "claude-flush-retry",
    cwd: tempDir,
    worker_id: "worker-flush-retry",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:99972",
    worker_control_token: "token-flush-retry",
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
          attempts += 1;
          if (payload.event_id === "evt-flush-retry-2" && attempts === 1) {
            throw new Error("transient delivery failure");
          }
          delivered.push(payload);
          return { ok: true };
        },
      };
    },
  });

  await runtime.trackPendingEvent({
    event_id: "evt-flush-retry-1",
    session_id: "chat-flush-retry",
    msg_id: "msg-flush-retry-1",
    sender_id: "sender-flush-retry",
    content: "first",
  });
  await runtime.markPendingEventDelivered("evt-flush-retry-1", binding);
  await runtime.trackPendingEvent({
    event_id: "evt-flush-retry-2",
    session_id: "chat-flush-retry",
    msg_id: "msg-flush-retry-2",
    sender_id: "sender-flush-retry",
    content: "second",
  });

  await runtime.handleEventCompleted("evt-flush-retry-1");

  assert.equal(attempts, 2);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-flush-retry-2");
  assert.equal(runtime.getPendingEvent("evt-flush-retry-2")?.delivery_state, "delivered");
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
    async claudeSessionExists() {
      return true;
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
    async claudeSessionExists() {
      return true;
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
  runtime.waitForWorkerBridgeState = async () => {
    await registry.markWorkerReady("chat-4d", {
      workerID: "worker-4d",
      workerControlURL: "http://127.0.0.1:9992",
      workerControlToken: "token-4d",
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    return registry.getByAibotSessionID("chat-4d");
  };

  await runtime.handleEvent({
    event_id: "evt-4d",
    session_id: "chat-4d",
    msg_id: "msg-4d",
    sender_id: "sender-4d",
    content: "send on connected bridge",
  });

  assert.equal(workerCalls.length, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-4d");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime stays silent while worker is not ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d-starting",
    claude_session_id: "claude-4d-starting",
    cwd: tempDir,
    worker_id: "worker-4d-starting",
    worker_status: "starting",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: {
      ...makeWorkerProcessManager(workerCalls),
      getWorkerRuntime() {
        return {
          worker_id: "worker-4d-starting",
          pid: 123,
          status: "starting",
        };
      },
    },
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    isProcessRunning() {
      return true;
    },
  });
  runtime.waitForWorkerBridgeState = async () => registry.getByAibotSessionID("chat-4d-starting");

  await runtime.handleEvent({
    event_id: "evt-4d-starting",
    session_id: "chat-4d-starting",
    msg_id: "msg-4d-starting",
    sender_id: "sender-4d-starting",
    content: "hello",
  });

  assert.equal(workerCalls.length, 0);
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime avoids redelivering the first event when ready recovery already flushed it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d-race",
    claude_session_id: "claude-4d-race",
    cwd: tempDir,
    worker_id: "worker-4d-race",
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

  let readyHandled = false;
  runtime.waitForWorkerBridgeState = async () => {
    if (!readyHandled) {
      readyHandled = true;
      const previousBinding = registry.getByAibotSessionID("chat-4d-race");
      const nextBinding = await registry.markWorkerReady("chat-4d-race", {
        workerID: "worker-4d-race",
        workerControlURL: "http://127.0.0.1:9995",
        workerControlToken: "token-4d-race",
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      await runtime.handleWorkerStatusUpdate(previousBinding, nextBinding);
      return nextBinding;
    }
    return registry.getByAibotSessionID("chat-4d-race");
  };

  await runtime.handleEvent({
    event_id: "evt-4d-race",
    session_id: "chat-4d-race",
    msg_id: "msg-4d-race",
    sender_id: "sender-4d-race",
    content: "aaa",
  });

  assert.equal(workerCalls.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event_id, "evt-4d-race");
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
    async claudeSessionExists() {
      return true;
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
  runtime.waitForWorkerBridgeState = async () => registry.getByAibotSessionID("chat-4d2");

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

test("daemon runtime falls back to a fresh Claude session when resume target is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d3",
    claude_session_id: "claude-4d3",
    cwd: tempDir,
    worker_id: "worker-4d3",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  let missingResume = false;
  const workerProcessManager = {
    getWorkerRuntime() {
      return null;
    },
    async spawnWorker(input) {
      workerCalls.push({ kind: "spawn", input });
      if (input.resumeSession) {
        missingResume = true;
        await registry.markWorkerConnected(input.aibotSessionID, {
          workerID: input.workerID,
          workerControlURL: "http://127.0.0.1:99921",
          workerControlToken: "token-missing-resume",
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      } else {
        missingResume = false;
        await registry.markWorkerReady(input.aibotSessionID, {
          workerID: input.workerID,
          workerControlURL: "http://127.0.0.1:99922",
          workerControlToken: "token-4d3",
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      }
      return {
        worker_id: input.workerID,
        status: "starting",
      };
    },
    async stopWorker() {
      return true;
    },
    async hasMissingResumeSessionError() {
      return missingResume;
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
    async claudeSessionExists() {
      return true;
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
    event_id: "evt-4d3",
    session_id: "chat-4d3",
    msg_id: "msg-4d3",
    sender_id: "sender-4d3",
    content: "recover missing resume session",
  });

  assert.equal(workerCalls.length, 2);
  assert.equal(workerCalls[0].input.resumeSession, true);
  assert.equal(workerCalls[1].input.resumeSession, false);
  assertUUID(workerCalls[1].input.claudeSessionID);
  assert.notEqual(workerCalls[1].input.claudeSessionID, "claude-4d3");
  assert.equal(
    registry.getByAibotSessionID("chat-4d3")?.claude_session_id,
    workerCalls[1].input.claudeSessionID,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.event_id, "evt-4d3");
  assert.equal(delivered[0].via, "http://127.0.0.1:99922");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
});

test("daemon runtime skips resume and starts fresh when Claude session file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const registry = new BindingRegistry(path.join(tempDir, "binding-registry.json"));
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-4d4",
    claude_session_id: "claude-4d4",
    cwd: tempDir,
    worker_id: "worker-4d4",
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
          workerControlURL: "http://127.0.0.1:99923",
          workerControlToken: "token-4d4",
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
    async claudeSessionExists() {
      return false;
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
    event_id: "evt-4d4",
    session_id: "chat-4d4",
    msg_id: "msg-4d4",
    sender_id: "sender-4d4",
    content: "start fresh when missing",
  });

  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].input.resumeSession, false);
  assertUUID(workerCalls[0].input.claudeSessionID);
  assert.notEqual(workerCalls[0].input.claudeSessionID, "claude-4d4");
  assert.equal(
    registry.getByAibotSessionID("chat-4d4")?.claude_session_id,
    workerCalls[0].input.claudeSessionID,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.event_id, "evt-4d4");
  assert.equal(delivered[0].via, "http://127.0.0.1:99923");
  assert.equal(sent.filter((item) => item.kind === "text").length, 0);
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

test("daemon runtime keeps remembered event routes across runtime restart", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const deliveredStops = [];
  const deliveredEvents = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const messageDeliveryStateFile = path.join(tempDir, "message-delivery-state.json");

  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-7b",
    claude_session_id: "claude-7b",
    cwd: tempDir,
    worker_id: "worker-7b",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9995",
    worker_control_token: "token-7b",
  });

  const firstStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await firstStore.load();
  const firstRuntime = new DaemonRuntime({
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
    messageDeliveryStore: firstStore,
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent(payload) {
          deliveredEvents.push(payload);
          return { ok: true };
        },
        async deliverStop(payload) {
          deliveredStops.push(payload);
          return { ok: true };
        },
        async deliverRevoke() {
          return { ok: true };
        },
      };
    },
  });

  await firstRuntime.handleEvent({
    event_id: "evt-7b",
    session_id: "chat-7b",
    msg_id: "msg-7b",
    sender_id: "sender-7b",
    content: "remember route after restart",
  });

  const restartedRegistry = new BindingRegistry(bindingFile);
  await restartedRegistry.load();
  const restartedStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await restartedStore.load();
  const restartedRuntime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: restartedRegistry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    messageDeliveryStore: restartedStore,
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async deliverEvent(payload) {
          deliveredEvents.push(payload);
          return { ok: true };
        },
        async deliverStop(payload) {
          deliveredStops.push(payload);
          return { ok: true };
        },
        async deliverRevoke() {
          return { ok: true };
        },
      };
    },
  });

  await restartedRuntime.handleStopEvent({
    event_id: "evt-7b",
    stop_id: "stop-7b",
  });

  assert.equal(deliveredEvents.length, 1);
  assert.deepEqual(deliveredStops, [
    {
      event_id: "evt-7b",
      stop_id: "stop-7b",
    },
  ]);
});

test("daemon runtime keeps pending events across runtime restart and flushes after worker is ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const delivered = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const messageDeliveryStateFile = path.join(tempDir, "message-delivery-state.json");

  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-7c",
    claude_session_id: "claude-7c",
    cwd: tempDir,
    worker_id: "worker-7c",
    worker_status: "stopped",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const firstStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await firstStore.load();
  const firstRuntime = new DaemonRuntime({
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
    messageDeliveryStore: firstStore,
    async claudeSessionExists() {
      return true;
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
  firstRuntime.waitForWorkerBridgeState = async () => registry.getByAibotSessionID("chat-7c");

  await firstRuntime.handleEvent({
    event_id: "evt-7c",
    session_id: "chat-7c",
    msg_id: "msg-7c",
    sender_id: "sender-7c",
    content: "keep pending across restart",
  });

  assert.equal(delivered.length, 0);

  const restartedRegistry = new BindingRegistry(bindingFile);
  await restartedRegistry.load();
  const restartedStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await restartedStore.load();
  const restartedRuntime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: restartedRegistry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(sent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    messageDeliveryStore: restartedStore,
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

  const previousBinding = restartedRegistry.getByAibotSessionID("chat-7c");
  const readyBinding = await restartedRegistry.markWorkerReady("chat-7c", {
    workerID: "worker-7c",
    workerControlURL: "http://127.0.0.1:99951",
    workerControlToken: "token-7c",
    updatedAt: Date.now(),
    lastStartedAt: Date.now(),
  });
  await restartedRuntime.handleWorkerStatusUpdate(previousBinding, readyBinding);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.event_id, "evt-7c");
  assert.equal(delivered[0].via, "http://127.0.0.1:99951");
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

test("daemon runtime fails persisted in-flight events after restart recovery", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const firstSent = [];
  const secondSent = [];
  const workerCalls = [];
  const delivered = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const messageDeliveryStateFile = path.join(tempDir, "message-delivery-state.json");

  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-8b",
    claude_session_id: "claude-8b",
    cwd: tempDir,
    worker_id: "worker-8b",
    worker_status: "ready",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
    worker_control_url: "http://127.0.0.1:9987",
    worker_control_token: "token-8b",
  });

  const firstStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await firstStore.load();
  const firstRuntime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(firstSent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    messageDeliveryStore: firstStore,
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

  await firstRuntime.handleEvent({
    event_id: "evt-8b",
    session_id: "chat-8b",
    msg_id: "msg-8b",
    sender_id: "sender-8b",
    content: "restart while in flight",
  });

  const restartedRegistry = new BindingRegistry(bindingFile);
  await restartedRegistry.load();
  await restartedRegistry.resetTransientWorkerStates();
  const restartedStore = new MessageDeliveryStore(messageDeliveryStateFile);
  await restartedStore.load();
  const restartedRuntime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: restartedRegistry,
    workerProcessManager: makeWorkerProcessManager(workerCalls),
    aibotClient: makeAibotClient(secondSent),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    messageDeliveryStore: restartedStore,
  });

  await restartedRuntime.recoverPersistedDeliveryState();

  assert.equal(delivered.length, 1);
  assert.equal(
    secondSent.some((item) => item.kind === "text" && /没有处理完成/u.test(item.payload.text)),
    false,
  );
  assert.deepEqual(
    secondSent.find((item) => item.kind === "event_result")?.payload,
    {
      event_id: "evt-8b",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
  assert.equal(restartedStore.getPendingEvent("evt-8b"), null);
  assert.equal(restartedStore.getRememberedSessionID("evt-8b"), "");
});

test("daemon runtime reconciles an exited worker and fails delivered pending events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-exit",
    claude_session_id: "claude-exit",
    cwd: tempDir,
    worker_id: "worker-exit",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-exit",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-exit",
    session_id: "chat-exit",
    msg_id: "msg-exit",
    sender_id: "sender-exit",
    content: "26",
  });
  await deliveryStore.markPendingEventDelivered("evt-exit", "worker-exit");

  const workerProcessManager = makeWorkerProcessManager(workerCalls);
  workerProcessManager.getWorkerRuntime = () => ({
    worker_id: "worker-exit",
    aibot_session_id: "chat-exit",
    pid: 43210,
    status: "ready",
  });

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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    isProcessRunning() {
      return false;
    },
  });

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-exit"),
  );

  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-exit")?.worker_status, "stopped");
  assert.equal(deliveryStore.getPendingEvent("evt-exit"), null);
  assert.equal(
    sent.some(
      (item) =>
        item.kind === "text"
        && item.payload.eventID === "evt-exit"
        && /没有处理完成/u.test(item.payload.text),
    ),
    true,
  );
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-exit",
    )?.payload,
    {
      event_id: "evt-exit",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});

test("daemon runtime marks worker stopped after repeated worker control probe failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-probe",
    claude_session_id: "claude-probe",
    cwd: tempDir,
    worker_id: "worker-probe",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-probe",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-probe",
    session_id: "chat-probe",
    msg_id: "msg-probe",
    sender_id: "sender-probe",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered("evt-probe", "worker-probe");

  let pingCount = 0;
  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-probe",
        aibot_session_id: "chat-probe",
        pid: 50001,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 2,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          pingCount += 1;
          throw new Error("connection refused");
        },
      };
    },
  });

  const unchanged = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-probe"),
  );
  assert.equal(unchanged, false);
  assert.equal(registry.getByAibotSessionID("chat-probe")?.worker_status, "ready");

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-probe"),
  );
  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-probe")?.worker_status, "stopped");
  assert.equal(pingCount, 2);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "worker_control_unreachable");
  assert.equal(deliveryStore.getPendingEvent("evt-probe"), null);
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-probe",
    )?.payload,
    {
      event_id: "evt-probe",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});

test("daemon runtime returns auth login required message when worker logs show 401", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-probe-auth",
    claude_session_id: "claude-probe-auth",
    cwd: tempDir,
    worker_id: "worker-probe-auth",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-probe-auth",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-probe-auth",
    session_id: "chat-probe-auth",
    msg_id: "msg-probe-auth",
    sender_id: "sender-probe-auth",
    content: "probe auth",
  });
  await deliveryStore.markPendingEventDelivered("evt-probe-auth", "worker-probe-auth");

  let pingCount = 0;
  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-probe-auth",
        aibot_session_id: "chat-probe-auth",
        pid: 50010,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
    },
    async hasAuthLoginRequiredError(workerID) {
      assert.equal(workerID, "worker-probe-auth");
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 2,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          pingCount += 1;
          throw new Error("connection refused");
        },
      };
    },
  });

  const unchanged = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-probe-auth"),
  );
  assert.equal(unchanged, false);
  assert.equal(registry.getByAibotSessionID("chat-probe-auth")?.worker_status, "ready");

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-probe-auth"),
  );
  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-probe-auth")?.worker_status, "stopped");
  assert.equal(pingCount, 2);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "worker_control_unreachable");
  assert.equal(deliveryStore.getPendingEvent("evt-probe-auth"), null);
  assert.equal(
    sent.some(
      (item) =>
        item.kind === "text"
        && item.payload.eventID === "evt-probe-auth"
        && /claude auth login/iu.test(item.payload.text),
    ),
    true,
  );
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-probe-auth",
    )?.payload,
    {
      event_id: "evt-probe-auth",
      status: "failed",
      code: "claude_auth_login_required",
      msg: "claude authentication expired; run claude auth login",
    },
  );
});

test("daemon runtime marks worker stopped when worker control ping pid mismatches runtime pid", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-pid-mismatch",
    claude_session_id: "claude-pid-mismatch",
    cwd: tempDir,
    worker_id: "worker-pid-mismatch",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-pid-mismatch",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-pid-mismatch",
        aibot_session_id: "chat-pid-mismatch",
        pid: 50011,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
    },
  };

  const runtime = new DaemonRuntime({
    env: { HOME: os.homedir() },
    bindingRegistry: registry,
    workerProcessManager,
    aibotClient: makeAibotClient([]),
    bridgeServer: {
      token: "bridge-token",
      getURL() {
        return "http://127.0.0.1:9000";
      },
    },
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 1,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-pid-mismatch",
            aibot_session_id: "chat-pid-mismatch",
            claude_session_id: "claude-pid-mismatch",
            pid: 99999,
            mcp_ready: true,
            mcp_last_activity_at: Date.now(),
          };
        },
      };
    },
  });

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-pid-mismatch"),
  );

  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-pid-mismatch")?.worker_status, "stopped");
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "worker_control_unreachable");
});

test("daemon runtime gives in-flight MCP activity a grace window before declaring stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-stale",
    claude_session_id: "claude-mcp-stale",
    cwd: tempDir,
    worker_id: "worker-mcp-stale",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-stale",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-stale",
    session_id: "chat-mcp-stale",
    msg_id: "msg-mcp-stale",
    sender_id: "sender-mcp-stale",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered("evt-mcp-stale", "worker-mcp-stale");

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-stale",
        aibot_session_id: "chat-mcp-stale",
        pid: 50002,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 1,
    mcpInteractionIdleMs: 50,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-stale",
            aibot_session_id: "chat-mcp-stale",
            claude_session_id: "claude-mcp-stale",
            pid: 50002,
            mcp_ready: true,
            mcp_last_activity_at: Date.now() - (10 * 60 * 1000),
          };
        },
      };
    },
  });

  const unchanged = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-stale"),
  );
  assert.equal(unchanged, false);
  assert.equal(registry.getByAibotSessionID("chat-mcp-stale")?.worker_status, "ready");

  await sleep(80);

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-stale"),
  );

  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-mcp-stale")?.worker_status, "stopped");
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "worker_control_unreachable");
  assert.equal(deliveryStore.getPendingEvent("evt-mcp-stale"), null);
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-mcp-stale",
    )?.payload,
    {
      event_id: "evt-mcp-stale",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});

test("daemon runtime marks worker stopped when MCP result timeout is reached", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-result-timeout",
    claude_session_id: "claude-mcp-result-timeout",
    cwd: tempDir,
    worker_id: "worker-mcp-result-timeout",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-result-timeout",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-result-timeout",
    session_id: "chat-mcp-result-timeout",
    msg_id: "msg-mcp-result-timeout",
    sender_id: "sender-mcp-result-timeout",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered("evt-mcp-result-timeout", "worker-mcp-result-timeout");
  await sleep(10);

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-result-timeout",
        aibot_session_id: "chat-mcp-result-timeout",
        pid: 50003,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 1,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-result-timeout",
            aibot_session_id: "chat-mcp-result-timeout",
            claude_session_id: "claude-mcp-result-timeout",
            pid: 50003,
            mcp_ready: true,
            mcp_last_activity_at: 0,
          };
        },
      };
    },
  });

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-result-timeout"),
  );

  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-mcp-result-timeout")?.worker_status, "stopped");
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "mcp_result_timeout");
  assert.equal(deliveryStore.getPendingEvent("evt-mcp-result-timeout"), null);
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-mcp-result-timeout",
    )?.payload,
    {
      event_id: "evt-mcp-result-timeout",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});

test("daemon runtime keeps worker alive when ping reports fresh MCP activity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-ping-fresh",
    claude_session_id: "claude-mcp-ping-fresh",
    cwd: tempDir,
    worker_id: "worker-mcp-ping-fresh",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-ping-fresh",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-ping-fresh",
    session_id: "chat-mcp-ping-fresh",
    msg_id: "msg-mcp-ping-fresh",
    sender_id: "sender-mcp-ping-fresh",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered("evt-mcp-ping-fresh", "worker-mcp-ping-fresh");
  await sleep(40);

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-ping-fresh",
        aibot_session_id: "chat-mcp-ping-fresh",
        pid: 50006,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 30,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-ping-fresh",
            aibot_session_id: "chat-mcp-ping-fresh",
            claude_session_id: "claude-mcp-ping-fresh",
            pid: 50006,
            mcp_ready: true,
            mcp_last_activity_at: Date.now(),
          };
        },
      };
    },
  });

  assert.equal(runtime.listTimedOutMcpResultRecords("chat-mcp-ping-fresh").length, 1);

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-ping-fresh"),
  );
  assert.equal(changed, false);
  assert.equal(registry.getByAibotSessionID("chat-mcp-ping-fresh")?.worker_status, "ready");
  assert.equal(workerCalls.length, 0);
  assert.notEqual(deliveryStore.getPendingEvent("evt-mcp-ping-fresh"), null);
});

test("daemon runtime does not force MCP timeout on transient worker control probe failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-probe-transient",
    claude_session_id: "claude-mcp-probe-transient",
    cwd: tempDir,
    worker_id: "worker-mcp-probe-transient",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-probe-transient",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-probe-transient",
    session_id: "chat-mcp-probe-transient",
    msg_id: "msg-mcp-probe-transient",
    sender_id: "sender-mcp-probe-transient",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered(
    "evt-mcp-probe-transient",
    "worker-mcp-probe-transient",
  );
  await sleep(20);

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-probe-transient",
        aibot_session_id: "chat-mcp-probe-transient",
        pid: 50007,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 1,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          throw new Error("temporary worker control blip");
        },
      };
    },
  });

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-probe-transient"),
  );
  assert.equal(changed, false);
  assert.equal(registry.getByAibotSessionID("chat-mcp-probe-transient")?.worker_status, "ready");
  assert.equal(workerCalls.length, 0);
  assert.notEqual(deliveryStore.getPendingEvent("evt-mcp-probe-transient"), null);
});

test("daemon runtime uses composing heartbeat to refresh MCP result timeout tracking", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-heartbeat",
    claude_session_id: "claude-mcp-heartbeat",
    cwd: tempDir,
    worker_id: "worker-mcp-heartbeat",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-heartbeat",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-heartbeat",
    session_id: "chat-mcp-heartbeat",
    msg_id: "msg-mcp-heartbeat",
    sender_id: "sender-mcp-heartbeat",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered("evt-mcp-heartbeat", "worker-mcp-heartbeat");
  await sleep(40);

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-heartbeat",
        aibot_session_id: "chat-mcp-heartbeat",
        pid: 50004,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 30,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-heartbeat",
            aibot_session_id: "chat-mcp-heartbeat",
            claude_session_id: "claude-mcp-heartbeat",
            pid: 50004,
            mcp_ready: true,
            mcp_last_activity_at: Date.now(),
          };
        },
      };
    },
  });

  assert.equal(runtime.listTimedOutMcpResultRecords("chat-mcp-heartbeat").length, 1);

  await runtime.handleWorkerSessionComposing({
    worker_id: "worker-mcp-heartbeat",
    aibot_session_id: "chat-mcp-heartbeat",
    session_id: "chat-mcp-heartbeat",
    claude_session_id: "claude-mcp-heartbeat",
    pid: 50004,
    ref_event_id: "evt-mcp-heartbeat",
    active: true,
  });

  assert.equal(runtime.listTimedOutMcpResultRecords("chat-mcp-heartbeat").length, 0);

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-heartbeat"),
  );
  assert.equal(changed, false);
  assert.equal(registry.getByAibotSessionID("chat-mcp-heartbeat")?.worker_status, "ready");
  assert.equal(workerCalls.length, 0);
  assert.notEqual(deliveryStore.getPendingEvent("evt-mcp-heartbeat"), null);
});

test("daemon runtime rejects composing heartbeat with mismatched worker identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-heartbeat-reject",
    claude_session_id: "claude-mcp-heartbeat-reject",
    cwd: tempDir,
    worker_id: "worker-mcp-heartbeat-reject",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-heartbeat-reject",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-heartbeat-reject",
    session_id: "chat-mcp-heartbeat-reject",
    msg_id: "msg-mcp-heartbeat-reject",
    sender_id: "sender-mcp-heartbeat-reject",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered(
    "evt-mcp-heartbeat-reject",
    "worker-mcp-heartbeat-reject",
  );
  await sleep(40);

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-heartbeat-reject",
        aibot_session_id: "chat-mcp-heartbeat-reject",
        pid: 50005,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 30,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-heartbeat-reject",
            aibot_session_id: "chat-mcp-heartbeat-reject",
            claude_session_id: "claude-mcp-heartbeat-reject",
            pid: 50005,
            mcp_ready: true,
            mcp_last_activity_at: 0,
          };
        },
      };
    },
  });

  assert.equal(runtime.listTimedOutMcpResultRecords("chat-mcp-heartbeat-reject").length, 1);

  await runtime.handleWorkerSessionComposing({
    worker_id: "worker-not-owner",
    aibot_session_id: "chat-mcp-heartbeat-reject",
    session_id: "chat-mcp-heartbeat-reject",
    claude_session_id: "claude-mcp-heartbeat-reject",
    pid: 50005,
    ref_event_id: "evt-mcp-heartbeat-reject",
    active: true,
  });

  assert.equal(runtime.listTimedOutMcpResultRecords("chat-mcp-heartbeat-reject").length, 1);

  const changed = await runtime.reconcileWorkerProcess(
    registry.getByAibotSessionID("chat-mcp-heartbeat-reject"),
  );
  assert.equal(changed, true);
  assert.equal(registry.getByAibotSessionID("chat-mcp-heartbeat-reject")?.worker_status, "stopped");
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].exitSignal, "mcp_result_timeout");
});

test("daemon runtime rejects composing heartbeat with mismatched worker pid", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-mcp-heartbeat-pid",
    claude_session_id: "claude-mcp-heartbeat-pid",
    cwd: tempDir,
    worker_id: "worker-mcp-heartbeat-pid",
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-mcp-heartbeat-pid",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-mcp-heartbeat-pid",
    session_id: "chat-mcp-heartbeat-pid",
    msg_id: "msg-mcp-heartbeat-pid",
    sender_id: "sender-mcp-heartbeat-pid",
    content: "probe",
  });
  await deliveryStore.markPendingEventDelivered(
    "evt-mcp-heartbeat-pid",
    "worker-mcp-heartbeat-pid",
  );
  await sleep(40);
  const before = deliveryStore.getPendingEvent("evt-mcp-heartbeat-pid");

  const workerProcessManager = {
    getWorkerRuntime() {
      return {
        worker_id: "worker-mcp-heartbeat-pid",
        aibot_session_id: "chat-mcp-heartbeat-pid",
        pid: 50008,
        status: "ready",
      };
    },
    markWorkerRuntimeStopped(workerID, { exitSignal = "" } = {}) {
      workerCalls.push({ kind: "mark_stopped", workerID, exitSignal });
      return {
        worker_id: workerID,
        status: "stopped",
        exit_signal: exitSignal,
      };
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
    workerControlProbeFailureThreshold: 3,
    mcpInteractionIdleMs: 0,
    mcpResultTimeoutMs: 30,
    isProcessRunning() {
      return true;
    },
    workerControlClientFactory() {
      return {
        isConfigured() {
          return true;
        },
        async ping() {
          return {
            ok: true,
            worker_id: "worker-mcp-heartbeat-pid",
            aibot_session_id: "chat-mcp-heartbeat-pid",
            claude_session_id: "claude-mcp-heartbeat-pid",
            pid: 50008,
            mcp_ready: true,
            mcp_last_activity_at: 0,
          };
        },
      };
    },
  });

  await runtime.handleWorkerSessionComposing({
    worker_id: "worker-mcp-heartbeat-pid",
    aibot_session_id: "chat-mcp-heartbeat-pid",
    session_id: "chat-mcp-heartbeat-pid",
    claude_session_id: "claude-mcp-heartbeat-pid",
    pid: 50009,
    ref_event_id: "evt-mcp-heartbeat-pid",
    active: true,
  });

  const after = deliveryStore.getPendingEvent("evt-mcp-heartbeat-pid");
  assert.equal(after?.updated_at, before?.updated_at);
});

test("daemon runtime fails pending events when worker stops before becoming ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-runtime-"));
  const sent = [];
  const workerCalls = [];
  const bindingFile = path.join(tempDir, "binding-registry.json");
  const deliveryFile = path.join(tempDir, "message-delivery-state.json");
  const registry = new BindingRegistry(bindingFile);
  await registry.load();
  await registry.createBinding({
    aibot_session_id: "chat-start-fail",
    claude_session_id: "claude-start-fail",
    cwd: tempDir,
    worker_id: "worker-start-fail",
    worker_status: "starting",
    plugin_data_dir: path.join(tempDir, "plugin-data"),
  });

  const deliveryStore = new MessageDeliveryStore(deliveryFile);
  await deliveryStore.load();
  await deliveryStore.trackPendingEvent({
    event_id: "evt-start-fail",
    session_id: "chat-start-fail",
    msg_id: "msg-start-fail",
    sender_id: "sender-start-fail",
    content: "hello",
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
    messageDeliveryStore: deliveryStore,
    workerRuntimeHealthCheckMs: 0,
  });

  const previousBinding = registry.getByAibotSessionID("chat-start-fail");
  await runtime.handleWorkerStatusUpdate(previousBinding, {
    ...previousBinding,
    worker_status: "stopped",
  });

  assert.equal(deliveryStore.getPendingEvent("evt-start-fail"), null);
  assert.equal(
    sent.some(
      (item) =>
        item.kind === "text"
        && item.payload.eventID === "evt-start-fail"
        && /没有处理完成/u.test(item.payload.text),
    ),
    true,
  );
  assert.deepEqual(
    sent.find(
      (item) => item.kind === "event_result" && item.payload.event_id === "evt-start-fail",
    )?.payload,
    {
      event_id: "evt-start-fail",
      status: "failed",
      code: "worker_interrupted",
      msg: "worker interrupted while processing event",
    },
  );
});
