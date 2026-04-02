import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  buildHookSignalEvent,
  HookSignalStore,
  resolveHookSignalsLogPathFromDataDir,
  summarizeHookSignalEvent,
} from "./hook-signal-store.js";

test("buildHookSignalEvent derives safe hook summaries", () => {
  const toolEvent = buildHookSignalEvent({
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    session_id: "chat-1",
  }, { recordedAt: 101 });
  assert.equal(toolEvent?.hook_event_name, "PostToolUse");
  assert.equal(toolEvent?.detail, "Edit");
  assert.equal(toolEvent?.event_at, 101);

  const sessionEvent = buildHookSignalEvent({
    hook_event_name: "SessionStart",
    source: "resume",
  }, { recordedAt: 202 });
  assert.equal(sessionEvent?.detail, "resume");

  assert.equal(
    summarizeHookSignalEvent(toolEvent),
    "PostToolUse:Edit",
  );
  assert.equal(
    summarizeHookSignalEvent(sessionEvent),
    "SessionStart:resume",
  );
});

test("hook signal store records latest event and recent ring", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-hook-signal-store-"));
  const store = new HookSignalStore(path.join(dir, "hook-signals.json"));

  await store.recordHookEvent({
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: "chat-1",
  }, {
    recordedAt: 100,
    recentEventLimit: 2,
  });
  await store.recordHookEvent({
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    session_id: "chat-1",
  }, {
    recordedAt: 200,
    recentEventLimit: 2,
  });
  const state = await store.recordHookEvent({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    session_id: "chat-1",
  }, {
    recordedAt: 300,
    recentEventLimit: 2,
  });

  assert.equal(state.updated_at, 300);
  assert.equal(state.latest_event?.hook_event_name, "PostToolUseFailure");
  assert.equal(state.latest_event?.detail, "Bash");
  assert.equal(state.recent_events.length, 2);
  assert.deepEqual(
    state.recent_events.map((item) => item.hook_event_name),
    ["PostToolUse", "PostToolUseFailure"],
  );
  const logContent = await readFile(
    resolveHookSignalsLogPathFromDataDir(dir),
    "utf8",
  );
  assert.match(logContent, /stage=hook_signal_recorded/u);
  assert.match(logContent, /hook_event_name=PostToolUseFailure/u);
  assert.match(logContent, /hook_detail=Bash/u);

  const reset = await store.reset();
  assert.equal(reset.latest_event, null);
  assert.deepEqual(reset.recent_events, []);
});
