import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { EventState } from "./event-state.js";
import { saveEventEntry } from "./event-state-persistence.js";
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
  eventStatesDir = "/tmp/clawpool-claude-test-event-states",
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
    eventStatesDir,
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

async function writePendingEventState(eventStatesDir, {
  eventID,
  sessionID = "chat-1",
  msgID = "msg-1",
  content = "hello",
  resultIntent = null,
  resultDeadlineAt = 0,
  completed = null,
  stopped = null,
}) {
  const now = Date.now();
  await saveEventEntry(eventStatesDir, {
    event_id: eventID,
    session_id: sessionID,
    msg_id: msgID,
    quoted_message_id: "",
    sender_id: "sender-1",
    event_type: "user_chat",
    session_type: "1",
    content,
    owner_id: "owner-1",
    agent_id: "agent-1",
    msg_type: "1",
    message_created_at: now,
    mention_user_ids: [],
    extra_json: "",
    attachments_json: "",
    attachment_count: "",
    biz_card_json: "",
    channel_data_json: "",
    acked: true,
    ack_at: now,
    notification_dispatched_at: now,
    pairing_sent_at: 0,
    pairing_retry_after: 0,
    result_deadline_at: resultDeadlineAt,
    result_intent: resultIntent,
    completed,
    stopped,
    created_at: now,
    last_seen_at: now,
  });
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

test("restoreEventState rearms timeout for unresolved events without persisted deadline", async () => {
  const eventStatesDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-restore-timeout-"));
  const { service, eventState } = createService({ eventStatesDir });
  await writePendingEventState(eventStatesDir, {
    eventID: "evt-restore-no-deadline",
    resultIntent: null,
    resultDeadlineAt: 0,
  });

  await service.restoreEventState();

  const restored = eventState.get("evt-restore-no-deadline");
  assert.ok(restored);
  assert.equal(restored.completed, null);
  assert.ok(Number(restored.result_deadline_at) > Date.now());

  await service.shutdown();
});

test("restoreEventState rearms retry for unresolved events with result intent but no deadline", async () => {
  const eventStatesDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-restore-intent-"));
  const { service, eventState } = createService({ eventStatesDir });
  await writePendingEventState(eventStatesDir, {
    eventID: "evt-restore-intent-no-deadline",
    resultIntent: {
      status: "failed",
      code: "claude_result_timeout",
      msg: "Claude did not call reply or complete before timeout.",
      updated_at: Date.now(),
    },
    resultDeadlineAt: 0,
  });

  await service.restoreEventState();

  const restored = eventState.get("evt-restore-intent-no-deadline");
  assert.ok(restored);
  assert.equal(restored.completed, null);
  assert.ok(Number(restored.result_deadline_at) > Date.now());

  await service.shutdown();
});
