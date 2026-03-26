import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { BindingRegistry } from "./daemon/binding-registry.js";

test("binding registry creates and updates fixed bindings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-binding-registry-"));
  const registry = new BindingRegistry(path.join(dir, "binding-registry.json"));
  await registry.load();

  const created = await registry.createBinding({
    aibot_session_id: "chat-1",
    claude_session_id: "claude-1",
    cwd: "/repo/a",
    worker_id: "worker-1",
    worker_pid: 101,
    worker_status: "starting",
    plugin_data_dir: "/data/chat-1",
  });
  assert.equal(created.aibot_session_id, "chat-1");
  assert.equal(created.cwd, "/repo/a");
  assert.equal(created.worker_pid, 101);

  const ready = await registry.markWorkerReady("chat-1", {
    workerID: "worker-1",
    workerPid: 102,
    lastStartedAt: 10,
    updatedAt: 11,
  });
  assert.equal(ready.worker_status, "ready");
  assert.equal(ready.last_started_at, 10);
  assert.equal(ready.worker_pid, 102);

  const connected = await registry.markWorkerConnected("chat-1", {
    workerID: "worker-1",
    workerPid: 103,
    workerControlURL: "http://127.0.0.1:9000",
    workerControlToken: "token-1",
    lastStartedAt: 12,
    updatedAt: 13,
  });
  assert.equal(connected.worker_status, "connected");
  assert.equal(connected.worker_control_url, "http://127.0.0.1:9000");
  assert.equal(connected.worker_pid, 103);

  const hookObserved = await registry.markWorkerHookObserved("chat-1", {
    eventID: "hook-1",
    eventName: "PostToolUse",
    eventDetail: "Edit",
    eventAt: 14,
  });
  assert.equal(hookObserved.worker_last_hook_event_id, "hook-1");
  assert.equal(hookObserved.worker_last_hook_event_name, "PostToolUse");
  assert.equal(hookObserved.worker_last_hook_event_detail, "Edit");
  assert.equal(hookObserved.worker_last_hook_event_at, 14);

  const failed = await registry.markWorkerFailed("chat-1", {
    lastStoppedAt: 15,
    updatedAt: 16,
  });
  assert.equal(failed.worker_status, "failed");
  assert.equal(failed.last_stopped_at, 15);
  assert.equal(failed.worker_pid, 0);

  const loaded = new BindingRegistry(path.join(dir, "binding-registry.json"));
  await loaded.load();
  assert.deepEqual(loaded.getByAibotSessionID("chat-1"), failed);
});

test("binding registry rejects duplicate aibot session bindings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-binding-registry-"));
  const registry = new BindingRegistry(path.join(dir, "binding-registry.json"));
  await registry.load();

  await registry.createBinding({
    aibot_session_id: "chat-2",
    claude_session_id: "claude-2",
    cwd: "/repo/b",
    plugin_data_dir: "/data/chat-2",
  });

  await assert.rejects(
    () => registry.createBinding({
      aibot_session_id: "chat-2",
      claude_session_id: "claude-3",
      cwd: "/repo/c",
      plugin_data_dir: "/data/chat-3",
    }),
    /binding already exists/u,
  );
});

test("binding registry can rotate Claude session id for a fixed binding", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-binding-registry-"));
  const registry = new BindingRegistry(path.join(dir, "binding-registry.json"));
  await registry.load();

  await registry.createBinding({
    aibot_session_id: "chat-rotate",
    claude_session_id: "claude-old",
    cwd: "/repo/rotate",
    worker_id: "worker-rotate",
    worker_status: "stopped",
    plugin_data_dir: "/data/chat-rotate",
  });

  const rotated = await registry.updateClaudeSessionID("chat-rotate", {
    claudeSessionID: "claude-new",
    updatedAt: 101,
  });
  assert.equal(rotated.claude_session_id, "claude-new");
  assert.equal(rotated.aibot_session_id, "chat-rotate");
});

test("binding registry resets transient worker states on daemon startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-binding-registry-"));
  const registry = new BindingRegistry(path.join(dir, "binding-registry.json"));
  await registry.load();

  await registry.createBinding({
    aibot_session_id: "chat-ready",
    claude_session_id: "claude-ready",
    cwd: "/repo/ready",
    worker_id: "worker-ready",
    worker_status: "ready",
    plugin_data_dir: "/data/chat-ready",
    worker_control_url: "http://127.0.0.1:9001",
    worker_control_token: "token-ready",
  });
  await registry.createBinding({
    aibot_session_id: "chat-stopped",
    claude_session_id: "claude-stopped",
    cwd: "/repo/stopped",
    worker_id: "worker-stopped",
    worker_status: "stopped",
    plugin_data_dir: "/data/chat-stopped",
  });

  const reset = await registry.resetTransientWorkerStates({
    updatedAt: 20,
    lastStoppedAt: 21,
  });

  assert.equal(reset.length, 2);

  const ready = registry.getByAibotSessionID("chat-ready");
  assert.equal(ready.worker_status, "stopped");
  assert.equal(ready.worker_control_url, "");
  assert.equal(ready.worker_control_token, "");
  assert.equal(ready.last_stopped_at, 21);

  const stopped = registry.getByAibotSessionID("chat-stopped");
  assert.equal(stopped.worker_status, "stopped");
  assert.equal(stopped.last_stopped_at, 0);
});
