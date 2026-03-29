import { chmod, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { resolvePackageRoot, resolveServerEntryPath } from "../../cli/config.js";
import { ensureUserMcpServer as defaultEnsureUserMcpServer } from "../../cli/mcp.js";
import { resolveWorkerLogsDir } from "./daemon-paths.js";
import { HookSignalStore } from "../hook-signal-store.js";
import {
  terminateProcessTree as defaultTerminateProcessTree,
  waitForProcessExit as defaultWaitForProcessExit,
} from "../process-control.js";

const missingResumeSessionPattern = /No conversation found with session ID:/u;
const authLoginRequiredPatterns = [
  /Please run \/login/u,
  /API Error:\s*401/u,
  /authentication_error/u,
  /OAuth token has expired/u,
];
const extraUsageLimitPatterns = [
  /You're out of extra usage/iu,
  /Stop and wait for limit to reset/iu,
  /Add funds to continue with extra usage/iu,
];
const defaultUsageLimitTailScanBytes = 128 * 1024;
const defaultUsageLimitCursorScanBytes = 512 * 1024;
const startupPromptAutoConfirmPattern = /\[clawpool\]\s+startup_prompt_auto_confirm/u;
const startupChannelListeningPatterns = [
  /\[clawpool\]\s+startup_channel_listening/u,
  /Listening\s+for\s+channel\s+messages\s+from:\s*server:clawpool-claude/u,
];
const startupMcpServerFailedPatterns = [
  /\[clawpool\]\s+startup_mcp_server_failed/u,
  /MCP\s+server\s+failed/u,
];
const startupMcpServerFailedMarkerPattern = /\[clawpool\]\s+startup_mcp_server_failed/u;

function stripTerminalControlSequences(content) {
  return String(content ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, " ")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/\r/g, "\n");
}

function patternMatches(pattern, content) {
  if (!(pattern instanceof RegExp)) {
    return false;
  }
  pattern.lastIndex = 0;
  return pattern.test(content);
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeNonNegativeOffset(value) {
  const normalized = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return normalized;
}

function normalizePositiveInt(value, fallback = 0) {
  const normalized = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return Math.max(0, Math.floor(Number(fallback ?? 0)));
  }
  return normalized;
}

