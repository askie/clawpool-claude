import test from "node:test";
import assert from "node:assert/strict";
import { WorkerBridgeServer } from "./daemon/worker-bridge-server.js";
import { WorkerBridgeClient } from "./worker/worker-bridge-client.js";

test("worker bridge server accepts worker registration and status updates", async () => {
  const calls = [];
  const server = new WorkerBridgeServer({
    token: "test-token",
    onRegisterWorker(payload) {
      calls.push({ kind: "register", payload });
      return { ok: true, registered: true };
    },
    onStatusUpdate(payload) {
      calls.push({ kind: "status", payload });
      return { ok: true, updated: true };
    },
  });
  await server.start();

  try {
    const client = new WorkerBridgeClient({
      bridgeURL: server.getURL(),
      token: "test-token",
    });
    const register = await client.registerWorker({
      worker_id: "worker-1",
      aibot_session_id: "chat-1",
    });
    const status = await client.sendStatusUpdate({
      worker_id: "worker-1",
      status: "ready",
    });

    assert.equal(register.registered, true);
    assert.equal(status.updated, true);
    assert.deepEqual(calls, [
      {
        kind: "register",
        payload: {
          worker_id: "worker-1",
          aibot_session_id: "chat-1",
        },
      },
      {
        kind: "status",
        payload: {
          worker_id: "worker-1",
          status: "ready",
        },
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("worker bridge server rejects invalid token", async () => {
  const server = new WorkerBridgeServer({
    token: "good-token",
  });
  await server.start();

  try {
    const client = new WorkerBridgeClient({
      bridgeURL: server.getURL(),
      token: "bad-token",
    });
    await assert.rejects(
      () => client.registerWorker({ worker_id: "worker-2" }),
      /unauthorized/u,
    );
  } finally {
    await server.stop();
  }
});

test("worker bridge server forwards worker outbound operations", async () => {
  const calls = [];
  const server = new WorkerBridgeServer({
    token: "test-token",
    async onSendText(payload) {
      calls.push({ kind: "send-text", payload });
      return { msg_id: "101" };
    },
    async onSendMedia(payload) {
      calls.push({ kind: "send-media", payload });
      return { msg_id: "102" };
    },
    async onDeleteMessage(payload) {
      calls.push({ kind: "delete-message", payload });
      return { ok: true };
    },
    async onAckEvent(payload) {
      calls.push({ kind: "ack-event", payload });
      return { ok: true };
    },
    async onSendEventResult(payload) {
      calls.push({ kind: "event-result", payload });
      return { ok: true };
    },
    async onSendEventStopAck(payload) {
      calls.push({ kind: "event-stop-ack", payload });
      return { ok: true };
    },
    async onSendEventStopResult(payload) {
      calls.push({ kind: "event-stop-result", payload });
      return { ok: true };
    },
    async onSetSessionComposing(payload) {
      calls.push({ kind: "session-composing", payload });
      return { ok: true };
    },
  });
  await server.start();

  try {
    const client = new WorkerBridgeClient({
      bridgeURL: server.getURL(),
      token: "test-token",
    });

    const sendTextAck = await client.sendText({
      session_id: "chat-2",
      text: "hello",
    });
    const sendMediaAck = await client.sendMedia({
      session_id: "chat-2",
      media_url: "https://example.com/file.png",
    });
    await client.deleteMessage({
      session_id: "chat-2",
      msg_id: "88",
    });
    await client.ackEvent({
      event_id: "evt-2",
      session_id: "chat-2",
      msg_id: "m-2",
    });
    await client.sendEventResult({
      event_id: "evt-2",
      status: "responded",
    });
    await client.sendEventStopAck({
      event_id: "evt-2",
      accepted: true,
    });
    await client.sendEventStopResult({
      event_id: "evt-2",
      status: "stopped",
    });
    await client.setSessionComposing({
      session_id: "chat-2",
      active: true,
    });

    assert.equal(sendTextAck.msg_id, "101");
    assert.equal(sendMediaAck.msg_id, "102");
    assert.deepEqual(calls, [
      {
        kind: "send-text",
        payload: {
          session_id: "chat-2",
          text: "hello",
        },
      },
      {
        kind: "send-media",
        payload: {
          session_id: "chat-2",
          media_url: "https://example.com/file.png",
        },
      },
      {
        kind: "delete-message",
        payload: {
          session_id: "chat-2",
          msg_id: "88",
        },
      },
      {
        kind: "ack-event",
        payload: {
          event_id: "evt-2",
          session_id: "chat-2",
          msg_id: "m-2",
        },
      },
      {
        kind: "event-result",
        payload: {
          event_id: "evt-2",
          status: "responded",
        },
      },
      {
        kind: "event-stop-ack",
        payload: {
          event_id: "evt-2",
          accepted: true,
        },
      },
      {
        kind: "event-stop-result",
        payload: {
          event_id: "evt-2",
          status: "stopped",
        },
      },
      {
        kind: "session-composing",
        payload: {
          session_id: "chat-2",
          active: true,
        },
      },
    ]);
  } finally {
    await server.stop();
  }
});
