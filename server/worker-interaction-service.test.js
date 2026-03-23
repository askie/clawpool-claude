import assert from "node:assert/strict";
import test from "node:test";
import { EventState } from "./event-state.js";
import { WorkerInteractionService } from "./worker/interaction-service.js";

function createLogger() {
  return {
    info() {},
    error() {},
    debug() {},
  };
}

function createService({
  bridge = {},
  accessStore = {},
  mcp = {},
} = {}) {
  const eventState = new EventState();
  const service = new WorkerInteractionService({
    eventState,
    sessionContextStore: {
      async put() {},
    },
    accessStore: {
      getPolicy: () => "allowlist",
      isSenderAllowlisted: () => true,
      isSenderAllowed: () => true,
      hasAllowedSenders: () => true,
      issuePairingCode: async () => ({ code: "PAIR123" }),
      bootstrapFirstSender: async () => ({ bootstrapped: false, policy: "allowlist" }),
      ...accessStore,
    },
    approvalStore: {
      async getRequest() {
        return null;
      },
      async markDispatched() {},
      async listPendingDispatches() {
        return [];
      },
    },
    questionStore: {
      async getRequest() {
        return null;
      },
      async markDispatched() {},
      async listPendingDispatches() {
        return [];
      },
    },
    eventStatesDir: "/tmp/clawpool-claude-test-event-states",
    mcp: {
      async notification() {},
      ...mcp,
    },
    bridge: {
      async ackEvent() {},
      async sendText() {
        return {};
      },
      async sendEventResult() {
        return {};
      },
      async sendEventStopAck() {
        return {};
      },
      async sendEventStopResult() {
        return {};
      },
      async setSessionComposing() {
        return {};
      },
      ...bridge,
    },
    logger: createLogger(),
  });
  return {
    service,
    eventState,
  };
}

test("worker inbound handling records local acceptance without sending a second upstream ack", async () => {
  const calls = [];
  const { service, eventState } = createService({
    bridge: {
      async ackEvent() {
        calls.push("ack");
      },
      async setSessionComposing() {
        calls.push("compose");
        return {};
      },
    },
    mcp: {
      async notification() {
        calls.push("notify");
      },
    },
  });

  await service.handleInboundEvent({
    event_id: "evt-1",
    session_id: "chat-1",
    msg_id: "msg-1",
    sender_id: "sender-1",
    content: "hello",
  });

  assert.deepEqual(calls.filter((entry) => entry === "ack"), []);
  assert.equal(calls.includes("notify"), true);
  assert.equal(eventState.get("evt-1")?.acked, true);

  await service.shutdown();
});

test("worker revoke handling still acknowledges through bridge", async () => {
  const calls = [];
  const { service } = createService({
    bridge: {
      async ackEvent() {
        calls.push("ack");
        return {};
      },
    },
  });

  await service.handleRevokeEvent({
    event_id: "evt-revoke-1",
    session_id: "chat-1",
    msg_id: "msg-1",
  });

  assert.deepEqual(calls, ["ack"]);

  await service.shutdown();
});

test("worker inbound handling sends structured access status when channel is disabled", async () => {
  const sentTexts = [];
  const sentResults = [];
  const { service } = createService({
    accessStore: {
      getPolicy: () => "disabled",
    },
    bridge: {
      async sendText(payload) {
        sentTexts.push(payload);
        return {};
      },
      async sendEventResult(payload) {
        sentResults.push(payload);
        return {};
      },
      async setSessionComposing() {
        return {};
      },
    },
  });

  await service.handleInboundEvent({
    event_id: "evt-disabled-1",
    session_id: "chat-disabled-1",
    msg_id: "msg-disabled-1",
    sender_id: "sender-disabled-1",
    content: "hello",
  });

  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].extra.reply_source, "claude_channel_access");
  assert.equal(sentTexts[0].extra.biz_card.version, 1);
  assert.equal(sentTexts[0].extra.biz_card.type, "claude_status");
  assert.equal(sentTexts[0].extra.biz_card.payload.category, "access");
  assert.equal(sentTexts[0].extra.biz_card.payload.status, "warning");
  assert.equal(sentTexts[0].extra.biz_card.payload.reference_id, "evt-disabled-1");
  assert.equal(sentResults.length, 1);
  assert.equal(sentResults[0].code, "policy_disabled");

  await service.shutdown();
});

test("worker inbound handling sends structured pairing card for blocked direct sender", async () => {
  const sentTexts = [];
  const sentResults = [];
  const { service } = createService({
    accessStore: {
      isSenderAllowlisted: () => false,
      isSenderAllowed: () => false,
      hasAllowedSenders: () => true,
      issuePairingCode: async () => ({ code: "PAIR123" }),
    },
    bridge: {
      async sendText(payload) {
        sentTexts.push(payload);
        return {};
      },
      async sendEventResult(payload) {
        sentResults.push(payload);
        return {};
      },
      async setSessionComposing() {
        return {};
      },
    },
  });

  await service.handleInboundEvent({
    event_id: "evt-pairing-1",
    session_id: "chat-pairing-1",
    msg_id: "msg-pairing-1",
    sender_id: "sender-pairing-1",
    content: "hello",
  });

  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].clientMsgID, "pair_evt-pairing-1");
  assert.equal(sentTexts[0].extra.biz_card.version, 1);
  assert.equal(sentTexts[0].extra.biz_card.type, "claude_pairing");
  assert.equal(sentTexts[0].extra.biz_card.payload.pairing_code, "PAIR123");
  assert.equal(
    sentTexts[0].extra.biz_card.payload.command_hint,
    "/clawpool:access pair <code>",
  );
  assert.equal(sentResults.length, 1);
  assert.equal(sentResults[0].code, "pairing_required");

  await service.shutdown();
});