async function readLogSlice(filePath, {
  startOffset = 0,
  maxBytes = 0,
} = {}) {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) {
    return "";
  }
  let fileSize = 0;
  try {
    const info = await stat(normalizedPath);
    fileSize = normalizeNonNegativeOffset(info?.size);
  } catch {
    return "";
  }
  if (fileSize <= 0) {
    return "";
  }
  let start = Math.min(normalizeNonNegativeOffset(startOffset), fileSize);
  const normalizedMaxBytes = normalizePositiveInt(maxBytes, 0);
  if (normalizedMaxBytes > 0 && fileSize - start > normalizedMaxBytes) {
    start = fileSize - normalizedMaxBytes;
  }
  const bytesToRead = fileSize - start;
  if (bytesToRead <= 0) {
    return "";
  }
  const handle = await open(normalizedPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead = 0 } = await handle.read(buffer, 0, bytesToRead, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

function resolveClaudeCommand(env = process.env) {
  if (process.platform === "win32") {
    return env.CLAUDE_BIN || "claude.cmd";
  }
  return env.CLAUDE_BIN || "claude";
}

function shellEscape(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function tclEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function buildVisibleTerminalCleanupLines() {
  return [
    "current_tty=$(tty 2>/dev/null || true)",
    "if [ -n \"$current_tty\" ]; then",
    "  /usr/bin/osascript - \"$current_tty\" >/dev/null 2>&1 <<'APPLESCRIPT' || true",
    "on run argv",
    "  if (count of argv) is 0 then",
    "    return",
    "  end if",
    "  set targetTTY to item 1 of argv",
    "  tell application \"Terminal\"",
    "    repeat with w in windows",
    "      repeat with t in tabs of w",
    "        try",
    "          if tty of t is targetTTY then",
    "            close t",
    "            return",
    "          end if",
    "        end try",
    "      end repeat",
    "    end repeat",
    "  end tell",
    "end run",
    "APPLESCRIPT",
    "fi",
  ];
}

function buildShellEnvArgs(env) {
  return Object.entries(env)
    .filter(([key, value]) => normalizeString(key) && !String(key).includes("=") && value !== undefined)
    .map(([key, value]) => shellEscape(`${String(key)}=${String(value ?? "")}`));
}

function shouldShowClaudeWindow(env = process.env) {
  return env.CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW === "1";
}

function buildWorkerSessionName(aibotSessionID) {
  const normalized = normalizeString(aibotSessionID).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized ? `clawpool-${normalized}` : "clawpool-worker";
}

function resolveWorkerLogPaths({ logsDir, workerID }) {
  const normalizedWorkerID = normalizeString(workerID) || randomUUID();
  return {
    stdoutLogPath: path.join(logsDir, `${normalizedWorkerID}.out.log`),
    stderrLogPath: path.join(logsDir, `${normalizedWorkerID}.err.log`),
  };
}

export function buildWorkerEnvironment({
  baseEnv = process.env,
  pluginDataDir,
  aibotSessionID,
  claudeSessionID,
  workerID,
  bridgeURL = "",
  bridgeToken = "",
  connectionConfig = null,
}) {
  const env = {
    ...baseEnv,
    CLAUDE_PLUGIN_DATA: normalizeString(pluginDataDir),
    CLAWPOOL_CLAUDE_AIBOT_SESSION_ID: normalizeString(aibotSessionID),
    CLAWPOOL_CLAUDE_SESSION_ID: normalizeString(claudeSessionID),
    CLAWPOOL_CLAUDE_DAEMON_MODE: "1",
    CLAWPOOL_CLAUDE_WORKER_ID: normalizeString(workerID),
    CLAWPOOL_CLAUDE_DAEMON_BRIDGE_URL: normalizeString(bridgeURL),
    CLAWPOOL_CLAUDE_DAEMON_BRIDGE_TOKEN: normalizeString(bridgeToken),
  };

  if (connectionConfig) {
    env.CLAWPOOL_CLAUDE_WS_URL = normalizeString(connectionConfig.wsURL);
    env.CLAWPOOL_CLAUDE_AGENT_ID = normalizeString(connectionConfig.agentID);
    env.CLAWPOOL_CLAUDE_API_KEY = normalizeString(connectionConfig.apiKey);
    if (Number.isFinite(Number(connectionConfig.outboundTextChunkLimit))) {
      env.CLAWPOOL_CLAUDE_OUTBOUND_TEXT_CHUNK_LIMIT = String(
        Math.floor(Number(connectionConfig.outboundTextChunkLimit)),
      );
    }
  }

  return env;
}

export function buildWorkerClaudeArgs({
  packageRoot,
  aibotSessionID,
  claudeSessionID,
  resumeSession = false,
}) {
  const normalizedPackageRoot = normalizeString(packageRoot);
  const normalizedClaudeSessionID = normalizeString(claudeSessionID);
  if (!normalizedPackageRoot) {
    throw new Error("packageRoot is required");
  }
  const args = [
    "--name",
    buildWorkerSessionName(aibotSessionID),
    "--plugin-dir",
    normalizedPackageRoot,
    "--dangerously-skip-permissions",
  ];
  if (resumeSession) {
    if (!normalizedClaudeSessionID) {
      throw new Error("claudeSessionID is required when resumeSession is true");
    }
    args.push("--resume", normalizedClaudeSessionID);
  } else {
    args.push("--session-id", normalizedClaudeSessionID || randomUUID());
  }
  args.push(
    "--dangerously-load-development-channels",
    "server:clawpool-claude",
  );
  return args;
}

export async function createVisibleClaudeLaunchScript({
  logsDir,
  workerID,
  cwd,
  command,
  args,
  env,
  captureOutputInExpectLog = true,
}) {
  await mkdir(logsDir, { recursive: true });
  const normalizedWorkerID = normalizeString(workerID) || randomUUID();
  const scriptPath = path.join(logsDir, `${normalizedWorkerID}.launch.command`);
  const expectPath = path.join(logsDir, `${normalizedWorkerID}.launch.expect`);
  const pidPath = path.join(logsDir, `${normalizedWorkerID}.pid`);
  const { stdoutLogPath } = resolveWorkerLogPaths({
    logsDir,
    workerID: normalizedWorkerID,
  });
  const expectLines = [
    "log_user 1",
    "set timeout -1",
    "set startup_prompt_armed 1",
    "proc emit_marker {marker} {",
    "  puts [format {[clawpool] %s} $marker]",
    "  flush stdout",
    "}",
    ...(captureOutputInExpectLog ? [`log_file -a {${tclEscape(stdoutLogPath)}}`] : []),
    `set claude_command [list {${tclEscape(command)}}${args.map((item) => ` {${tclEscape(item)}}`).join("")}]`,
    "spawn -noecho {*}$claude_command",
    `set pid_file [open {${tclEscape(pidPath)}} w]`,
    "puts $pid_file [exp_pid -i $spawn_id]",
    "close $pid_file",
    "after 500",
    "send -- \"\\r\"",
    "expect {",
    "  -re {(?i)(Quick.*safety.*check|trust.*folder)} {",
    "    if {$startup_prompt_armed} {",
    "      emit_marker startup_prompt_auto_confirm",
    "      emit_marker startup_workspace_trust_auto_confirm",
    "      send -- \"1\\r\"",
    "      after 300",
    "    }",
    "    exp_continue",
    "  }",
    "  -re {(?i)I am using this for local development} {",
    "    if {$startup_prompt_armed} {",
    "      emit_marker startup_prompt_auto_confirm",
    "      emit_marker startup_development_channels_auto_confirm",
    "      send -- \"1\\r\"",
    "      after 300",
    "    }",
    "    exp_continue",
    "  }",
    "  -re {(?i)(Enter.*confirm|Press.*Enter|Hit.*Enter|Continue.*Enter)} {",
    "    if {$startup_prompt_armed} {",
    "      emit_marker startup_prompt_auto_confirm",
    "      send -- \"\\r\"",
    "      after 300",
    "    }",
    "    exp_continue",
    "  }",
    "  -re {(?i)Listening.*channel messages.*server:clawpool-claude} {",
    "    emit_marker startup_channel_listening",
    "    set startup_prompt_armed 0",
    "    exp_continue",
    "  }",
    "  -re {(?i)MCP.*server failed} {",
    "    emit_marker startup_mcp_server_failed",
    "    exp_continue",
    "  }",
    "  eof {}",
    "}",
    "",
  ];
  const lines = [
    "#!/bin/zsh",
    "set -e",
    `cd ${shellEscape(cwd)}`,
    `printf '\\e]1;clawpool-claude ${normalizedWorkerID}\\a'`,
    `/usr/bin/env ${buildShellEnvArgs(env).join(" ")} /usr/bin/expect ${shellEscape(expectPath)}`,
    ...buildVisibleTerminalCleanupLines(),
    "",
  ];
  await writeFile(pidPath, "", "utf8");
  await writeFile(expectPath, expectLines.join("\n"), "utf8");
  await chmod(expectPath, 0o755);
  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return { scriptPath, expectPath, pidPath };
}

async function waitForPidFile(pidPath, attempts = 50, delayMs = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await readFile(pidPath, "utf8");
      const pid = Number.parseInt(String(raw).trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // wait for Terminal wrapper to write the file
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return 0;
}

async function launchClaudeInVisibleTerminal({
  logsDir,
  workerID,
  cwd,
  command,
  args,
  env,
  spawnImpl,
}) {
  if (process.platform !== "darwin") {
    throw new Error("show-claude currently only supports macOS Terminal");
  }

  const { scriptPath, pidPath } = await createVisibleClaudeLaunchScript({
    logsDir,
    workerID,
    cwd,
    command,
    args,
    env,
  });

  await new Promise((resolve, reject) => {
    const child = spawnImpl("open", [
      "-n",
      "-a",
      "Terminal",
      scriptPath,
    ], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`osascript exited with code ${code ?? -1}`));
    });
  });

  const pid = await waitForPidFile(pidPath);
  return { pid, pidPath, scriptPath };
}

