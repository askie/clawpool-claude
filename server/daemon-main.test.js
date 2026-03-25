import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerReadyNoticeText,
  notifyWorkerReady,
  shouldIgnoreWorkerStatusUpdate,
  shouldNotifyWorkerReady,
} from "./daemon/main.js";

test("shouldNotifyWorkerReady only notifies on transition into ready", () => {
  assert.equal(shouldNotifyWorkerReady(null, { worker_status: "ready" }), true);
  assert.equal(
    shouldNotifyWorkerReady({ worker_status: "connected" }, { worker_status: "ready" }),
    true,
  );
  assert.equal(
    shouldNotifyWorkerReady({ worker_status: "ready" }, { worker_status: "ready" }),
    false,
  );
  assert.equal(
    shouldNotifyWorkerReady({ worker_status: "connected" }, { worker_status: "connected" }),
    false,
  );
  assert.equal(
    shouldNotifyWorkerReady(
      { worker_status: "connected" },
      { worker_status: "ready" },
      { pendingEventCount: 1 },
    ),
    false,
  );
});

test("buildWorkerReadyNoticeText returns a short retry notice", () => {
  assert.equal(
    buildWorkerReadyNoticeText({ cwd: "/repo/demo" }),
    "claude ready! please retry again.",
  );
  assert.equal(
    buildWorkerReadyNoticeText({ cwd: "" }),
    "claude ready! please retry again.",
  );
});

test("notifyWorkerReady sends a visible ready message to the bound aibot session", async () => {
  const calls = [];
  const aibotClient = {
    async sendText(payload) {
      calls.push(payload);
      return { msg_id: "1" };
    },
  };

  await notifyWorkerReady(aibotClient, {
    aibot_session_id: "chat-1",
    cwd: "/repo/demo",
  });

  assert.deepEqual(calls, [
    {
      sessionID: "chat-1",
      text: "claude ready! please retry again.",
      extra: {
        reply_source: "daemon_worker_ready",
      },
    },
  ]);
});

test("shouldIgnoreWorkerStatusUpdate ignores stale stopped/failed status updates", () => {
  const previousBinding = {
    worker_id: "worker-current",
    claude_session_id: "claude-current",
  };

  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "stopped",
      worker_id: "worker-old",
      claude_session_id: "claude-current",
    }),
    true,
  );
  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "failed",
      worker_id: "worker-current",
      claude_session_id: "claude-old",
    }),
    true,
  );
});

test("shouldIgnoreWorkerStatusUpdate keeps non-terminal or matching updates", () => {
  const previousBinding = {
    worker_id: "worker-current",
    claude_session_id: "claude-current",
  };

  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "connected",
      worker_id: "worker-old",
      claude_session_id: "claude-old",
    }),
    false,
  );
  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "stopped",
      worker_id: "worker-current",
      claude_session_id: "claude-current",
    }),
    false,
  );
  assert.equal(
    shouldIgnoreWorkerStatusUpdate(null, {
      status: "stopped",
      worker_id: "worker-old",
      claude_session_id: "claude-old",
    }),
    false,
  );
});
