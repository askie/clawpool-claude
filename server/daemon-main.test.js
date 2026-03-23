import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerReadyNoticeText,
  notifyWorkerReady,
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
});

test("buildWorkerReadyNoticeText includes cwd when available", () => {
  assert.equal(
    buildWorkerReadyNoticeText({ cwd: "/repo/demo" }),
    "Claude 已就绪，可以开始对话。\n目录: /repo/demo",
  );
  assert.equal(
    buildWorkerReadyNoticeText({ cwd: "" }),
    "Claude 已就绪，可以开始对话。",
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
      text: "Claude 已就绪，可以开始对话。\n目录: /repo/demo",
      extra: {
        reply_source: "daemon_worker_ready",
      },
    },
  ]);
});
