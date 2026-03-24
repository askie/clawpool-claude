import test from "node:test";
import assert from "node:assert/strict";
import { EventState } from "./event-state.js";

test("event state rejects duplicate inbound event ids", () => {
  const state = new EventState();

  const first = state.registerInbound({
    event_id: "evt-1",
    session_id: "sess-1",
    msg_id: "100",
    sender_id: "200",
  });
  assert.equal(first.duplicate, false);

  const second = state.registerInbound({
    event_id: "evt-1",
    session_id: "sess-1",
    msg_id: "100",
    sender_id: "200",
  });
  assert.equal(second.duplicate, true);
});

test("event state records stop, result intent, and completion", () => {
  const state = new EventState();
  state.registerInbound({
    event_id: "evt-2",
    session_id: "sess-2",
    msg_id: "101",
    sender_id: "201",
  });

  state.setResultDeadline("evt-2", { deadlineAt: 4000 });
  state.markStopped("evt-2", {
    stop_id: "stop-1",
    reason: "owner_requested_stop",
  });
  state.setResultIntent("evt-2", {
    status: "canceled",
    code: "owner_requested_stop",
    msg: "owner requested stop",
    updated_at: 4500,
  });

  const stopped = state.get("evt-2");
  assert.equal(stopped.stopped.stop_id, "stop-1");
  assert.equal(stopped.result_deadline_at, 4000);
  assert.equal(stopped.result_intent.status, "canceled");

  state.markCompleted("evt-2", {
    status: "canceled",
    code: "owner_requested_stop",
    msg: "owner requested stop",
  });

  const completed = state.get("evt-2");
  assert.equal(completed.completed.status, "canceled");
  assert.equal(completed.result_deadline_at, 0);
  assert.equal(completed.result_intent, null);
});

test("event state tracks ack, dispatch, and result deadline", () => {
  const state = new EventState();
  state.registerInbound({
    event_id: "evt-3",
    session_id: "sess-3",
    msg_id: "102",
    sender_id: "202",
    owner_id: "302",
    agent_id: "402",
    msg_type: "1",
    created_at: 900,
    mention_user_ids: ["501", "502"],
    attachments_json: "[{\"file_name\":\"demo.txt\"}]",
  });

  state.markAcked("evt-3", { ackedAt: 1000 });
  state.markNotificationDispatched("evt-3", { dispatchedAt: 2000 });
  state.setResultDeadline("evt-3", { deadlineAt: 3000 });
  state.setResultIntent("evt-3", {
    status: "responded",
    code: "ok",
    msg: "done",
    updated_at: 3500,
  });

  const stored = state.get("evt-3");
  assert.equal(stored.acked, true);
  assert.equal(stored.ack_at, 1000);
  assert.equal(stored.notification_dispatched_at, 2000);
  assert.equal(stored.result_deadline_at, 3000);
  assert.equal(stored.result_intent.status, "responded");
  assert.equal(stored.owner_id, "302");
  assert.equal(stored.agent_id, "402");
  assert.equal(stored.msg_type, "1");
  assert.equal(stored.message_created_at, 900);
  assert.deepEqual(stored.mention_user_ids, ["501", "502"]);
  assert.equal(stored.attachments_json, "[{\"file_name\":\"demo.txt\"}]");
});

test("event state enforces pairing resend cooldown", () => {
  const state = new EventState({ pairingCooldownMs: 100 });
  state.registerInbound({
    event_id: "evt-4",
    session_id: "sess-4",
    msg_id: "103",
    sender_id: "203",
  });

  state.markPairingSent("evt-4", { sentAt: 1000, cooldownMs: 100 });
  assert.equal(state.canResendPairing("evt-4", 1050), false);
  assert.equal(state.canResendPairing("evt-4", 1100), true);
});

test("event state keeps unresolved entries longer than completed ones", () => {
  const state = new EventState({
    ttlMs: 100,
    pendingTTLms: 1000,
  });
  state.registerInbound({
    event_id: "evt-5",
    session_id: "sess-5",
    msg_id: "105",
    sender_id: "205",
  });
  state.registerInbound({
    event_id: "evt-6",
    session_id: "sess-6",
    msg_id: "106",
    sender_id: "206",
  });
  state.markCompleted("evt-6", {
    status: "responded",
    updated_at: 1,
  });

  state.prune(Date.now() + 200);

  assert.ok(state.get("evt-5"));
  assert.equal(state.get("evt-6"), null);
});

test("event state returns the latest active entry for a session", () => {
  const state = new EventState();
  state.registerInbound({
    event_id: "evt-7",
    session_id: "sess-7",
    msg_id: "107",
    sender_id: "207",
  });
  state.registerInbound({
    event_id: "evt-8",
    session_id: "sess-7",
    msg_id: "108",
    sender_id: "208",
  });
  state.markCompleted("evt-8", {
    status: "responded",
    updated_at: Date.now(),
  });
  state.registerInbound({
    event_id: "evt-9",
    session_id: "sess-7",
    msg_id: "109",
    sender_id: "209",
  });

  const latest = state.getLatestActiveBySession("sess-7");
  assert.equal(latest?.event_id, "evt-9");
  assert.equal(latest?.msg_id, "109");
});
