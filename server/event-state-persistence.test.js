import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveEventEntry, loadEventEntries } from "./event-state-persistence.js";

function makeEntry(overrides = {}) {
  const now = Date.now();
  return {
    event_id: "evt-1",
    session_id: "sess-1",
    msg_id: "100",
    quoted_message_id: "",
    sender_id: "sender-1",
    event_type: "user_chat",
    session_type: "1",
    content: "hello",
    owner_id: "owner-1",
    agent_id: "agent-1",
    msg_type: "1",
    message_created_at: now - 500,
    mention_user_ids: ["user-2", "user-3"],
    extra_json: "{\"source\":\"mobile\"}",
    attachments_json: "[{\"media_url\":\"https://cdn.example.com/demo.png\"}]",
    attachment_count: "1",
    biz_card_json: "{\"name\":\"biz\"}",
    channel_data_json: "{\"scope\":\"group\"}",
    acked: true,
    ack_at: now,
    notification_dispatched_at: now,
    pairing_sent_at: 0,
    pairing_retry_after: 0,
    result_deadline_at: now + 60000,
    result_intent: null,
    completed: null,
    stopped: null,
    created_at: now,
    last_seen_at: now,
    ...overrides,
  };
}

test("saveEventEntry and loadEventEntries roundtrip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const entry = makeEntry();

  await saveEventEntry(dir, entry);
  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].event_id, "evt-1");
  assert.equal(loaded[0].session_id, "sess-1");
  assert.equal(loaded[0].acked, true);
  assert.equal(loaded[0].result_deadline_at, entry.result_deadline_at);
  assert.equal(loaded[0].owner_id, "owner-1");
  assert.equal(loaded[0].message_created_at, entry.message_created_at);
  assert.deepEqual(loaded[0].mention_user_ids, ["user-2", "user-3"]);
});

test("loadEventEntries returns empty array for missing dir", async () => {
  const dir = path.join(tmpdir(), `grix-claude-test-nonexistent-${Date.now()}`);
  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);
  assert.equal(loaded.length, 0);
});

test("loadEventEntries filters out expired entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const completedTTLms = 5 * 60 * 1000;
  const expiredLastSeen = Date.now() - completedTTLms - 1000;

  await saveEventEntry(dir, makeEntry({
    last_seen_at: expiredLastSeen,
    completed: { status: "responded", code: "", msg: "", updated_at: Date.now() },
    result_deadline_at: 0,
  }));
  const loaded = await loadEventEntries(dir, {
    completedTTLms,
    pendingTTLms: 48 * 60 * 60 * 1000,
  });
  assert.equal(loaded.length, 0);
});

test("loadEventEntries keeps unresolved entries within pending ttl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const completedTTLms = 5 * 60 * 1000;
  const pendingTTLms = 48 * 60 * 60 * 1000;
  const staleForCompleted = Date.now() - completedTTLms - 1000;

  await saveEventEntry(dir, makeEntry({
    event_id: "evt-pending",
    completed: null,
    last_seen_at: staleForCompleted,
  }));
  const loaded = await loadEventEntries(dir, {
    completedTTLms,
    pendingTTLms,
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].event_id, "evt-pending");
});

test("loadEventEntries skips corrupt JSON files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  await writeFile(path.join(dir, "corrupt.json"), "not json{{{{", "utf8");

  const good = makeEntry({ event_id: "evt-good" });
  await saveEventEntry(dir, good);

  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].event_id, "evt-good");
});

test("loadEventEntries skips files with wrong schema_version", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const filePath = path.join(dir, "old.json");
  await writeFile(filePath, JSON.stringify({ schema_version: 99, event_id: "x", session_id: "y", msg_id: "z" }), "utf8");

  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);
  assert.equal(loaded.length, 0);
});

test("loadEventEntries loads completed entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const now = Date.now();
  const entry = makeEntry({
    event_id: "evt-done",
    result_deadline_at: 0,
    completed: { status: "responded", code: "", msg: "", updated_at: now },
  });

  await saveEventEntry(dir, entry);
  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].completed.status, "responded");
});

test("saveEventEntry overwrites previous entry for same event_id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grix-claude-test-"));
  const now = Date.now();

  await saveEventEntry(dir, makeEntry({ acked: false }));
  await saveEventEntry(dir, makeEntry({ acked: true, ack_at: now }));

  const loaded = await loadEventEntries(dir, 30 * 60 * 1000);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].acked, true);
});
