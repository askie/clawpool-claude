import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  claudeSessionExists,
  encodeClaudeProjectPath,
  resolveClaudeSessionPath,
} from "./daemon/claude-session-store.js";

test("encodeClaudeProjectPath maps cwd to Claude project key", () => {
  assert.equal(
    encodeClaudeProjectPath("/tmp/demo/project"),
    "-tmp-demo-project",
  );
});

test("resolveClaudeSessionPath points to Claude project session jsonl", () => {
  assert.equal(
    resolveClaudeSessionPath({
      cwd: "/tmp/demo/project",
      claudeSessionID: "session-123",
      env: { HOME: "/Users/tester" },
    }),
    path.join("/Users/tester", ".claude", "projects", "-tmp-demo-project", "session-123.jsonl"),
  );
});

test("claudeSessionExists checks the real Claude session file location", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-home-"));
  const cwd = "/tmp/real/project";
  const claudeSessionID = "session-real";
  const sessionPath = resolveClaudeSessionPath({
    cwd,
    claudeSessionID,
    env: { HOME: homeDir },
  });
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, "{\"type\":\"message\"}\n", "utf8");

  assert.equal(
    await claudeSessionExists({
      cwd,
      claudeSessionID,
      env: { HOME: homeDir },
    }),
    true,
  );
  assert.equal(
    await claudeSessionExists({
      cwd,
      claudeSessionID: "missing-session",
      env: { HOME: homeDir },
    }),
    false,
  );
});