async function launchClaudeInHiddenPty({
  logsDir,
  workerID,
  cwd,
  command,
  args,
  env,
  spawnImpl,
  stdoutFD,
  stderrFD,
}) {
  const { expectPath, pidPath } = await createVisibleClaudeLaunchScript({
    logsDir,
    workerID,
    cwd,
    command,
    args,
    env,
    captureOutputInExpectLog: false,
  });
  const child = spawnImpl("/usr/bin/expect", [expectPath], {
    cwd,
    env,
    stdio: ["ignore", stdoutFD, stderrFD],
    detached: true,
    windowsHide: true,
  });
  const pid = await new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    child.once("error", onError);
    waitForPidFile(pidPath)
      .then((nextPID) => {
        if (settled) {
          return;
        }
        settled = true;
        child.off("error", onError);
        resolve(nextPID);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        child.off("error", onError);
        reject(error);
      });
  });
  return {
    pid: Number(pid || child.pid || 0),
    wrapperPID: Number(child.pid || 0),
    expectPath,
    pidPath,
    child,
  };
}

function resolveWorkerPIDPath(logsDir, workerID) {
  const normalizedWorkerID = normalizeString(workerID) || randomUUID();
  return path.join(logsDir, `${normalizedWorkerID}.pid`);
}

async function listManagedPIDFiles(logsDir) {
  const normalizedLogsDir = normalizeString(logsDir);
  if (!normalizedLogsDir) {
    return [];
  }
  try {
    const entries = await readdir(normalizedLogsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".pid"))
      .map((entry) => path.join(normalizedLogsDir, entry.name));
  } catch {
    return [];
  }
}

