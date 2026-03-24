import { mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJSONFile, writeJSONFileAtomic } from "../json-file.js";
import { isProcessRunning } from "../process-control.js";
import {
  resolveDaemonDataDir,
  resolveDaemonLockPath,
  resolveDaemonStatusPath,
} from "./daemon-paths.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePID(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

async function ensureDataDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function readJSONOrNull(filePath) {
  return readJSONFile(filePath, null);
}

async function removeFileIfExists(filePath) {
  try {
    await rm(filePath, { force: true });
  } catch {
    // ignore missing or already-removed files
  }
}

async function writeLockFile(filePath, payload) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function buildStatusRecord({
  previous = null,
  state,
  now,
  pid,
  dataDir,
  bridgeURL = "",
  configured = false,
  connectionState = "",
  exitCode = 0,
  reason = "",
}) {
  return {
    schema_version: 1,
    state: normalizeString(state),
    pid: normalizePID(pid),
    data_dir: dataDir,
    started_at: Number(previous?.started_at ?? now),
    updated_at: now,
    bridge_url: normalizeString(bridgeURL),
    configured: Boolean(configured),
    connection_state: normalizeString(connectionState),
    stopped_at: state === "stopped" ? now : Number(previous?.stopped_at ?? 0),
    exit_code: state === "stopped" ? Number(exitCode ?? 0) : Number(previous?.exit_code ?? 0),
    reason: normalizeString(reason),
  };
}

export async function inspectDaemonProcessState({
  env = process.env,
  dataDir = resolveDaemonDataDir(env),
  isProcessRunningImpl = isProcessRunning,
} = {}) {
  const statusPath = resolveDaemonStatusPath({ ...env, CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: dataDir });
  const lockPath = resolveDaemonLockPath({ ...env, CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: dataDir });
  const [status, lock] = await Promise.all([
    readJSONOrNull(statusPath),
    readJSONOrNull(lockPath),
  ]);
  const lockPID = normalizePID(lock?.pid);
  const statusPID = normalizePID(status?.pid);
  const pid = lockPID || statusPID;
  const running = Boolean(lockPID) && isProcessRunningImpl(lockPID);
  return {
    data_dir: dataDir,
    status_path: statusPath,
    lock_path: lockPath,
    installed_status: status,
    lock,
    pid,
    running,
    stale: Boolean(lockPID) && !running,
    state: running ? "running" : normalizeString(status?.state) || "stopped",
    bridge_url: normalizeString(status?.bridge_url),
    connection_state: normalizeString(status?.connection_state),
    configured: Boolean(status?.configured),
    updated_at: Number(status?.updated_at ?? 0),
    started_at: Number(status?.started_at ?? 0),
  };
}

export class DaemonProcessState {
  constructor({
    env = process.env,
    dataDir = resolveDaemonDataDir(env),
    pid = process.pid,
    now = () => Date.now(),
    isProcessRunningImpl = isProcessRunning,
  } = {}) {
    this.env = env;
    this.dataDir = dataDir;
    this.pid = normalizePID(pid);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.isProcessRunningImpl = isProcessRunningImpl;
    this.lockPath = resolveDaemonLockPath({
      ...env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: dataDir,
    });
    this.statusPath = resolveDaemonStatusPath({
      ...env,
      CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: dataDir,
    });
    this.startedAt = 0;
    this.acquired = false;
  }

  async acquire() {
    await ensureDataDir(this.dataDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await readJSONOrNull(this.lockPath);
      const existingPID = normalizePID(existing?.pid);
      if (existingPID && this.isProcessRunningImpl(existingPID)) {
        throw new Error(`daemon 已在运行，pid=${existingPID}`);
      }
      if (existing) {
        await removeFileIfExists(this.lockPath);
      }
      const acquiredAt = this.now();
      try {
        await writeLockFile(this.lockPath, {
          schema_version: 1,
          pid: this.pid,
          acquired_at: acquiredAt,
          data_dir: this.dataDir,
        });
        this.startedAt = acquiredAt;
        this.acquired = true;
        await this.writeStatus({
          state: "starting",
          configured: false,
          connectionState: "starting",
        });
        return;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
    throw new Error("daemon 启动锁获取失败");
  }

  async writeStatus({
    state,
    bridgeURL = "",
    configured = false,
    connectionState = "",
    exitCode = 0,
    reason = "",
  }) {
    const previous = await readJSONOrNull(this.statusPath);
    const next = buildStatusRecord({
      previous,
      state,
      now: this.now(),
      pid: this.pid,
      dataDir: this.dataDir,
      bridgeURL,
      configured,
      connectionState,
      exitCode,
      reason,
    });
    await writeJSONFileAtomic(this.statusPath, next, { mode: 0o600 });
    return next;
  }

  async markRunning({ bridgeURL = "", configured = false, connectionState = "" } = {}) {
    if (!this.acquired) {
      throw new Error("daemon process state not acquired");
    }
    return this.writeStatus({
      state: "running",
      bridgeURL,
      configured,
      connectionState,
    });
  }

  async markStopping(reason = "") {
    if (!this.acquired) {
      return null;
    }
    return this.writeStatus({
      state: "stopping",
      reason,
    });
  }

  async fail(reason = "") {
    await this.writeStatus({
      state: "failed",
      reason,
      connectionState: "failed",
    });
    await removeFileIfExists(this.lockPath);
    this.acquired = false;
  }

  async release({ exitCode = 0, reason = "" } = {}) {
    await this.writeStatus({
      state: "stopped",
      exitCode,
      connectionState: "stopped",
      reason,
    });
    await removeFileIfExists(this.lockPath);
    this.acquired = false;
  }
}
