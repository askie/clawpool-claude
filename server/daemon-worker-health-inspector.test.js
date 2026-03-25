import test from "node:test";
import assert from "node:assert/strict";
import { WorkerHealthInspector } from "./daemon/worker-health-inspector.js";

test("worker health inspector filters in-flight records by delivery state", () => {
  const inspector = new WorkerHealthInspector({
    getPendingEventsForSession() {
      return [
        { eventID: "evt-1", delivery_state: "pending" },
        { eventID: "evt-2", delivery_state: "dispatching" },
        { eventID: "evt-3", delivery_state: "delivered" },
        { eventID: "evt-4", delivery_state: "interrupted" },
      ];
    },
  });

  const records = inspector.listInFlightSessionEvents("chat-1");
  assert.deepEqual(
    records.map((record) => record.eventID),
    ["evt-2", "evt-3"],
  );
});

test("worker health inspector gives grace window for missing mcp activity right after dispatch", () => {
  const baseTime = Date.now();
  const inspector = new WorkerHealthInspector({
    mcpInteractionIdleMs: 50,
    getPendingEventsForSession() {
      return [
        {
          eventID: "evt-1",
          delivery_state: "delivered",
          updated_at: baseTime,
        },
      ];
    },
  });

  const healthy = inspector.inspectMcpInteractionHealth(
    { worker_status: "ready", aibot_session_id: "chat-1" },
    { ok: true, mcp_ready: true },
    { now: baseTime + 20 },
  );
  assert.equal(healthy.ok, true);

  const stale = inspector.inspectMcpInteractionHealth(
    { worker_status: "ready", aibot_session_id: "chat-1" },
    { ok: true, mcp_ready: true },
    { now: baseTime + 120 },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "mcp_activity_missing");
});

test("worker health inspector detects pid mismatch in ping identity", () => {
  const inspector = new WorkerHealthInspector({
    getPendingEventsForSession() {
      return [];
    },
  });

  const result = inspector.inspectWorkerIdentityHealth(
    {
      worker_id: "worker-1",
      aibot_session_id: "chat-1",
      claude_session_id: "claude-1",
      worker_pid: 12345,
    },
    { pid: 12345 },
    {
      worker_id: "worker-1",
      aibot_session_id: "chat-1",
      claude_session_id: "claude-1",
      pid: 54321,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "worker_pid_mismatch");
  assert.equal(result.expectedPid, 12345);
  assert.equal(result.reportedPid, 54321);
});

test("worker health inspector can use persisted pid when runtime pid is missing", () => {
  const inspector = new WorkerHealthInspector({
    getPendingEventsForSession() {
      return [];
    },
  });

  const result = inspector.inspectWorkerIdentityHealth(
    {
      worker_id: "worker-2",
      worker_pid: 20001,
    },
    null,
    {
      worker_id: "worker-2",
      pid: 20002,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "worker_pid_mismatch");
  assert.equal(result.expectedPid, 20001);
  assert.equal(result.reportedPid, 20002);
});

test("worker health inspector prefers persisted worker pid over stale runtime pid", () => {
  const inspector = new WorkerHealthInspector({
    getPendingEventsForSession() {
      return [];
    },
  });

  const result = inspector.inspectWorkerIdentityHealth(
    {
      worker_id: "worker-3",
      worker_pid: 30001,
    },
    { pid: 12345 },
    {
      worker_id: "worker-3",
      pid: 30001,
    },
  );

  assert.equal(result.ok, true);
});

test("worker health inspector ignores runtime pid mismatch before worker reports persisted pid", () => {
  const inspector = new WorkerHealthInspector({
    getPendingEventsForSession() {
      return [];
    },
  });

  const result = inspector.inspectWorkerIdentityHealth(
    {
      worker_id: "worker-4",
    },
    { pid: 40001 },
    {
      worker_id: "worker-4",
      pid: 40002,
    },
  );

  assert.equal(result.ok, true);
});

test("worker health inspector timeout check accepts fresh ping activity", () => {
  const baseTime = Date.now();
  const inspector = new WorkerHealthInspector({
    mcpResultTimeoutMs: 30,
    getPendingEventsForSession() {
      return [
        {
          eventID: "evt-1",
          delivery_state: "delivered",
          updated_at: baseTime - 100,
        },
      ];
    },
  });

  const timedOutWithoutPing = inspector.listTimedOutMcpResultRecords(
    "chat-1",
    baseTime,
  );
  assert.equal(timedOutWithoutPing.length, 1);

  const timedOutWithFreshPing = inspector.listTimedOutMcpResultRecords(
    "chat-1",
    baseTime,
    {
      latestMcpActivityAt: baseTime - 10,
    },
  );
  assert.equal(timedOutWithFreshPing.length, 0);
});
