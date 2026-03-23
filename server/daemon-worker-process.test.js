import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildWorkerClaudeArgs,
  buildWorkerEnvironment,
  createVisibleClaudeLaunchScript,
  WorkerProcessManager,
} from "./daemon/worker-process.js";

test("buildWorkerEnvironment passes daemon connection config to worker", () => {
  const env = buildWorkerEnvironment({
    baseEnv: { PATH: "/usr/bin" },
    pluginDataDir: "/tmp/plugin-data",
    aibotSessionID: "chat-1",
    claudeSessionID: "claude-1",
    workerID: "worker-1",
    bridgeURL: "http://127.0.0.1:9000",
    bridgeToken: "bridge-token",
    connectionConfig: {
      wsURL: "ws://example.com/ws",
      agentID: "agent-1",
      apiKey: "secret-key",
      outboundTextChunkLimit: 2048,
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CLAUDE_PLUGIN_DATA, "/tmp/plugin-data");
  assert.equal(env.CLAWPOOL_AIBOT_SESSION_ID, "chat-1");
  assert.equal(env.CLAWPOOL_CLAUDE_SESSION_ID, "claude-1");
  assert.equal(env.CLAWPOOL_WORKER_ID, "worker-1");
  assert.equal(env.CLAWPOOL_DAEMON_BRIDGE_URL, "http://127.0.0.1:9000");
  assert.equal(env.CLAWPOOL_DAEMON_BRIDGE_TOKEN, "bridge-token");
  assert.equal(env.CLAWPOOL_WS_URL, "ws://example.com/ws");
  assert.equal(env.CLAWPOOL_AGENT_ID, "agent-1");
  assert.equal(env.CLAWPOOL_API_KEY, "secret-key");
  assert.equal(env.CLAWPOOL_OUTBOUND_TEXT_CHUNK_LIMIT, "2048");
});

test("buildWorkerClaudeArgs launches Claude with plugin-dir development channel args", () => {
  assert.deepEqual(
    buildWorkerClaudeArgs({
      packageRoot: "/tmp/clawpool-claude-plugin",
      aibotSessionID: "chat-1",
      claudeSessionID: "claude-1",
    }),
    [
      "--name",
      "clawpool-chat-1",
      "--plugin-dir",
      "/tmp/clawpool-claude-plugin",
      "--dangerously-skip-permissions",
      "--session-id",
      "claude-1",
      "--dangerously-load-development-channels",
      "server:clawpool-claude",
    ],
  );
});

test("buildWorkerClaudeArgs resumes an existing Claude session by id", () => {
  assert.deepEqual(
    buildWorkerClaudeArgs({
      packageRoot: "/tmp/clawpool-claude-plugin",
      aibotSessionID: "chat-1",
      claudeSessionID: "claude-1",
      resumeSession: true,
    }),
    [
      "--name",
      "clawpool-chat-1",
      "--plugin-dir",
      "/tmp/clawpool-claude-plugin",
      "--dangerously-skip-permissions",
      "--resume",
      "claude-1",
      "--dangerously-load-development-channels",
      "server:clawpool-claude",
    ],
  );
});

test("spawnWorker feeds a startup enter key to Claude stdin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-startup-input-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const outputPath = path.join(tempDir, "stdin-output.txt");

  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
}
await writeFile(process.env.TEST_OUTPUT_PATH, Buffer.concat(chunks).toString("utf8"), "utf8");
`, "utf8");
  await chmod(fakeClaudePath, 0o755);

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_SHOW_CLAUDE_WINDOW: "0",
      TEST_OUTPUT_PATH: outputPath,
    },
    packageRoot: tempDir,
  });

  await manager.spawnWorker({
    aibotSessionID: "chat-startup-enter",
    cwd: tempDir,
    pluginDataDir: path.join(tempDir, "plugin-data"),
    claudeSessionID: "claude-startup-enter",
    workerID: "worker-startup-enter",
  });

  let actual = "";
  for (let index = 0; index < 100; index += 1) {
    try {
      actual = await readFile(outputPath, "utf8");
      break;
    } catch {
      await sleep(100);
    }
  }

  assert.equal(actual, "\n");
});

test("createVisibleClaudeLaunchScript writes terminal launch wrapper with Claude pid file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-visible-launch-script-"));
  const logsDir = path.join(tempDir, "logs");
  const result = await createVisibleClaudeLaunchScript({
    logsDir,
    workerID: "worker-visible",
    cwd: "/tmp/demo path",
    command: "/usr/local/bin/claude",
    args: [
      "--name",
      "clawpool-chat-visible",
      "--plugin-dir",
      "/tmp/clawpool-claude-plugin",
      "--dangerously-skip-permissions",
      "--session-id",
      "session-1",
      "--dangerously-load-development-channels",
      "server:clawpool-claude",
    ],
    env: {
      CLAUDE_PLUGIN_DATA: "/tmp/plugin data",
      CLAWPOOL_AIBOT_SESSION_ID: "chat-visible",
      "npm_package_bin_clawpool-claude": "./bin/clawpool-claude.js",
    },
  });

  const script = await readFile(result.scriptPath, "utf8");
  const expectScript = await readFile(result.expectPath, "utf8");
  assert.match(result.scriptPath, /worker-visible\.launch\.command$/u);
  assert.match(result.expectPath, /worker-visible\.launch\.expect$/u);
  assert.match(result.pidPath, /worker-visible\.pid$/u);
  assert.match(script, /clawpool-claude worker-visible/u);
  assert.match(script, /exec \/usr\/bin\/env /u);
  assert.match(script, /'CLAUDE_PLUGIN_DATA=\/tmp\/plugin data'/u);
  assert.match(script, /'CLAWPOOL_AIBOT_SESSION_ID=chat-visible'/u);
  assert.match(script, /'npm_package_bin_clawpool-claude=\.\/bin\/clawpool-claude\.js'/u);
  assert.match(script, /\/usr\/bin\/expect '.*worker-visible\.launch\.expect'/u);
  assert.match(script, /cd '\/tmp\/demo path'/u);
  assert.match(expectScript, /set timeout -1/u);
  assert.match(expectScript, /log_file -a \{.*worker-visible\.out\.log\}/u);
  assert.match(expectScript, /spawn -noecho \{\*\}\$claude_command/u);
  assert.match(expectScript, /set pid_file \[open \{.*worker-visible\.pid\} w\]/u);
  assert.match(expectScript, /puts \$pid_file \[exp_pid -i \$spawn_id\]/u);
  assert.match(expectScript, /after 500/u);
  assert.match(expectScript, /-re \{Enter\.\*confirm\}/u);
  assert.match(expectScript, /send -- "\\r"/u);
  assert.match(expectScript, /exp_continue/u);
  assert.match(expectScript, /set claude_command \[list \{\/usr\/local\/bin\/claude\} \{--name\} \{clawpool-chat-visible\} \{--plugin-dir\} \{\/tmp\/clawpool-claude-plugin\} \{--dangerously-skip-permissions\} \{--session-id\} \{session-1\} \{--dangerously-load-development-channels\} \{server:clawpool-claude\}\]/u);
  assert.equal(await readFile(result.pidPath, "utf8"), "");
});

test("worker process manager detects missing Claude session resume failure from logs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-resume-error-"));
  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_DAEMON_DATA_DIR: tempDir,
      CLAWPOOL_SHOW_CLAUDE_WINDOW: "0",
    },
    packageRoot: tempDir,
  });

  manager.runtimes.set("worker-missing-session", {
    worker_id: "worker-missing-session",
    stdout_log_path: path.join(tempDir, "missing-session.out.log"),
    stderr_log_path: path.join(tempDir, "missing-session.err.log"),
  });
  await writeFile(
    path.join(tempDir, "missing-session.out.log"),
    "No conversation found with session ID: test-session\n",
    "utf8",
  );

  assert.equal(await manager.hasMissingResumeSessionError("worker-missing-session"), true);
});
