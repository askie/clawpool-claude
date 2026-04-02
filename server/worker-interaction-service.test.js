import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { EventState } from "./event-state.js";
import { saveEventEntry } from "./event-state-persistence.js";
import { WorkerInteractionService } from "./worker/interaction-service.js";

function createLogger(traceCalls = null) {
  return {
    info() {},
    error() {},
    debug() {},
    trace(fields) {
      traceCalls?.push(fields);
    },
  };
}

function createService({
  bridge = {},
  accessStore = {},
  mcp = {},
  eventStatesDir = "/tmp/grix-claude-test-event-states",
  resultTimeoutMs = undefined,
  resultRetryTimeoutMs = undefined,
  composingHeartbeatMs = undefined,
  composingTTLMS = undefined,
  logger = null,
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
    resultTimeoutMs,
    resultRetryTimeoutMs,
    composingHeartbeatMs,
    composingTTLMS,
    logger: logger ?? createLogger(),
  });
  return {
    service,
    eventState,
  };
}

async function waitForCondition(predicate, {
  timeoutMs = 1_000,
  intervalMs = 20,
} = {}) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
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

test("worker inbound handling routes internal ping probe without access flow or composing", async () => {
  const bridgeCalls = [];
  const notifications = [];
  const { service, eventState } = createService({
    accessStore: {
      getPolicy: () => "disabled",
      isSenderAllowlisted: () => false,
      isSenderAllowed: () => false,
      hasAllowedSenders: () => false,
    },
    bridge: {
      async sendText(payload) {
        bridgeCalls.push({ kind: "text", payload });
        return {};
      },
      async sendEventResult(payload) {
        bridgeCalls.push({ kind: "event_result", payload });
        return {};
      },
      async setSessionComposing(payload) {
        bridgeCalls.push({ kind: "compose", payload });
        return {};
      },
    },
    mcp: {
      async notification(payload) {
        notifications.push(payload);
        return {};
      },
    },
  });

  await service.handleInboundEvent({
    event_id: "evt-probe-1",
    session_id: "chat-probe-1",
    msg_id: "msg-probe-1",
    sender_id: "sender-probe-1",
    content: "ping",
    channel_data: {
      "grix-claude": {
        internal_probe: {
          kind: "ping_pong",
          probe_id: "probe-1",
          expected_reply: "pong",
        },
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.content, "ping");
  assert.deepEqual(bridgeCalls, []);
  assert.equal(eventState.get("evt-probe-1")?.transient, true);
  assert.equal(eventState.get("evt-probe-1")?.internal_probe, true);
  assert.equal(eventState.getLatestActiveBySession("chat-probe-1"), null);

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
    "/grix:access pair <code>",
  );
  assert.equal(sentResults.length, 1);
  assert.equal(sentResults[0].code, "pairing_required");

  await service.shutdown();
});

test("worker inbound handling leaves ordinary Claude work open without a local hard timeout", async () => {
  const sentResults = [];
  const traceCalls = [];
  const { service, eventState } = createService({
    resultTimeoutMs: 40,
    resultRetryTimeoutMs: 20,
    composingHeartbeatMs: 10,
    composingTTLMS: 30,
    logger: createLogger(traceCalls),
    bridge: {
      async sendEventResult(payload) {
        sentResults.push(payload);
        return {};
      },
      async setSessionComposing() {
        return {};
      },
    },
    mcp: {
      async notification() {
        return {};
      },
    },
  });

  await service.handleInboundEvent({
    event_id: "evt-timeout-1",
    session_id: "chat-timeout-1",
    msg_id: "msg-timeout-1",
    sender_id: "sender-timeout-1",
    content: "hello",
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(sentResults.length, 0);
  const stored = eventState.get("evt-timeout-1");
  assert.equal(stored?.completed, null);
  assert.equal(stored?.result_deadline_at, 0);
  assert.deepEqual(
    traceCalls.find((entry) => entry.stage === "event_waiting_for_claude_result"),
    {
      component: "worker.interaction",
      stage: "event_waiting_for_claude_result",
      event_id: "evt-timeout-1",
      session_id: "chat-timeout-1",
      local_result_timeout_armed: false,
      result_timeout_owner: "daemon",
    },
  );

  await service.shutdown();
});

test("restoreEventState does not create a new local timeout for unresolved ordinary events", async () => {
  const eventStatesDir = await mkdtemp(path.join(os.tmpdir(), "grix-worker-restore-timeout-"));
  const traceCalls = [];
  const { service, eventState } = createService({
    eventStatesDir,
    logger: createLogger(traceCalls),
  });
  await writePendingEventState(eventStatesDir, {
    eventID: "evt-restore-no-deadline",
    resultIntent: null,
    resultDeadlineAt: 0,
  });

  await service.restoreEventState();

  const restored = eventState.get("evt-restore-no-deadline");
  assert.ok(restored);
  assert.equal(restored.completed, null);
  assert.equal(restored.result_deadline_at, 0);
  assert.deepEqual(
    traceCalls.find((entry) => entry.stage === "event_restored_waiting_for_claude_result"),
    {
      component: "worker.interaction",
      stage: "event_restored_waiting_for_claude_result",
      event_id: "evt-restore-no-deadline",
      session_id: "chat-1",
      local_result_timeout_armed: false,
      result_timeout_owner: "daemon",
    },
  );

  await service.shutdown();
});

test("restoreEventState rearms retry for unresolved events with result intent but no deadline", async () => {
  const eventStatesDir = await mkdtemp(path.join(os.tmpdir(), "grix-worker-restore-intent-"));
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
