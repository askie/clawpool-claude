import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolveHookSignalsLogPathFromDataDir } from "./hook-signal-store.js";

test("user prompt submit hook records signal without writing Claude context output", async () => {
  const pluginDataDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-user-prompt-hook-"));
  const scriptPath = path.join(process.cwd(), "scripts", "user-prompt-submit-hook.js");

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
    },
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "plain text without clawpool tag",
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");

  const state = JSON.parse(
    await readFile(path.join(pluginDataDir, "hook-signals.json"), "utf8"),
  );
  assert.equal(state.latest_event?.hook_event_name, "UserPromptSubmit");
  assert.equal(state.recent_events?.length, 1);
  const logContent = await readFile(
    resolveHookSignalsLogPathFromDataDir(pluginDataDir),
    "utf8",
  );
  assert.match(logContent, /hook_event_name=UserPromptSubmit/u);
});
