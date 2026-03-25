import assert from "node:assert/strict";
import test from "node:test";
import {
  createProcessLogger,
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

test("createProcessLogger trace callback runs even when stderr trace is disabled", () => {
  const calls = [];
  const logger = createProcessLogger({
    env: {},
    onTrace(fields, { level }) {
      calls.push({ fields, level });
    },
  });

  logger.trace({
    component: "daemon.runtime",
    stage: "event_received",
    session_id: "chat-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "info");
  assert.equal(calls[0].fields.session_id, "chat-1");
});