async function readManagedPID(pidPath) {
  try {
    const raw = await readFile(pidPath, "utf8");
    const pid = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  } catch {
    // ignore unreadable pid files
  }
  return 0;
}

export class WorkerProcessManager {
  constructor({
    env = process.env,
    packageRoot = resolvePackageRoot(),
    connectionConfig = null,
    spawnImpl = spawn,
    ensureUserMcpServer = defaultEnsureUserMcpServer,
    terminateProcessTree = defaultTerminateProcessTree,
    waitForProcessExit = defaultWaitForProcessExit,
  } = {}) {
    this.env = env;
    this.packageRoot = packageRoot;
    this.connectionConfig = connectionConfig;
    this.spawnImpl = typeof spawnImpl === "function" ? spawnImpl : spawn;
    this.ensureUserMcpServer = typeof ensureUserMcpServer === "function"
      ? ensureUserMcpServer
      : defaultEnsureUserMcpServer;
    this.terminateProcessTree = typeof terminateProcessTree === "function"
      ? terminateProcessTree
      : defaultTerminateProcessTree;
    this.waitForProcessExit = typeof waitForProcessExit === "function"
      ? waitForProcessExit
      : defaultWaitForProcessExit;
    this.onWorkerExit = null;
    this.runtimes = new Map();
    this.spawnQueues = new Map();
  }

  getWorkerRuntime(workerID) {
    const runtime = this.runtimes.get(normalizeString(workerID));
    return runtime ? { ...runtime } : null;
  }

  markWorkerRuntimeStopped(workerID, {
    exitCode = 0,
    exitSignal = "",
  } = {}) {
    const normalizedWorkerID = normalizeString(workerID);
    if (!normalizedWorkerID) {
      return null;
    }
    const current = this.runtimes.get(normalizedWorkerID);
    if (!current || current.status === "stopped") {
      return current ? { ...current } : null;
    }
    const next = {
      ...current,
      status: "stopped",
      exit_code: Number(exitCode ?? 0),
      exit_signal: normalizeString(exitSignal),
      stopped_at: Date.now(),
    };
    this.runtimes.set(normalizedWorkerID, next);
    return { ...next };
  }

