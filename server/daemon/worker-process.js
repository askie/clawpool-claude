import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { resolvePackageRoot } from "../../cli/config.js";
import { resolveWorkerLogsDir } from "./daemon-paths.js";

function normalizeString(value) {
  return String(value ?? "").trim();
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

function buildShellExportLines(env) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `export ${key}=${shellEscape(String(value ?? ""))}`);
}

function shouldShowClaudeWindow(env = process.env) {
  return env.CLAWPOOL_SHOW_CLAUDE_WINDOW === "1";
}

function buildWorkerSessionName(aibotSessionID) {
  const normalized = normalizeString(aibotSessionID).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized ? `clawpool-${normalized}` : "clawpool-worker";
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
    CLAWPOOL_AIBOT_SESSION_ID: normalizeString(aibotSessionID),
    CLAWPOOL_CLAUDE_SESSION_ID: normalizeString(claudeSessionID),
    CLAWPOOL_DAEMON_MODE: "1",
    CLAWPOOL_WORKER_ID: normalizeString(workerID),
    CLAWPOOL_DAEMON_BRIDGE_URL: normalizeString(bridgeURL),
    CLAWPOOL_DAEMON_BRIDGE_TOKEN: normalizeString(bridgeToken),
  };

  if (connectionConfig) {
    env.CLAWPOOL_WS_URL = normalizeString(connectionConfig.wsURL);
    env.CLAWPOOL_AGENT_ID = normalizeString(connectionConfig.agentID);
    env.CLAWPOOL_API_KEY = normalizeString(connectionConfig.apiKey);
    if (Number.isFinite(Number(connectionConfig.outboundTextChunkLimit))) {
      env.CLAWPOOL_OUTBOUND_TEXT_CHUNK_LIMIT = String(
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
}) {
  await mkdir(logsDir, { recursive: true });
  const normalizedWorkerID = normalizeString(workerID) || randomUUID();
  const scriptPath = path.join(logsDir, `${normalizedWorkerID}.launch.command`);
  const expectPath = path.join(logsDir, `${normalizedWorkerID}.launch.expect`);
  const pidPath = path.join(logsDir, `${normalizedWorkerID}.pid`);
  const outLogPath = path.join(logsDir, `${normalizedWorkerID}.out.log`);
  const expectLines = [
    "log_user 1",
    "set timeout -1",
    `log_file -a {${tclEscape(outLogPath)}}`,
    `set claude_command [list {${tclEscape(command)}}${args.map((item) => ` {${tclEscape(item)}}`).join("")}]`,
    "spawn -noecho {*}$claude_command",
    "expect {",
    "  -re {Enter.*confirm} {",
    "    send -- \"\\r\"",
    "    after 500",
    "  }",
    "}",
    "interact",
    "",
  ];
  const lines = [
    "#!/bin/zsh",
    "set -e",
    `cd ${shellEscape(cwd)}`,
    `printf '\\e]1;clawpool-claude ${normalizedWorkerID}\\a'`,
    `echo $$ > ${shellEscape(pidPath)}`,
    ...buildShellExportLines(env),
    `exec /usr/bin/expect ${shellEscape(expectPath)}`,
    "",
  ];
  await writeFile(expectPath, expectLines.join("\n"), "utf8");
  await chmod(expectPath, 0o755);
  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return { scriptPath, expectPath, pidPath };
}

async function listManagedClaudeProcesses() {
  const child = spawn("ps", ["-ax", "-o", "pid=,command="], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks = [];
  for await (const chunk of child.stdout) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(Number(code ?? 0)));
    child.on("error", () => resolve(1));
  });
  if (exitCode !== 0) {
    return [];
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid) && entry.pid > 0);
}

function isManagedClaudeCommand(command, { packageRoot, sessionName }) {
  const normalizedCommand = normalizeString(command);
  return (
    normalizedCommand.includes("claude") &&
    normalizedCommand.includes(`--plugin-dir ${normalizeString(packageRoot)}`) &&
    normalizedCommand.includes(`--name ${normalizeString(sessionName)}`) &&
    normalizedCommand.includes("--dangerously-load-development-channels server:clawpool-claude")
  );
}

async function terminateStaleClaudeProcesses({ packageRoot, aibotSessionID }) {
  const sessionName = buildWorkerSessionName(aibotSessionID);
  const processes = await listManagedClaudeProcesses();
  for (const entry of processes) {
    if (!isManagedClaudeCommand(entry.command, { packageRoot, sessionName })) {
      continue;
    }
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // ignore stale or already-exited pid
    }
  }
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

export class WorkerProcessManager {
  constructor({
    env = process.env,
    packageRoot = resolvePackageRoot(),
    connectionConfig = null,
    spawnImpl = spawn,
  } = {}) {
    this.env = env;
    this.packageRoot = packageRoot;
    this.connectionConfig = connectionConfig;
    this.spawnImpl = typeof spawnImpl === "function" ? spawnImpl : spawn;
    this.runtimes = new Map();
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

    const logsDir = resolveWorkerLogsDir(normalizedSessionID, this.env);
    await mkdir(logsDir, { recursive: true });
    const stdoutHandle = await open(path.join(logsDir, `${normalizedWorkerID}.out.log`), "a");
    const stderrHandle = await open(path.join(logsDir, `${normalizedWorkerID}.err.log`), "a");
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
    const claudeCommand = resolveClaudeCommand(this.env);
    const claudeArgs = buildWorkerClaudeArgs({
      packageRoot: this.packageRoot,
      aibotSessionID: normalizedSessionID,
      claudeSessionID: normalizedClaudeSessionID,
      resumeSession,
    });

    await terminateStaleClaudeProcesses({
      packageRoot: this.packageRoot,
      aibotSessionID: normalizedSessionID,
    });

    let child = null;
    let pid = 0;
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
    } else {
      child = this.spawnImpl(
        claudeCommand,
        claudeArgs,
        {
          cwd: normalizedCwd,
          env: workerEnv,
          stdio: ["pipe", stdoutHandle.fd, stderrHandle.fd],
          detached: true,
        },
      );

      child.stdin?.write("\n");
      child.stdin?.end();
      child.unref();
      pid = child.pid ?? 0;
    }

    const runtime = {
      worker_id: normalizedWorkerID,
      aibot_session_id: normalizedSessionID,
      claude_session_id: normalizedClaudeSessionID,
      cwd: normalizedCwd,
      plugin_data_dir: normalizedPluginDataDir,
      pid,
      started_at: Date.now(),
      status: "starting",
      visible_terminal: Boolean(visibleTerminal),
    };
    this.runtimes.set(normalizedWorkerID, runtime);

    await Promise.allSettled([
      stdoutHandle.close(),
      stderrHandle.close(),
    ]);

    return { ...runtime };
  }

  async stopWorker(workerID) {
    const normalizedWorkerID = normalizeString(workerID);
    const runtime = this.runtimes.get(normalizedWorkerID);
    if (!runtime) {
      return false;
    }
    const pid = Number(runtime.pid ?? 0);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return false;
      }
    }
    this.markWorkerRuntimeStopped(normalizedWorkerID, {
      exitSignal: "SIGTERM",
    });
    return true;
  }
}
