import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionActivityDispatchKey,
  createSessionActivityDispatcher,
} from "./session-activity-dispatcher.js";

function flushAsyncWork() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("buildSessionActivityDispatchKey prefers ref_event_id", () => {
  assert.equal(
    buildSessionActivityDispatchKey({
      sessionID: "chat-1",
      kind: "composing",
      refEventID: "evt-1",
      refMsgID: "msg-1",
    }),
    "event:evt-1",
  );
});

test("session activity dispatcher serializes sends for the same event", async () => {
  const order = [];
  let releaseFirst = null;

  const dispatcher = createSessionActivityDispatcher(async (payload) => {
    order.push(`start:${payload.active}`);
    if (payload.active) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    order.push(`end:${payload.active}`);
  });

  const first = dispatcher({
    sessionID: "chat-1",
    active: true,
    ttlMs: 30000,
    refEventID: "evt-1",
  });
  const second = dispatcher({
    sessionID: "chat-1",
    active: false,
    refEventID: "evt-1",
  });

  await flushAsyncWork();
  assert.deepEqual(order, ["start:true"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, [
    "start:true",
    "end:true",
    "start:false",
    "end:false",
  ]);
});

test("session activity dispatcher does not block different events", async () => {
  const order = [];
  let releaseFirst = null;

  const dispatcher = createSessionActivityDispatcher(async (payload) => {
    order.push(`start:${payload.refEventID}`);
    if (payload.refEventID === "evt-1") {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    order.push(`end:${payload.refEventID}`);
  });

  const first = dispatcher({
    sessionID: "chat-1",
    active: true,
    refEventID: "evt-1",
  });
  const second = dispatcher({
    sessionID: "chat-1",
    active: true,
    refEventID: "evt-2",
  });

  await flushAsyncWork();
  assert.deepEqual(order, [
    "start:evt-1",
    "start:evt-2",
    "end:evt-2",
  ]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, [
    "start:evt-1",
    "start:evt-2",
    "end:evt-2",
    "end:evt-1",
  ]);
});
