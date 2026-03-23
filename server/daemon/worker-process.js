import { mkdir, open } from "node:fs/promises";
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
  packageRoot = resolvePackageRoot(),
  claudeSessionID,
}) {
  const args = [
    "--session-id",
    normalizeString(claudeSessionID) || randomUUID(),
    "--plugin-dir",
    packageRoot,
    "--dangerously-load-development-channels",
    "server:clawpool-claude",
  ];
  return args;
}

export class WorkerProcessManager {
  constructor({
    env = process.env,
    packageRoot = resolvePackageRoot(),
    connectionConfig = null,
  } = {}) {
    this.env = env;
    this.packageRoot = packageRoot;
    this.connectionConfig = connectionConfig;
    this.runtimes = new Map();
  }

  getWorkerRuntime(workerID) {
    const runtime = this.runtimes.get(normalizeString(workerID));
    return runtime ? { ...runtime } : null;
  }

  async spawnWorker({
    aibotSessionID,
    cwd,
    pluginDataDir,
    claudeSessionID,
    workerID = randomUUID(),
    bridgeURL = "",
    bridgeToken = "",
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

    const child = spawn(
      resolveClaudeCommand(this.env),
      buildWorkerClaudeArgs({
        packageRoot: this.packageRoot,
        claudeSessionID: normalizedClaudeSessionID,
      }),
      {
        cwd: normalizedCwd,
        env: buildWorkerEnvironment({
          baseEnv: this.env,
          pluginDataDir: normalizedPluginDataDir,
          aibotSessionID: normalizedSessionID,
          claudeSessionID: normalizedClaudeSessionID,
          workerID: normalizedWorkerID,
          bridgeURL,
          bridgeToken,
          connectionConfig: this.connectionConfig,
        }),
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
        detached: true,
      },
    );

    child.unref();

    const runtime = {
      worker_id: normalizedWorkerID,
      aibot_session_id: normalizedSessionID,
      claude_session_id: normalizedClaudeSessionID,
      cwd: normalizedCwd,
      plugin_data_dir: normalizedPluginDataDir,
      pid: child.pid ?? 0,
      started_at: Date.now(),
      status: "starting",
    };
    this.runtimes.set(normalizedWorkerID, runtime);

    child.on("exit", (code, signal) => {
      const current = this.runtimes.get(normalizedWorkerID);
      if (!current) {
        return;
      }
      this.runtimes.set(normalizedWorkerID, {
        ...current,
        status: "stopped",
        exit_code: Number(code ?? 0),
        exit_signal: normalizeString(signal),
        stopped_at: Date.now(),
      });
    });

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
    this.runtimes.set(normalizedWorkerID, {
      ...runtime,
      status: "stopped",
      stopped_at: Date.now(),
    });
    return true;
  }
}
