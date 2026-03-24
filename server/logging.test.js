import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTraceLine,
  isTraceLoggingEnabled,
} from "./logging.js";

test("formatTraceLine renders searchable key value pairs", () => {
  const line = formatTraceLine({
    component: "daemon.runtime",
    stage: "event_received",
    event_id: "evt-1",
    session_id: "chat-1",
    msg_id: "msg-1",
    sender_id: "sender-1",
  });

  assert.match(line, /^trace /u);
  assert.match(line, /component=daemon.runtime/u);
  assert.match(line, /stage=event_received/u);
  assert.match(line, /event_id=evt-1/u);
  assert.match(line, /session_id=chat-1/u);
  assert.match(line, /msg_id=msg-1/u);
  assert.match(line, /sender_id=sender-1/u);
});

test("isTraceLoggingEnabled accepts explicit trace switch and debug switch", () => {
  assert.equal(isTraceLoggingEnabled({ CLAWPOOL_CLAUDE_TRACE_LOG: "1" }), true);
  assert.equal(isTraceLoggingEnabled({ CLAWPOOL_CLAUDE_E2E_DEBUG: "1" }), true);
  assert.equal(isTraceLoggingEnabled({}), false);
});
