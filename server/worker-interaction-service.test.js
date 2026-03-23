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
