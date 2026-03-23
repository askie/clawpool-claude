import assert from "node:assert/strict";
import test from "node:test";
import { WorkerHumanLoopService } from "./worker/human-loop-service.js";

function createLogger() {
  return {
    info() {},
    error() {},
    debug() {},
  };
}

function createService({
  accessStore = {},
  approvalStore = {},
  questionStore = {},
  bridge = {},
} = {}) {
  const finalizeCalls = [];
  const bridgeCalls = [];
  const service = new WorkerHumanLoopService({
    accessStore: {
      isSenderApprover: () => false,
      ...accessStore,
    },
    approvalStore: {
      async getRequest() {
        return null;
      },
      async resolveRequest() {},
      async listPendingDispatches() {
        return [];
      },
      async markDispatched() {},
      async markDispatchFailed() {},
      ...approvalStore,
    },
    questionStore: {
      async getRequest() {
        return null;
      },
      async resolveRequest() {},
      async listPendingDispatches() {
        return [];
      },
      async markDispatched() {},
      async markDispatchFailed() {},
      ...questionStore,
    },
    bridge: {
      async sendText(payload) {
        bridgeCalls.push(payload);
        return {};
      },
      ...bridge,
    },
    async finalizeEvent(eventID, result, context) {
      finalizeCalls.push({ eventID, result, context });
      return true;
    },
    logger: createLogger(),
  });

  return {
    service,
    finalizeCalls,
    bridgeCalls,
  };
}

test("worker human loop service records approval decisions", async () => {
  const resolved = [];
  const { service, finalizeCalls, bridgeCalls } = createService({
    accessStore: {
      isSenderApprover: () => true,
    },
    approvalStore: {
      async getRequest(requestID) {
        assert.equal(requestID, "req-approval-1");
        return {
          request_id: requestID,
          status: "pending",
          channel_context: {
            chat_id: "chat-approval-1",
          },
          permission_suggestions: [
            { tool: "Bash", rule: "allow echo" },
          ],
        };
      },
      async resolveRequest(requestID, payload) {
        resolved.push({ requestID, payload });
      },
    },
  });

  const handled = await service.handleCommandEvent({
    event_id: "evt-approval-1",
    session_id: "chat-approval-1",
    msg_id: "msg-approval-1",
    sender_id: "sender-approval-1",
    content: "/clawpool-approval req-approval-1 allow-rule 1",
  });

  assert.deepEqual(handled, {
    handled: true,
    kind: "approval",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].requestID, "req-approval-1");
  assert.deepEqual(resolved[0].payload.decision, {
    behavior: "allow",
    updatedPermissions: [
      { tool: "Bash", rule: "allow echo" },
    ],
  });
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_channel_approval");
  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].eventID, "evt-approval-1");
  assert.equal(finalizeCalls[0].result.code, "approval_recorded");

  await service.shutdown();
});

test("worker human loop service records question answers", async () => {
  const resolved = [];
  const { service, finalizeCalls, bridgeCalls } = createService({
    questionStore: {
      async getRequest(requestID) {
        assert.equal(requestID, "req-question-1");
        return {
          request_id: requestID,
          status: "pending",
          channel_context: {
            chat_id: "chat-question-1",
          },
          questions: [
            {
              question: "Which environment should I use?",
              header: "Environment",
              options: [],
              multiSelect: false,
            },
          ],
        };
      },
      async resolveRequest(requestID, payload) {
        resolved.push({ requestID, payload });
      },
    },
  });

  const handled = await service.handleCommandEvent({
    event_id: "evt-question-1",
    session_id: "chat-question-1",
    msg_id: "msg-question-1",
    sender_id: "sender-question-1",
    content: "/clawpool-question req-question-1 production",
  });

  assert.deepEqual(handled, {
    handled: true,
    kind: "question",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].requestID, "req-question-1");
  assert.deepEqual(resolved[0].payload.answers, {
    "Which environment should I use?": "production",
  });
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_channel_question");
  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].eventID, "evt-question-1");
  assert.equal(finalizeCalls[0].result.code, "question_recorded");

  await service.shutdown();
});

test("worker human loop service dispatches pending approval requests", async () => {
  const dispatched = [];
  const { service, bridgeCalls } = createService({
    approvalStore: {
      async listPendingDispatches() {
        return [
          {
            request_id: "req-pending-1",
            tool_name: "Bash",
            tool_input: { command: "echo hi" },
            permission_suggestions: [],
            channel_context: {
              chat_id: "chat-pending-1",
              message_id: "msg-pending-1",
              msg_id: "msg-pending-1",
            },
          },
        ];
      },
      async markDispatched(requestID, payload) {
        dispatched.push({ requestID, payload });
      },
    },
    bridge: {
      async sendText(payload) {
        bridgeCalls.push(payload);
        return { msg_id: "approval-msg-1" };
      },
    },
  });

  await service.pumpApprovalRequests();

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].sessionID, "chat-pending-1");
  assert.equal(bridgeCalls[0].quotedMessageID, "msg-pending-1");
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_permission_request");
  assert.deepEqual(dispatched, [
    {
      requestID: "req-pending-1",
      payload: {
        dispatchedAt: dispatched[0].payload.dispatchedAt,
        approvalMessageID: "approval-msg-1",
      },
    },
  ]);

  await service.shutdown();
});