  async ensureUserMcpServerConfigured({ env = this.env } = {}) {
    const claudeCommand = resolveClaudeCommand(env);
    const serverEntryPath = resolveServerEntryPath(this.packageRoot);
    await this.ensureUserMcpServer({
      claudeCommand,
      serverCommand: process.execPath,
      serverArgs: [serverEntryPath],
      env,
    });
    return {
      claudeCommand,
      serverEntryPath,
    };
  }

  async cleanupStaleManagedProcesses(aibotSessionIDs = []) {
    const normalizedSessionIDs = Array.from(new Set(
      (Array.isArray(aibotSessionIDs) ? aibotSessionIDs : [])
        .map((value) => normalizeString(value))
        .filter((value) => value),
    ));
    if (normalizedSessionIDs.length === 0) {
      return [];
    }

    const sessionTargets = normalizedSessionIDs.map((aibotSessionID) => (
      resolveWorkerLogsDir(aibotSessionID, this.env)
    ));
    const pidFiles = [];
    for (const logsDir of sessionTargets) {
      const matched = await listManagedPIDFiles(logsDir);
      pidFiles.push(...matched);
    }

    const staleEntries = [];
    const seenPIDs = new Set();
    for (const pidPath of pidFiles) {
      const pid = await readManagedPID(pidPath);
      if (pid > 0 && !seenPIDs.has(pid)) {
        seenPIDs.add(pid);
        staleEntries.push({ pid, pidPath });
      }
    }

    const terminatedPIDs = [];
    for (const entry of staleEntries) {
      if (!entry?.pid) {
        continue;
      }
      await this.terminateProcessTree(entry.pid, { platform: process.platform });
      terminatedPIDs.push(entry.pid);
      if (entry.pidPath) {
        await writeFile(entry.pidPath, "", "utf8").catch(() => {});
      }
    }

    // Fallback: find and kill orphaned claude workers by command pattern.
    // PID files may be empty if the previous expect process failed to write them.
    if (terminatedPIDs.length === 0 && normalizedSessionIDs.length > 0) {
      try {
        const output = execSync(
          "pgrep -f 'claude.*--plugin-dir.*clawpool-claude' 2>/dev/null || true",
          { encoding: "utf8", timeout: 5000 },
        );
        const orphanPIDs = output.trim().split("\n").map(Number).filter((n) => n > 0);
        for (const pid of orphanPIDs) {
          await this.terminateProcessTree(pid, { platform: process.platform });
          terminatedPIDs.push(pid);
        }
      } catch {
        // pgrep not available or no matches
      }
    }

    return terminatedPIDs;
  }

  enqueueSpawnForSession(aibotSessionID, task) {
    const normalizedSessionID = normalizeString(aibotSessionID);
    if (!normalizedSessionID || typeof task !== "function") {
      return Promise.resolve().then(task);
    }

    const previous = this.spawnQueues.get(normalizedSessionID) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(task);
    const tracked = queued
      .catch(() => {})
      .finally(() => {
        if (this.spawnQueues.get(normalizedSessionID) === tracked) {
          this.spawnQueues.delete(normalizedSessionID);
        }
      });
    this.spawnQueues.set(normalizedSessionID, tracked);
    return queued;
  }

