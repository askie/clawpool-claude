import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ApprovalStore } from "./approval-store.js";

test("approval store creates resolves and summarizes requests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-approval-store-"));
  const store = new ApprovalStore({
    requestsDir: path.join(dir, "requests"),
    notificationsDir: path.join(dir, "notifications"),
  });
  await store.init();

  await store.createPermissionRequest({
    request_id: "req-1",
    session_id: "claude-session-1",
    transcript_path: "/tmp/transcript.jsonl",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/demo" },
    permission_suggestions: [{ tool: "Bash", rule: "demo" }],
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
    approvalMessageID: "5001",
  });

  const dispatched = await store.getRequest("req-1");
  assert.equal(dispatched.dispatched_at, 1234);
  assert.equal(dispatched.approval_message_id, "5001");

  await store.resolveRequest("req-1", {
    decision: {
      behavior: "allow",
      updatedPermissions: [{ tool: "Bash", rule: "demo" }],
    },
    resolvedBy: {
      sender_id: "u-1",
      session_id: "chat-1",
      event_id: "evt-approval-1",
      msg_id: "msg-approval-1",
    },
  });

  const resolved = await store.getRequest("req-1");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision.behavior, "allow");
  assert.equal(resolved.resolved_by.sender_id, "u-1");

  status = await store.getStatus();
  assert.equal(status.pending_count, 0);
  assert.equal(status.resolved_count, 1);
});
