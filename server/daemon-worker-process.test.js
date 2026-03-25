import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildWorkerClaudeArgs,
  buildWorkerEnvironment,
  createVisibleClaudeLaunchScript,
  WorkerProcessManager,
} from "./daemon/worker-process.js";
import { resolveWorkerLogsDir } from "./daemon/daemon-paths.js";

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
  assert.equal(env.CLAWPOOL_CLAUDE_AIBOT_SESSION_ID, "chat-1");
  assert.equal(env.CLAWPOOL_CLAUDE_SESSION_ID, "claude-1");
  assert.equal(env.CLAWPOOL_CLAUDE_WORKER_ID, "worker-1");
  assert.equal(env.CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL, "http://127.0.0.1:9000");
  assert.equal(env.CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN, "bridge-token");
  assert.equal(env.CLAWPOOL_CLAUDE_WS_URL, "ws://example.com/ws");
  assert.equal(env.CLAWPOOL_CLAUDE_AGENT_ID, "agent-1");
  assert.equal(env.CLAWPOOL_CLAUDE_API_KEY, "secret-key");
  assert.equal(env.CLAWPOOL_CLAUDE_OUTBOUND_TEXT_CHUNK_LIMIT, "2048");
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
  const serverDir = path.join(tempDir, "server");

  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process from "node:process";

process.stdin.once("data", async (chunk) => {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  await writeFile(process.env.TEST_OUTPUT_PATH, data.toString("utf8"), "utf8");
  process.exit(0);
});
`, "utf8");
  await chmod(fakeClaudePath, 0o755);

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      TEST_OUTPUT_PATH: outputPath,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
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

test("spawnWorker allocates a hidden tty for Claude on macOS", async () => {
  if (process.platform !== "darwin") {
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-hidden-tty-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const outputPath = path.join(tempDir, "tty-output.txt");
  const serverDir = path.join(tempDir, "server");

  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process from "node:process";

await writeFile(process.env.TEST_OUTPUT_PATH, process.stdout.isTTY ? "tty" : "notty", "utf8");
`, "utf8");
  await chmod(fakeClaudePath, 0o755);

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      TEST_OUTPUT_PATH: outputPath,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
  });

  await manager.spawnWorker({
    aibotSessionID: "chat-hidden-tty",
    cwd: tempDir,
    pluginDataDir: path.join(tempDir, "plugin-data"),
    claudeSessionID: "claude-hidden-tty",
    workerID: "worker-hidden-tty",
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

  assert.equal(actual, "tty");
});

test("spawnWorker hidden tty does not emit a fake spawn_id error when Claude exits immediately", async () => {
  if (process.platform !== "darwin") {
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-fast-exit-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const serverDir = path.join(tempDir, "server");
  const logsDir = resolveWorkerLogsDir("chat-fast-exit", {
    ...process.env,
    CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
  });

  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  await chmod(fakeClaudePath, 0o755);

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
  });

  await manager.spawnWorker({
    aibotSessionID: "chat-fast-exit",
    cwd: tempDir,
    pluginDataDir: path.join(tempDir, "plugin-data"),
    claudeSessionID: "claude-fast-exit",
    workerID: "worker-fast-exit",
  });

  await sleep(800);

  const stdoutLog = await readFile(path.join(logsDir, "worker-fast-exit.out.log"), "utf8");
  const stderrLog = await readFile(path.join(logsDir, "worker-fast-exit.err.log"), "utf8");
  assert.equal(stdoutLog.includes("spawn id"), false);
  assert.equal(stderrLog.includes("spawn id"), false);
});

