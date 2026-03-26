import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerReadyNoticeText,
  notifyWorkerReady,
  shouldIgnoreWorkerStatusUpdate,
  shouldNotifyWorkerReady,
} from "./daemon/main.js";

test("shouldNotifyWorkerReady only notifies on transition into ready", () => {
  assert.equal(shouldNotifyWorkerReady(null, {
    worker_status: "ready",
    worker_control_url: "http://127.0.0.1:9000",
    worker_control_token: "token",
    worker_response_state: "healthy",
  }), true);
  assert.equal(
    shouldNotifyWorkerReady(
      { worker_status: "connected" },
      {
        worker_status: "ready",
        worker_control_url: "http://127.0.0.1:9000",
        worker_control_token: "token",
        worker_response_state: "healthy",
      },
    ),
    true,
  );
  assert.equal(
    shouldNotifyWorkerReady(
      {
        worker_status: "ready",
        worker_control_url: "http://127.0.0.1:9000",
        worker_control_token: "token",
        worker_response_state: "healthy",
      },
      {
        worker_status: "ready",
        worker_control_url: "http://127.0.0.1:9000",
        worker_control_token: "token",
        worker_response_state: "healthy",
      },
    ),
    false,
  );
  assert.equal(
    shouldNotifyWorkerReady({ worker_status: "connected" }, { worker_status: "connected" }),
    false,
  );
  assert.equal(
    shouldNotifyWorkerReady(
      { worker_status: "connected" },
      {
        worker_status: "ready",
        worker_control_url: "http://127.0.0.1:9000",
        worker_control_token: "token",
        worker_response_state: "healthy",
      },
      { pendingEventCount: 1 },
    ),
    false,
  );
  assert.equal(
    shouldNotifyWorkerReady(
      { worker_status: "connected" },
      {
        worker_status: "ready",
        worker_control_url: "http://127.0.0.1:9000",
        worker_control_token: "token",
        worker_response_state: "probing",
      },
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

test("shouldIgnoreWorkerStatusUpdate ignores stale updates for old worker identity", () => {
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
  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "connected",
      worker_id: "worker-old",
      claude_session_id: "claude-current",
    }),
    true,
  );
  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "ready",
      worker_id: "worker-current",
      claude_session_id: "claude-old",
    }),
    true,
  );
});

test("shouldIgnoreWorkerStatusUpdate keeps matching updates or empty baseline", () => {
  const previousBinding = {
    worker_id: "worker-current",
    claude_session_id: "claude-current",
  };

  assert.equal(
    shouldIgnoreWorkerStatusUpdate(previousBinding, {
      status: "connected",
      worker_id: "worker-current",
      claude_session_id: "claude-current",
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
