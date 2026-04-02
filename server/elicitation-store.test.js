import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ElicitationStore } from "./elicitation-store.js";

test("elicitation store creates resolves and summarizes requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-elicitation-store-"));
  const store = new ElicitationStore({
    requestsDir: path.join(dir, "requests"),
  });
  await store.init();

  await store.createRequest({
    request_id: "req-1",
    session_id: "claude-session-1",
    transcript_path: "/tmp/transcript.jsonl",
    mcp_server_name: "deploy-server",
    elicitation_id: "elicit-1",
    message: "Please confirm deploy settings.",
    mode: "form",
    requested_schema: {
      type: "object",
      required: ["environment"],
      properties: {
        environment: {
          type: "string",
          title: "Environment",
          enum: ["prod", "staging"],
        },
      },
    },
    fields: [
      {
        key: "environment",
        title: "Environment",
        prompt: "Choose an environment. Choose one of the listed options.",
        type: "string",
        kind: "enum",
        options: ["prod", "staging"],
        multi_select: false,
      },
    ],
    channel_context: {
      chat_id: "chat-1",
      event_id: "evt-1",
      message_id: "msg-1",
      sender_id: "u-1",
    },
  });

  let status = await store.getStatus();
  assert.equal(status.pending_count, 1);

  await store.markDispatched("req-1", {
    dispatchedAt: 1234,
    promptMessageID: "5001",
  });

  const dispatched = await store.getRequest("req-1");
  assert.equal(dispatched.dispatched_at, 1234);
  assert.equal(dispatched.prompt_message_id, "5001");
  assert.equal(dispatched.questions[0].header, "Environment");

  await store.resolveRequest("req-1", {
    action: "accept",
    content: {
      environment: "prod",
    },
    resolvedBy: {
      sender_id: "u-1",
      session_id: "chat-1",
      event_id: "evt-question-1",
      msg_id: "msg-question-1",
    },
  });

  const resolved = await store.getRequest("req-1");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.response_action, "accept");
  assert.equal(resolved.response_content.environment, "prod");
  assert.equal(resolved.resolved_by.sender_id, "u-1");

  status = await store.getStatus();
  assert.equal(status.pending_count, 0);
  assert.equal(status.resolved_count, 1);
});
