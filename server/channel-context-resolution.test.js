import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { ChannelContextStore } from "./channel-context-store.js";
import { resolveHookChannelContext } from "./channel-context-resolution.js";

test("hook channel context resolver prefers stored session context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-context-resolution-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  await writeFile(transcriptPath, "", "utf8");

  const store = new ChannelContextStore(dir);
  await store.put({
    session_id: "session-1",
    transcript_path: transcriptPath,
    cwd: "/repo/a",
    updated_at: Date.now(),
    context: {
      chat_id: "chat-1",
      event_id: "evt-1",
      message_id: "msg-1",
      sender_id: "u-1",
    },
  });

  const resolution = await resolveHookChannelContext({
    sessionContextStore: store,
    sessionID: "session-1",
    transcriptPath,
    workingDir: "/repo/a",
    maxAgeMs: 60_000,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.source, "session_context");
  assert.equal(resolution.context.chat_id, "chat-1");
});

test("hook channel context resolver allows transcript fallback for a single clawpool-claude chat", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-context-resolution-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message:
        '<channel source="clawpool-claude" chat_id="chat-9" event_id="evt-9" message_id="msg-9" sender_id="u-9">hello</channel>',
    }),
    JSON.stringify({ type: "assistant", message: "ok" }),
  ].join("\n");
  await writeFile(transcriptPath, `${lines}\n`, "utf8");

  const store = new ChannelContextStore(path.join(dir, "contexts"));
  const resolution = await resolveHookChannelContext({
    sessionContextStore: store,
    sessionID: "session-9",
    transcriptPath,
    workingDir: "/repo/a",
    maxAgeMs: 60_000,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.source, "transcript_fallback");
  assert.equal(resolution.context.chat_id, "chat-9");
});

test("hook channel context resolver refuses ambiguous transcript fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-context-resolution-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      message:
        '<channel source="clawpool-claude" chat_id="chat-1" event_id="evt-1" message_id="msg-1" sender_id="u-1">first</channel>',
    }),
    JSON.stringify({
      type: "user",
      message:
        '<channel source="clawpool-claude" chat_id="chat-2" event_id="evt-2" message_id="msg-2" sender_id="u-2">second</channel>',
    }),
  ].join("\n");
  await writeFile(transcriptPath, `${lines}\n`, "utf8");

  const store = new ChannelContextStore(path.join(dir, "contexts"));
  const resolution = await resolveHookChannelContext({
    sessionContextStore: store,
    sessionID: "session-10",
    transcriptPath,
    workingDir: "/repo/a",
    maxAgeMs: 60_000,
  });
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.reason, "transcript_ambiguous");
});

test("hook channel context resolver rejects stored context from a different working directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-context-resolution-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  await writeFile(transcriptPath, "", "utf8");

  const store = new ChannelContextStore(dir);
  await store.put({
    session_id: "session-11",
    transcript_path: transcriptPath,
    cwd: "/repo/a",
    updated_at: Date.now(),
    context: {
      chat_id: "chat-11",
      event_id: "evt-11",
      message_id: "msg-11",
      sender_id: "u-11",
    },
  });

  const resolution = await resolveHookChannelContext({
    sessionContextStore: store,
    sessionID: "session-11",
    transcriptPath,
    workingDir: "/repo/b",
    maxAgeMs: 60_000,
  });
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.reason, "session_context_cwd_mismatch");
});