  async spawnWorker({
    aibotSessionID,
    cwd,
    pluginDataDir,
    claudeSessionID,
    workerID = randomUUID(),
    bridgeURL = "",
    bridgeToken = "",
    resumeSession = false,
  }) {
    const normalizedWorkerID = normalizeString(workerID) || randomUUID();
    const normalizedSessionID = normalizeString(aibotSessionID);
    const normalizedCwd = normalizeString(cwd);
    const normalizedPluginDataDir = normalizeString(pluginDataDir);
    const normalizedClaudeSessionID = normalizeString(claudeSessionID) || randomUUID();
    if (!normalizedSessionID || !normalizedCwd || !normalizedPluginDataDir) {
      throw new Error("aibotSessionID, cwd, and pluginDataDir are required");
    }

    return this.enqueueSpawnForSession(normalizedSessionID, async () => {
      const logsDir = resolveWorkerLogsDir(normalizedSessionID, this.env);
      await mkdir(logsDir, { recursive: true });
      await new HookSignalStore(path.join(normalizedPluginDataDir, "hook-signals.json")).reset();
      const workerEnv = buildWorkerEnvironment({
        baseEnv: this.env,
        pluginDataDir: normalizedPluginDataDir,
        aibotSessionID: normalizedSessionID,
        claudeSessionID: normalizedClaudeSessionID,
        workerID: normalizedWorkerID,
        bridgeURL,
        bridgeToken,
        connectionConfig: this.connectionConfig,
      });
      const { claudeCommand } = await this.ensureUserMcpServerConfigured({
        env: workerEnv,
      });
      const claudeArgs = buildWorkerClaudeArgs({
        packageRoot: this.packageRoot,
        aibotSessionID: normalizedSessionID,
        claudeSessionID: normalizedClaudeSessionID,
        resumeSession,
      });
      const {
        stdoutLogPath,
        stderrLogPath,
      } = resolveWorkerLogPaths({
        logsDir,
        workerID: normalizedWorkerID,
      });
      const stdoutHandle = await open(stdoutLogPath, "w");
      const stderrHandle = await open(stderrLogPath, "w");
      let deferFDClose = false;
      try {
        await this.cleanupStaleManagedProcesses([normalizedSessionID]);

        let child = null;
        let pid = 0;
        let pidPath = "";
        let visibleTerminal = null;
        if (shouldShowClaudeWindow(this.env)) {
          visibleTerminal = await launchClaudeInVisibleTerminal({
            logsDir,
            workerID: normalizedWorkerID,
            cwd: normalizedCwd,
            command: claudeCommand,
            args: claudeArgs,
            env: workerEnv,
            spawnImpl: this.spawnImpl,
          });
          pid = Number(visibleTerminal.pid ?? 0);
          pidPath = normalizeString(visibleTerminal.pidPath);
        } else if (process.platform === "darwin") {
          const hiddenPty = await launchClaudeInHiddenPty({
            logsDir,
            workerID: normalizedWorkerID,
            cwd: normalizedCwd,
            command: claudeCommand,
            args: claudeArgs,
            env: workerEnv,
            spawnImpl: this.spawnImpl,
            stdoutFD: stdoutHandle.fd,
            stderrFD: stderrHandle.fd,
          });
          pid = hiddenPty.pid;
          pidPath = normalizeString(hiddenPty.pidPath);
          if (hiddenPty.child) {
            child = hiddenPty.child;
            const exitWorkerID = normalizedWorkerID;
            const exitSessionID = normalizedSessionID;
            child.on("exit", (code, signal) => {
              const rt = this.runtimes.get(exitWorkerID);
              if (rt) {
                Promise.allSettled([
                  rt.stdoutHandle?.close?.(),
                  rt.stderrHandle?.close?.(),
                ]).catch(() => {});
                rt.stdoutHandle = null;
                rt.stderrHandle = null;
              }
              this.markWorkerRuntimeStopped(exitWorkerID, {
                exitCode: code ?? 0,
                exitSignal: signal || "wrapper_exited",
              });
              if (typeof this.onWorkerExit === "function") {
                this.onWorkerExit({
                  workerID: exitWorkerID,
                  aibotSessionID: exitSessionID,
                  exitCode: code ?? 0,
                  exitSignal: signal || "wrapper_exited",
                });
              }
            });
          }
        } else {
          child = this.spawnImpl(
            claudeCommand,
            claudeArgs,
            {
              cwd: normalizedCwd,
              env: workerEnv,
              stdio: ["pipe", stdoutHandle.fd, stderrHandle.fd],
              detached: true,
              windowsHide: true,
            },
          );

          child.stdin?.write("\n");
          child.stdin?.end();
          child.unref();
          pid = Number(child.pid ?? 0);
          if (!Number.isFinite(pid) || pid <= 0) {
            throw new Error("failed to determine spawned Claude pid");
          }
          pidPath = resolveWorkerPIDPath(logsDir, normalizedWorkerID);
          await writeFile(pidPath, `${pid}\n`, "utf8");
        }

        if (!Number.isFinite(pid) || pid <= 0) {
          throw new Error("failed to determine spawned Claude pid");
        }

        const isHiddenPty = !visibleTerminal && process.platform === "darwin";
        deferFDClose = isHiddenPty;
        const runtime = {
          worker_id: normalizedWorkerID,
          aibot_session_id: normalizedSessionID,
          claude_session_id: normalizedClaudeSessionID,
          cwd: normalizedCwd,
          plugin_data_dir: normalizedPluginDataDir,
          logs_dir: logsDir,
          stdout_log_path: stdoutLogPath,
          stderr_log_path: stderrLogPath,
          pid_path: pidPath,
          pid,
          started_at: Date.now(),
          status: "starting",
          resume_session: resumeSession,
          visible_terminal: Boolean(visibleTerminal),
          wrapperChild: isHiddenPty ? child : null,
          stdoutHandle: isHiddenPty ? stdoutHandle : null,
          stderrHandle: isHiddenPty ? stderrHandle : null,
        };
        this.runtimes.set(normalizedWorkerID, runtime);

        return { ...runtime };
      } finally {
        if (!deferFDClose) {
          await Promise.allSettled([
            stdoutHandle.close().catch(() => {}),
            stderrHandle.close().catch(() => {}),
          ]);
        }
      }
    });
  }