test("spawnWorker ensures the user-scoped MCP server before launching Claude", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-mcp-server-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const serverDir = path.join(tempDir, "server");
  const outputPath = path.join(tempDir, "stdin-output.txt");
  const ensured = [];

  await mkdir(serverDir, { recursive: true });
  await writeFile(path.join(serverDir, "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process from "node:process";

process.stdin.once("data", async (chunk) => {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  await writeFile(process.env.TEST_OUTPUT_PATH, data.toString("utf8"), "utf8");
  process.exit(0);
});
`, "utf8");
  await chmod(fakeClaudePath, 0o755);

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      TEST_OUTPUT_PATH: outputPath,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer(input) {
      ensured.push(input);
    },
  });

  await manager.spawnWorker({
    aibotSessionID: "chat-mcp",
    cwd: tempDir,
    pluginDataDir: path.join(tempDir, "plugin-data"),
    claudeSessionID: "claude-mcp",
    workerID: "worker-mcp",
  });

  assert.equal(ensured.length, 1);
  assert.equal(ensured[0].claudeCommand, fakeClaudePath);
  assert.equal(ensured[0].serverCommand, process.execPath);
  assert.deepEqual(ensured[0].serverArgs, [path.join(tempDir, "server", "main.js")]);
  assert.equal(ensured[0].env.CLAWPOOL_CLAUDE_DAEMON_MODE, "1");
  assert.equal(ensured[0].env.CLAWPOOL_CLAUDE_AIBOT_SESSION_ID, "chat-mcp");
});

test("worker process manager can ensure the user-scoped MCP server before any worker starts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-daemon-mcp-server-"));
  const ensured = [];

  await mkdir(path.join(tempDir, "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "dist", "index.js"), "process.exit(0);\n", "utf8");

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: "/tmp/fake-claude",
    },
    packageRoot: tempDir,
    async ensureUserMcpServer(input) {
      ensured.push(input);
    },
  });

  await manager.ensureUserMcpServerConfigured();

  assert.equal(ensured.length, 1);
  assert.equal(ensured[0].claudeCommand, "/tmp/fake-claude");
  assert.equal(ensured[0].serverCommand, process.execPath);
  assert.deepEqual(ensured[0].serverArgs, [path.join(tempDir, "dist", "index.js")]);
});

test("spawnWorker terminates stale visible terminal wrapper processes before relaunch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-stale-visible-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const logsDir = resolveWorkerLogsDir("chat-stale", {
    ...process.env,
    CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
  });
  const stalePIDPath = path.join(logsDir, "old.pid");
  const killed = [];

  await mkdir(path.join(tempDir, "server"), { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(tempDir, "server", "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  await chmod(fakeClaudePath, 0o755);
  await writeFile(stalePIDPath, "113\n", "utf8");

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
    async terminateProcessTree(pid) {
      killed.push(pid);
      return true;
    },
  });

  await manager.spawnWorker({
    aibotSessionID: "chat-stale",
    cwd: tempDir,
    pluginDataDir: path.join(tempDir, "plugin-data"),
    claudeSessionID: "claude-stale",
    workerID: "worker-stale",
  });

  assert.equal(killed.filter((pid) => pid === 113).length, 1);
  assert.equal(killed.length >= 1, true);
  assert.equal(await readFile(stalePIDPath, "utf8"), "");
});

test("spawnWorker serializes concurrent spawns in the same aibot session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-spawn-queue-"));
  const fakeClaudePath = path.join(tempDir, "fake-claude.mjs");
  const logsDir = resolveWorkerLogsDir("chat-spawn-queue", {
    ...process.env,
    CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
  });
  const stalePIDPath = path.join(logsDir, "old.pid");
  const killed = [];

  await mkdir(path.join(tempDir, "server"), { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(tempDir, "server", "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(fakeClaudePath, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  await chmod(fakeClaudePath, 0o755);
  await writeFile(stalePIDPath, "113\n", "utf8");

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAUDE_BIN: fakeClaudePath,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
    async terminateProcessTree(pid) {
      killed.push(pid);
      await sleep(40);
      return true;
    },
  });

  await Promise.all([
    manager.spawnWorker({
      aibotSessionID: "chat-spawn-queue",
      cwd: tempDir,
      pluginDataDir: path.join(tempDir, "plugin-data"),
      claudeSessionID: "claude-spawn-queue-1",
      workerID: "worker-spawn-queue-1",
    }),
    manager.spawnWorker({
      aibotSessionID: "chat-spawn-queue",
      cwd: tempDir,
      pluginDataDir: path.join(tempDir, "plugin-data"),
      claudeSessionID: "claude-spawn-queue-2",
      workerID: "worker-spawn-queue-2",
    }),
  ]);

  assert.equal(killed.filter((pid) => pid === 113).length, 1);
  assert.equal(killed.length >= 1, true);
  assert.equal(await readFile(stalePIDPath, "utf8"), "");
});

test("cleanupStaleManagedProcesses terminates stale Claude processes for bound sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-cleanup-stale-"));
  const logsDirA = resolveWorkerLogsDir("chat-a", {
    ...process.env,
    CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
  });
  const logsDirB = resolveWorkerLogsDir("chat-b", {
    ...process.env,
    CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
  });
  const stalePIDPathA = path.join(logsDirA, "old-a.pid");
  const stalePIDPathB = path.join(logsDirB, "old-b.pid");
  const ignoredPIDPathB = path.join(logsDirB, "bad.pid");
  const killed = [];

  await mkdir(path.join(tempDir, "server"), { recursive: true });
  await mkdir(logsDirA, { recursive: true });
  await mkdir(logsDirB, { recursive: true });
  await writeFile(path.join(tempDir, "server", "main.js"), "process.exit(0);\n", "utf8");
  await writeFile(stalePIDPathA, "212\n", "utf8");
  await writeFile(stalePIDPathB, "214\n", "utf8");
  await writeFile(ignoredPIDPathB, "not-a-pid\n", "utf8");

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
    },
    packageRoot: tempDir,
    async ensureUserMcpServer() {},
    async terminateProcessTree(pid) {
      killed.push(pid);
      return true;
    },
  });

  const terminated = await manager.cleanupStaleManagedProcesses(["chat-a", "chat-b"]);

  assert.deepEqual(terminated, [212, 214]);
  assert.deepEqual(killed, [212, 214]);
  assert.equal(await readFile(stalePIDPathA, "utf8"), "");
  assert.equal(await readFile(stalePIDPathB, "utf8"), "");
  assert.equal(await readFile(ignoredPIDPathB, "utf8"), "not-a-pid\n");
});

test("stopWorker escalates to SIGKILL when graceful stop does not exit in time", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-stop-escalate-"));
  const pidPath = path.join(tempDir, "worker-stop.pid");
  const signals = [];
  const waitCalls = [];
  await writeFile(pidPath, "3456\n", "utf8");

  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
    },
    packageRoot: tempDir,
    async terminateProcessTree(pid, { signal = "SIGTERM" } = {}) {
      signals.push([pid, signal]);
      return true;
    },
    async waitForProcessExit(pid, { timeoutMs = 0 } = {}) {
      waitCalls.push([pid, timeoutMs]);
      return waitCalls.length >= 2;
    },
  });

  manager.runtimes.set("worker-stop", {
    worker_id: "worker-stop",
    pid: 3456,
    pid_path: pidPath,
    status: "ready",
  });

  const stopped = await manager.stopWorker("worker-stop");

  assert.equal(stopped, true);
  assert.deepEqual(signals, [
    [3456, "SIGTERM"],
    [3456, "SIGKILL"],
  ]);
  assert.deepEqual(waitCalls, [
    [3456, 5000],
    [3456, 3000],
  ]);
  assert.equal(await readFile(pidPath, "utf8"), "");
  assert.equal(manager.getWorkerRuntime("worker-stop")?.status, "stopped");
  assert.equal(manager.getWorkerRuntime("worker-stop")?.exit_signal, "SIGKILL");
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
      CLAWPOOL_CLAUDE_AIBOT_SESSION_ID: "chat-visible",
      "npm_package_bin_clawpool-claude": "./bin/clawpool-claude.js",
    },
  });

  const script = await readFile(result.scriptPath, "utf8");
  const expectScript = await readFile(result.expectPath, "utf8");
  assert.match(result.scriptPath, /worker-visible\.launch\.command$/u);
  assert.match(result.expectPath, /worker-visible\.launch\.expect$/u);
  assert.match(result.pidPath, /worker-visible\.pid$/u);
  assert.match(script, /clawpool-claude worker-visible/u);
  assert.match(script, /\/usr\/bin\/env /u);
  assert.doesNotMatch(script, /exec \/usr\/bin\/env /u);
  assert.match(script, /'CLAUDE_PLUGIN_DATA=\/tmp\/plugin data'/u);
  assert.match(script, /'CLAWPOOL_CLAUDE_AIBOT_SESSION_ID=chat-visible'/u);
  assert.match(script, /'npm_package_bin_clawpool-claude=\.\/bin\/clawpool-claude\.js'/u);
  assert.match(script, /\/usr\/bin\/expect '.*worker-visible\.launch\.expect'/u);
  assert.match(script, /cd '\/tmp\/demo path'/u);
  assert.match(script, /current_tty=\$\(tty 2>\/dev\/null \|\| true\)/u);
  assert.match(script, /\/usr\/bin\/osascript - "\$current_tty"/u);
  assert.match(script, /if tty of t is targetTTY then/u);
  assert.match(script, /close t/u);
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

test("createVisibleClaudeLaunchScript can skip expect log capture for hidden tty launches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-hidden-launch-script-"));
  const logsDir = path.join(tempDir, "logs");
  const result = await createVisibleClaudeLaunchScript({
    logsDir,
    workerID: "worker-hidden",
    cwd: "/tmp/demo path",
    command: "/usr/local/bin/claude",
    args: ["--session-id", "session-2"],
    env: {},
    captureOutputInExpectLog: false,
  });

  const expectScript = await readFile(result.expectPath, "utf8");
  assert.doesNotMatch(expectScript, /log_file -a/u);
});

test("worker process manager detects missing Claude session resume failure from logs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-resume-error-"));
  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
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

test("worker process manager detects Claude auth login required failure from logs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clawpool-worker-auth-error-"));
  const manager = new WorkerProcessManager({
    env: {
      ...process.env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: tempDir,
      CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "0",
    },
    packageRoot: tempDir,
  });

  manager.runtimes.set("worker-auth-expired", {
    worker_id: "worker-auth-expired",
    stdout_log_path: path.join(tempDir, "worker-auth-expired.out.log"),
    stderr_log_path: path.join(tempDir, "worker-auth-expired.err.log"),
  });
  await writeFile(
    path.join(tempDir, "worker-auth-expired.err.log"),
    "Please run /login · API Error: 401\n",
    "utf8",
  );

  assert.equal(await manager.hasAuthLoginRequiredError("worker-auth-expired"), true);
});
