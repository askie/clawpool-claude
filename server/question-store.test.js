import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { QuestionStore } from "./question-store.js";

test("question store creates resolves and summarizes requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-question-store-"));
  const store = new QuestionStore({
    requestsDir: path.join(dir, "requests"),
  });
  await store.init();

  await store.createQuestionRequest({
    request_id: "req-1",
    session_id: "claude-session-1",
    transcript_path: "/tmp/transcript.jsonl",
    questions: [
      {
        header: "Environment",
        question: "Which environment should I use?",
        options: [{ label: "prod", description: "production" }],
        multiSelect: false,
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
    questionMessageID: "5001",
  });

  const dispatched = await store.getRequest("req-1");
  assert.equal(dispatched.dispatched_at, 1234);
  assert.equal(dispatched.question_message_id, "5001");

  await store.resolveRequest("req-1", {
    answers: {
      "Which environment should I use?": "prod",
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
  assert.equal(resolved.answers["Which environment should I use?"], "prod");
  assert.equal(resolved.resolved_by.sender_id, "u-1");

  status = await store.getStatus();
  assert.equal(status.pending_count, 0);
  assert.equal(status.resolved_count, 1);
});
