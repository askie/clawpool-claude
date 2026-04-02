import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { ChannelContextStore } from "./channel-context-store.js";

test("channel context store persists and matches by session and transcript", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-session-context-"));
  const store = new ChannelContextStore(dir);

  await store.put({
    session_id: "session-1",
    transcript_path: "/tmp/transcript-1.jsonl",
    cwd: "/repo/a",
    updated_at: Date.now(),
    context: {
      chat_id: "chat-1",
      event_id: "evt-1",
      message_id: "msg-1",
      sender_id: "u-1",
    },
  });

  const matched = await store.getMatchingContext({
    sessionID: "session-1",
    transcriptPath: "/tmp/transcript-1.jsonl",
    workingDir: "/repo/a",
    maxAgeMs: 60_000,
  });
  assert.equal(matched.chat_id, "chat-1");

  const mismatched = await store.getMatchingContext({
    sessionID: "session-1",
    transcriptPath: "/tmp/transcript-2.jsonl",
    workingDir: "/repo/a",
    maxAgeMs: 60_000,
  });
  assert.equal(mismatched, null);
});

test("channel context store exposes mismatch and stale inspection states", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-session-context-"));
  const store = new ChannelContextStore(dir);

  await store.put({
    session_id: "session-2",
    transcript_path: "/tmp/transcript-2.jsonl",
    cwd: "/repo/b",
    updated_at: Date.now() - 120_000,
    context: {
      chat_id: "chat-2",
      event_id: "evt-2",
      message_id: "msg-2",
      sender_id: "u-2",
    },
  });

  const mismatched = await store.inspectMatchingContext({
    sessionID: "session-2",
    transcriptPath: "/tmp/transcript-3.jsonl",
    workingDir: "/repo/b",
    maxAgeMs: 60_000,
  });
  assert.equal(mismatched.status, "transcript_mismatch");

  const cwdMismatched = await store.inspectMatchingContext({
    sessionID: "session-2",
    transcriptPath: "/tmp/transcript-2.jsonl",
    workingDir: "/repo/c",
    maxAgeMs: 300_000,
  });
  assert.equal(cwdMismatched.status, "cwd_mismatch");

  const stale = await store.inspectMatchingContext({
    sessionID: "session-2",
    transcriptPath: "/tmp/transcript-2.jsonl",
    workingDir: "/repo/b",
    maxAgeMs: 60_000,
  });
  assert.equal(stale.status, "stale");
});