  async stopWorker(workerID) {
    const normalizedWorkerID = normalizeString(workerID);
    const runtime = this.runtimes.get(normalizedWorkerID);
    if (!runtime) {
      return false;
    }
    const pid = Number(runtime.pid ?? 0);
    let exitSignal = "SIGTERM";
    if (pid > 0) {
      const terminated = await this.terminateProcessTree(pid, {
        platform: process.platform,
        signal: exitSignal,
      });
      if (!terminated) {
        return false;
      }
      const exited = await this.waitForProcessExit(pid, {
        timeoutMs: 5000,
      });
      if (!exited) {
        exitSignal = "SIGKILL";
        await this.terminateProcessTree(pid, {
          platform: process.platform,
          signal: exitSignal,
        });
        const forceExited = await this.waitForProcessExit(pid, {
          timeoutMs: 3000,
        });
        if (!forceExited) {
          return false;
        }
      }
    }
    if (runtime.pid_path) {
      await writeFile(runtime.pid_path, "", "utf8").catch(() => {});
    }
    if (runtime.wrapperChild) {
      runtime.wrapperChild.unref();
    }
    await Promise.allSettled([
      runtime.stdoutHandle?.close?.(),
      runtime.stderrHandle?.close?.(),
    ]);
    this.markWorkerRuntimeStopped(normalizedWorkerID, {
      exitSignal,
    });
    return true;
  }

  async hasLogPatternMatch(workerID, patterns = [], {
    logCursor = null,
    maxBytes = 0,
  } = {}) {
    const runtime = this.runtimes.get(normalizeString(workerID));
    if (!runtime) {
      return false;
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }

    const cursor = logCursor && typeof logCursor === "object" ? logCursor : null;
    const normalizedMaxBytes = normalizePositiveInt(maxBytes, 0);
    const logTargets = [
      {
        filePath: runtime.stdout_log_path,
        startOffset: cursor?.stdoutOffset,
      },
      {
        filePath: runtime.stderr_log_path,
        startOffset: cursor?.stderrOffset,
      },
    ];

    for (const target of logTargets) {
      const normalizedFilePath = normalizeString(target.filePath);
      if (!normalizedFilePath) {
        continue;
      }
      try {
        const content = await readLogSlice(normalizedFilePath, {
          startOffset: target.startOffset,
          maxBytes: normalizedMaxBytes,
        });
        if (!content) {
          continue;
        }
        const normalizedContent = stripTerminalControlSequences(content);
        if (patterns.some((pattern) => (
          patternMatches(pattern, content)
          || patternMatches(pattern, normalizedContent)
        ))) {
          return true;
        }
      } catch {
        // ignore unreadable log files while startup is still in progress
      }
    }
    return false;
  }

