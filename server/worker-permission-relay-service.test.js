import assert from "node:assert/strict";
import test from "node:test";
import { EventState } from "./event-state.js";
import { WorkerPermissionRelayService } from "./worker/permission-relay-service.js";

function createLogger() {
  return {
    info() {},
    error() {},
    debug() {},
  };
}

function createService({
  accessStore = {},
  bridge = {},
  mcp = {},
} = {}) {
  const eventState = new EventState();
  const bridgeCalls = [];
  const notificationCalls = [];
  const finalizeCalls = [];
  const service = new WorkerPermissionRelayService({
    mcp: {
      setNotificationHandler() {},
      async notification(payload) {
        notificationCalls.push(payload);
      },
      ...mcp,
    },
    bridge: {
      async sendText(payload) {
        bridgeCalls.push(payload);
        return {};
      },
      ...bridge,
    },
    accessStore: {
      hasApprovers: () => true,
      isSenderApprover: () => true,
      ...accessStore,
    },
    eventState,
    async finalizeEvent(eventID, result, context) {
      finalizeCalls.push({ eventID, result, context });
      return true;
    },
    logger: createLogger(),
    aibotSessionID: "chat-1",
  });

  return {
    service,
    eventState,
    bridgeCalls,
    notificationCalls,
    finalizeCalls,
  };
}

function registerActiveEvent(eventState) {
  eventState.registerInbound({
    event_id: "evt-1",
    session_id: "chat-1",
    msg_id: "msg-1",
    sender_id: "sender-1",
    content: "hello",
  });
}

test("worker permission relay dispatches native permission requests as approval cards", async () => {
  const { service, eventState, bridgeCalls } = createService();
  registerActiveEvent(eventState);

  await service.handlePermissionRequest({
    request_id: "abcde",
    tool_name: "Bash",
    description: "Run pwd",
    input_preview: "{\"command\":\"pwd\"}",
  });

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].sessionID, "chat-1");
  assert.equal(bridgeCalls[0].quotedMessageID, "msg-1");
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_permission_request");
  assert.equal(bridgeCalls[0].extra.biz_card.type, "exec_approval");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.approval_id, "abcde");
  assert.deepEqual(bridgeCalls[0].extra.biz_card.payload.allowed_decisions, [
    "allow-once",
    "deny",
  ]);
  assert.deepEqual(bridgeCalls[0].extra.biz_card.payload.decision_commands, {
    "allow-once": "yes abcde",
    deny: "no abcde",
  });
  assert.deepEqual(service.getStatus(), {
    pending_count: 1,
    pending_request_ids: ["abcde"],
  });

  await service.shutdown();
});

test("worker permission relay forwards yes verdicts back to Claude", async () => {
  const { service, eventState, bridgeCalls, notificationCalls, finalizeCalls } = createService();
  registerActiveEvent(eventState);

  await service.handlePermissionRequest({
    request_id: "abcde",
    tool_name: "Bash",
    description: "Run pwd",
    input_preview: "{\"command\":\"pwd\"}",
  });

  const handled = await service.handleCommandEvent({
    event_id: "evt-approval-1",
    session_id: "chat-1",
    msg_id: "msg-approval-1",
    sender_id: "sender-approval-1",
    content: "yes abcde",
  });

  assert.deepEqual(handled, {
    handled: true,
    kind: "approval",
  });
  assert.deepEqual(notificationCalls, [
    {
      method: "notifications/claude/channel/permission",
      params: {
        request_id: "abcde",
        behavior: "allow",
      },
    },
  ]);
  assert.equal(bridgeCalls.length, 2);
  assert.equal(bridgeCalls[1].extra.reply_source, "claude_channel_approval");
  assert.equal(bridgeCalls[1].extra.biz_card.type, "exec_status");
  assert.equal(bridgeCalls[1].extra.biz_card.payload.status, "approval-forwarded");
  assert.equal(bridgeCalls[1].extra.biz_card.payload.decision, "allow-once");
  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].eventID, "evt-approval-1");
  assert.equal(finalizeCalls[0].result.code, "approval_forwarded");
  assert.deepEqual(service.getStatus(), {
    pending_count: 0,
    pending_request_ids: [],
  });

  await service.shutdown();
});

test("worker permission relay keeps local-only permission prompts out of AIBot", async () => {
  const { service, bridgeCalls } = createService();

  await service.handlePermissionRequest({
    request_id: "abcde",
    tool_name: "Bash",
    description: "Run pwd",
    input_preview: "{\"command\":\"pwd\"}",
  });

  assert.equal(bridgeCalls.length, 0);
  assert.deepEqual(service.getStatus(), {
    pending_count: 0,
    pending_request_ids: [],
  });

  await service.shutdown();
});

test("worker permission relay rejects verdicts from non-approvers", async () => {
  const { service, eventState, bridgeCalls, notificationCalls, finalizeCalls } = createService({
    accessStore: {
      isSenderApprover: () => false,
    },
  });
  registerActiveEvent(eventState);

  await service.handlePermissionRequest({
    request_id: "abcde",
    tool_name: "Bash",
    description: "Run pwd",
    input_preview: "{\"command\":\"pwd\"}",
  });

  const handled = await service.handleCommandEvent({
    event_id: "evt-approval-2",
    session_id: "chat-1",
    msg_id: "msg-approval-2",
    sender_id: "sender-approval-2",
    content: "no abcde",
  });

  assert.deepEqual(handled, {
    handled: true,
    kind: "approval",
  });
  assert.equal(notificationCalls.length, 0);
  assert.equal(bridgeCalls.length, 2);
  assert.equal(bridgeCalls[1].extra.reply_source, "claude_channel_approval");
  assert.equal(bridgeCalls[1].extra.biz_card.type, "claude_status");
  assert.equal(bridgeCalls[1].extra.biz_card.payload.status, "warning");
  assert.equal(finalizeCalls[0].result.code, "approval_sender_not_authorized");

  await service.shutdown();
});
