import assert from "node:assert/strict";
import test from "node:test";
import { WorkerElicitationRelayService } from "./worker/elicitation-relay-service.js";

function createLogger() {
  return {
    info() {},
    error() {},
    debug() {},
  };
}

function createService({
  elicitationStore = {},
  bridge = {},
} = {}) {
  const finalizeCalls = [];
  const bridgeCalls = [];
  const service = new WorkerElicitationRelayService({
    elicitationStore: {
      async getRequest() {
        return null;
      },
      async resolveRequest() {},
      async listPendingDispatches() {
        return [];
      },
      async markDispatched() {},
      async markDispatchFailed() {},
      ...elicitationStore,
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

test("worker elicitation relay service records answers", async () => {
  const resolved = [];
  const { service, finalizeCalls, bridgeCalls } = createService({
    elicitationStore: {
      async getRequest(requestID) {
        assert.equal(requestID, "req-elicitation-1");
        return {
          request_id: requestID,
          status: "pending",
          channel_context: {
            chat_id: "chat-elicitation-1",
          },
          fields: [
            {
              key: "environment",
              title: "Environment",
              prompt: "Choose an environment.",
              type: "string",
              kind: "enum",
              options: ["production", "staging"],
              multi_select: false,
            },
          ],
          questions: [
            {
              question: "Choose an environment.",
              header: "Environment",
              options: [{ label: "production" }, { label: "staging" }],
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
    event_id: "evt-elicitation-1",
    session_id: "chat-elicitation-1",
    msg_id: "msg-elicitation-1",
    sender_id: "sender-elicitation-1",
    content: "/clawpool-question req-elicitation-1 production",
  });

  assert.deepEqual(handled, {
    handled: true,
    kind: "elicitation",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].requestID, "req-elicitation-1");
  assert.equal(resolved[0].payload.action, "accept");
  assert.deepEqual(resolved[0].payload.content, {
    environment: "production",
  });
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_channel_question");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.category, "question");
  assert.equal(finalizeCalls[0].result.code, "elicitation_recorded");

  await service.shutdown();
});

test("worker elicitation relay service dispatches pending requests with structured card payload", async () => {
  const dispatched = [];
  const { service, bridgeCalls } = createService({
    elicitationStore: {
      async listPendingDispatches() {
        return [
          {
            request_id: "req-elicitation-pending-1",
            message: "Please confirm deploy settings.",
            fields: [
              {
                key: "environment",
                title: "Environment",
                prompt: "Choose an environment.",
                type: "string",
                kind: "enum",
                options: ["production", "staging"],
                multi_select: false,
              },
              {
                key: "targets",
                title: "Targets",
                prompt: "Choose one or more targets.",
                type: "array",
                kind: "enum_array",
                options: ["api", "worker"],
                multi_select: true,
              },
            ],
            questions: [
              {
                header: "Environment",
                question: "Choose an environment.",
                options: [
                  { label: "production" },
                  { label: "staging" },
                ],
                multiSelect: false,
              },
              {
                header: "Targets",
                question: "Choose one or more targets.",
                options: [
                  { label: "api" },
                  { label: "worker" },
                ],
                multiSelect: true,
              },
            ],
            channel_context: {
              chat_id: "chat-elicitation-pending-1",
              message_id: "msg-elicitation-pending-1",
              msg_id: "msg-elicitation-pending-1",
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
        return { msg_id: "elicitation-msg-1" };
      },
    },
  });

  await service.pumpRequests();

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].sessionID, "chat-elicitation-pending-1");
  assert.equal(bridgeCalls[0].quotedMessageID, "msg-elicitation-pending-1");
  assert.equal(bridgeCalls[0].extra.reply_source, "claude_elicitation");
  assert.equal(bridgeCalls[0].extra.biz_card.version, 1);
  assert.equal(bridgeCalls[0].extra.biz_card.type, "claude_question");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.request_id, "req-elicitation-pending-1");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.answer_command_hint, "");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.questions.length, 2);
  assert.equal(bridgeCalls[0].extra.biz_card.payload.questions[0].options[0], "production");
  assert.equal(bridgeCalls[0].extra.biz_card.payload.questions[1].multi_select, true);
  assert.deepEqual(dispatched, [
    {
      requestID: "req-elicitation-pending-1",
      payload: {
        dispatchedAt: dispatched[0].payload.dispatchedAt,
        promptMessageID: "elicitation-msg-1",
      },
    },
  ]);

  await service.shutdown();
});
