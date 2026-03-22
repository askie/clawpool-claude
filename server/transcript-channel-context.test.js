import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  extractLatestClawpoolChannelContext,
  resolveTranscriptClawpoolChannelContext,
} from "./transcript-channel-context.js";

test("extracts latest clawpool-claude channel context from transcript jsonl", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-transcript-"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: "hello" }),
    JSON.stringify({
      type: "user",
      message:
        '<channel source="clawpool-claude" chat_id="chat-1" event_id="evt-1" message_id="msg-1" sender_id="u-1">first</channel>',
    }),
    JSON.stringify({
      type: "user",
      message:
        '<channel source="clawpool-claude" chat_id="chat-2" event_id="evt-2" message_id="msg-2" sender_id="u-2" msg_id="msg-2">second</channel>',
    }),
  ].join("\n");
  await writeFile(transcriptPath, `${lines}\n`, "utf8");

  const context = await extractLatestClawpoolChannelContext(transcriptPath);
  assert.deepEqual(context, {
    raw_tag:
      '<channel source="clawpool-claude" chat_id="chat-2" event_id="evt-2" message_id="msg-2" sender_id="u-2" msg_id="msg-2">',
    chat_id: "chat-2",
    event_id: "evt-2",
    message_id: "msg-2",
    sender_id: "u-2",
    user_id: "",
    msg_id: "msg-2",
  });
});

test("transcript fallback refuses ambiguous multi-chat transcripts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-transcript-"));
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

  const resolution = await resolveTranscriptClawpoolChannelContext(transcriptPath);
  assert.equal(resolution.status, "ambiguous");
  assert.deepEqual(resolution.unique_chat_ids, ["chat-1", "chat-2"]);
  assert.equal(resolution.context, null);
});
