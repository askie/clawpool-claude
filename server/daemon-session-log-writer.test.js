import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import test from "node:test";
import { SessionLogWriter } from "./daemon/session-log-writer.js";

test("session log writer writes trace lines into per-session file", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grix-session-log-"));
  const writer = new SessionLogWriter({
    env: {
      GRIX_CLAUDE_DAEMON_DATA_DIR: dataDir,
    },
  });

  const ok = await writer.writeTrace({
    component: "daemon.runtime",
    stage: "worker_spawned",
    session_id: "chat-1",
    worker_id: "worker-1",
    worker_pid: 12345,
  });
  assert.equal(ok, true);

  const logPath = writer.resolveLogPath("chat-1");
  const content = await readFile(logPath, "utf8");
  assert.match(content, /component=daemon.runtime/u);
  assert.match(content, /stage=worker_spawned/u);
  assert.match(content, /session_id=chat-1/u);
  assert.match(content, /worker_id=worker-1/u);
  assert.match(content, /worker_pid=12345/u);
});

test("session log writer serializes concurrent writes for the same session", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grix-session-log-"));
  const writer = new SessionLogWriter({
    env: {
      GRIX_CLAUDE_DAEMON_DATA_DIR: dataDir,
    },
  });

  await Promise.all([
    writer.writeTrace({ session_id: "chat-2", stage: "s1", seq: 1 }),
    writer.writeTrace({ session_id: "chat-2", stage: "s2", seq: 2 }),
    writer.writeTrace({ session_id: "chat-2", stage: "s3", seq: 3 }),
  ]);

  const content = await readFile(writer.resolveLogPath("chat-2"), "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /seq=1/u);
  assert.match(lines[1], /seq=2/u);
  assert.match(lines[2], /seq=3/u);
});

test("session log writer resolves session id from aibot_session_id and sanitizes path", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grix-session-log-"));
  const writer = new SessionLogWriter({
    env: {
      GRIX_CLAUDE_DAEMON_DATA_DIR: dataDir,
    },
  });

  const sessionID = "chat/room 1";
  const ok = await writer.writeTrace({
    component: "daemon.bridge",
    stage: "worker_status_received",
    aibot_session_id: sessionID,
    status: "ready",
  });
  assert.equal(ok, true);

  const logPath = writer.resolveLogPath(sessionID);
  const content = await readFile(logPath, "utf8");
  assert.match(content, /aibot_session_id="chat\/room 1"/u);
  assert.match(content, /status=ready/u);
});

test("session log writer skips trace without session id", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grix-session-log-"));
  const writer = new SessionLogWriter({
    env: {
      GRIX_CLAUDE_DAEMON_DATA_DIR: dataDir,
    },
  });

  const ok = await writer.writeTrace({
    component: "daemon.runtime",
    stage: "event_completed",
    event_id: "evt-1",
  });
  assert.equal(ok, false);
});