  async hasMissingResumeSessionError(workerID) {
    return this.hasLogPatternMatch(workerID, [missingResumeSessionPattern]);
  }

  async hasAuthLoginRequiredError(workerID) {
    return this.hasLogPatternMatch(workerID, authLoginRequiredPatterns);
  }

  async hasExtraUsageLimitPrompt(workerID, {
    logCursor = null,
  } = {}) {
    const hasCursor = Boolean(logCursor && typeof logCursor === "object");
    return this.hasLogPatternMatch(workerID, extraUsageLimitPatterns, {
      logCursor: hasCursor ? logCursor : null,
      maxBytes: hasCursor
        ? defaultUsageLimitCursorScanBytes
        : defaultUsageLimitTailScanBytes,
    });
  }

  async captureLogCursor(workerID) {
    const runtime = this.runtimes.get(normalizeString(workerID));
    if (!runtime) {
      return null;
    }

    let stdoutOffset = 0;
    let stderrOffset = 0;
    try {
      stdoutOffset = normalizeNonNegativeOffset((await stat(runtime.stdout_log_path)).size);
    } catch {
      stdoutOffset = 0;
    }
    try {
      stderrOffset = normalizeNonNegativeOffset((await stat(runtime.stderr_log_path)).size);
    } catch {
      stderrOffset = 0;
    }
    return {
      stdoutOffset,
      stderrOffset,
    };
  }

  async hasStartupPromptAutoConfirm(workerID) {
    return this.hasLogPatternMatch(workerID, [startupPromptAutoConfirmPattern]);
  }

  async hasStartupChannelListening(workerID) {
    return this.hasLogPatternMatch(workerID, startupChannelListeningPatterns);
  }

  async hasStartupMcpServerFailed(workerID) {
    return this.hasLogPatternMatch(workerID, startupMcpServerFailedPatterns);
  }

  async hasStartupBlockingMcpServerFailure(workerID) {
    if (await this.hasLogPatternMatch(workerID, [startupMcpServerFailedMarkerPattern])) {
      return true;
    }
    if (!await this.hasStartupMcpServerFailed(workerID)) {
      return false;
    }
    if (await this.hasStartupChannelListening(workerID)) {
      return false;
    }
    return true;
  }

  /**
   * Run `claude auth login` in a subprocess and wait for it to succeed.
   * Returns { ok: true } when "Login successful" appears in stdout/stderr,
   * or { ok: false, reason } on timeout / error.
   */
  async runClaudeAuthLogin({ timeoutMs = 120_000, env = this.env } = {}) {
    const claudeCommand = resolveClaudeCommand(env);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        child?.kill?.();
        resolve(result);
      };

      const child = spawn(claudeCommand, ["auth", "login"], {
        env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });

      const timeout = setTimeout(() => {
        finish({ ok: false, reason: `claude auth login timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      let combined = "";
      const onData = (chunk) => {
        combined += String(chunk ?? "");
        if (/Login\s+successful/iu.test(combined) || /logged\s+in/iu.test(combined)) {
          clearTimeout(timeout);
          finish({ ok: true });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err) => {
        clearTimeout(timeout);
        finish({ ok: false, reason: `claude auth login spawn error: ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (!settled) {
          finish({ ok: false, reason: `claude auth login exited with code ${code}` });
        }
      });
    });
  }
}
