import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  AibotClient,
  buildAuthPayload,
  buildSessionActivityPayload,
} from "./aibot-client.js";

function makeClient() {
  return new AibotClient();
}

function markClientReady(client) {
  client.status = {
    configured: true,
    connecting: false,
    connected: true,
    authed: true,
    last_error: "",
  };
  return client;
}

test("aibot client sendMedia sends send_msg with media_url", async () => {
  const client = markClientReady(makeClient());
  const sentPackets = [];

  client.ws = {
    readyState: 1,
    send(raw) {
      const packet = JSON.parse(raw);
      sentPackets.push(packet);
      queueMicrotask(() => {
        void client.handleMessage(JSON.stringify({
          cmd: "send_ack",
          seq: packet.seq,
          payload: {
            msg_id: "18889990099",
            client_msg_id: packet.payload.client_msg_id,
          },
        }));
      });
    },
  };

  const ack = await client.sendMedia({
    eventID: "evt-1",
    sessionID: "chat-1",
    mediaURL: "https://cdn.example.com/a.png",
    caption: "a.png",
    quotedMessageID: "1001",
    clientMsgID: "media_1",
    extra: {
      attachment_type: "image",
      file_name: "a.png",
    },
  });

  assert.equal(sentPackets.length, 1);
  assert.equal(sentPackets[0].cmd, "send_msg");
  assert.deepEqual(sentPackets[0].payload, {
    event_id: "evt-1",
    session_id: "chat-1",
    client_msg_id: "media_1",
    msg_type: 2,
    content: "a.png",
    media_url: "https://cdn.example.com/a.png",
    quoted_message_id: "1001",
    extra: {
      attachment_type: "image",
      file_name: "a.png",
    },
  });
  assert.equal(ack.msg_id, "18889990099");
});

test("buildAuthPayload pins claude client_type", () => {
  assert.deepEqual(
    buildAuthPayload({
      agentID: "9001",
      apiKey: "test-api-key",
    }),
    {
      agent_id: "9001",
      api_key: "test-api-key",
      client: "claude-clawpool-claude-channel",
      client_type: "claude",
    },
  );
});

test("buildSessionActivityPayload includes composing keepalive references", () => {
  assert.deepEqual(
    buildSessionActivityPayload({
      sessionID: "chat-1",
      kind: "composing",
      active: true,
      ttlMs: 30000,
      refMsgID: "2035400738204553216",
      refEventID: "evt-1",
    }),
    {
      session_id: "chat-1",
      kind: "composing",
      active: true,
      ttl_ms: 30000,
      ref_msg_id: "2035400738204553216",
      ref_event_id: "evt-1",
    },
  );
});

test("buildSessionActivityPayload omits empty optional fields", () => {
  assert.deepEqual(
    buildSessionActivityPayload({
      sessionID: "chat-1",
      kind: "composing",
      active: false,
    }),
    {
      session_id: "chat-1",
      kind: "composing",
      active: false,
    },
  );
});

test("aibot client setSessionComposing forwards explicit kind", () => {
  const client = markClientReady(makeClient());
  const sentPackets = [];

  client.ws = {
    readyState: 1,
    send(raw) {
      sentPackets.push(JSON.parse(raw));
    },
  };

  client.setSessionComposing({
    sessionID: "chat-2",
    kind: "composing",
    active: false,
    refEventID: "evt-2",
  });

  assert.equal(sentPackets.length, 1);
  assert.equal(sentPackets[0].cmd, "session_activity_set");
  assert.deepEqual(sentPackets[0].payload, {
    session_id: "chat-2",
    kind: "composing",
    active: false,
    ref_event_id: "evt-2",
  });
});

test("aibot client schedules reconnect when forced close does not emit close", async () => {
  const client = makeClient();
  const reconnects = [];

  client.scheduleReconnect = (delayMs) => {
    reconnects.push(delayMs);
  };
  client.ws = {
    readyState: 1,
    once() {},
    off() {},
    close() {},
  };

  await client.closeCurrentSocket({ suppressReconnect: false });

  assert.deepEqual(reconnects, [0]);
  assert.equal(client.ws, null);
  assert.equal(client.status.connected, false);
  assert.equal(client.status.authed, false);
});

test("aibot client only suppresses reconnect for the socket being intentionally closed", () => {
  const client = makeClient();
  const reconnects = [];

  client.scheduleReconnect = (delayMs) => {
    reconnects.push(delayMs);
  };

  const oldSocket = new EventEmitter();
  oldSocket.readyState = 1;
  client.suppressReconnectSocket = oldSocket;

  const nextSocket = new EventEmitter();
  nextSocket.readyState = 1;
  client.ws = nextSocket;
  client.bindSocket(nextSocket);

  nextSocket.emit("close");

  assert.deepEqual(reconnects, [client.reconnectDelay]);
  assert.equal(client.suppressReconnectSocket, oldSocket);
});
