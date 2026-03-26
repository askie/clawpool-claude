import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "../json-file.js";
import { normalizeWorkerResponseState } from "./worker-state.js";

const schemaVersion = 1;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeTimestamp(value, fallbackValue = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.floor(fallbackValue);
  }
  return Math.floor(numeric);
}

function normalizeWorkerStatus(value) {
  const normalized = normalizeString(value);
  if (
    normalized === "starting"
    || normalized === "connected"
    || normalized === "ready"
    || normalized === "stopped"
    || normalized === "failed"
  ) {
    return normalized;
  }
  return "stopped";
}

function normalizeWorkerPid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function normalizeRuntime(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const aibotSessionID = normalizeString(input.aibot_session_id);
  if (!aibotSessionID) {
    return null;
  }

  return {
    schema_version: schemaVersion,
    aibot_session_id: aibotSessionID,
    worker_id: normalizeString(input.worker_id),
    worker_pid: normalizeWorkerPid(input.worker_pid),
    worker_status: normalizeWorkerStatus(input.worker_status),
    worker_control_url: normalizeString(input.worker_control_url),
    worker_control_token: normalizeString(input.worker_control_token),
    worker_response_state: normalizeWorkerResponseState(input.worker_response_state),
    worker_response_reason: normalizeString(input.worker_response_reason),
    worker_response_updated_at: normalizeOptionalTimestamp(input.worker_response_updated_at),
    worker_last_reply_at: normalizeOptionalTimestamp(input.worker_last_reply_at),
    worker_last_failure_at: normalizeOptionalTimestamp(input.worker_last_failure_at),
    worker_last_failure_code: normalizeString(input.worker_last_failure_code),
    updated_at: normalizeTimestamp(input.updated_at),
    last_started_at: normalizeTimestamp(input.last_started_at, 0),
    last_stopped_at: normalizeTimestamp(input.last_stopped_at, 0),
  };
}

function normalizeState(input) {
  const runtimes = {};
  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return {
      schema_version: schemaVersion,
      runtimes,
    };
  }

  for (const [key, rawRuntime] of Object.entries(input.runtimes ?? {})) {
    const normalizedKey = normalizeString(key);
    const runtime = normalizeRuntime(rawRuntime);
    if (!normalizedKey || !runtime || runtime.aibot_session_id !== normalizedKey) {
      continue;
    }
    runtimes[normalizedKey] = runtime;
  }

  return {
    schema_version: schemaVersion,
    runtimes,
  };
}

export class WorkerRuntimeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = normalizeState(null);
  }

  async load() {
    const stored = await readJSONFile(this.filePath, null);
    this.state = normalizeState(stored);
    return this.list();
  }

  list() {
    return Object.values(this.state.runtimes)
      .map((runtime) => ({ ...runtime }))
      .sort((left, right) => left.aibot_session_id.localeCompare(right.aibot_session_id));
  }

  get(aibotSessionID) {
    const normalized = normalizeString(aibotSessionID);
    if (!normalized) {
      return null;
    }
    const runtime = this.state.runtimes[normalized];
    return runtime ? { ...runtime } : null;
  }

  async createOrUpdate(aibotSessionID, patch = {}) {
    const normalizedSessionID = normalizeString(aibotSessionID);
    if (!normalizedSessionID) {
      throw new Error("aibot_session_id is required");
    }
    const existing = this.state.runtimes[normalizedSessionID];
    const next = normalizeRuntime({
      ...(existing ?? {
        aibot_session_id: normalizedSessionID,
        worker_status: "stopped",
        worker_pid: 0,
        worker_response_state: "unknown",
        worker_response_reason: "",
        worker_response_updated_at: 0,
        worker_last_reply_at: 0,
        worker_last_failure_at: 0,
        worker_last_failure_code: "",
        updated_at: Date.now(),
        last_started_at: 0,
        last_stopped_at: 0,
      }),
      ...patch,
      aibot_session_id: normalizedSessionID,
    });
    this.state.runtimes[normalizedSessionID] = next;
    await this.save();
    return { ...next };
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJSONFileAtomic(this.filePath, this.state);
  }

  async resetTransientStates({
    updatedAt = Date.now(),
    lastStoppedAt = Date.now(),
  } = {}) {
    let changed = false;

    for (const [sessionID, existing] of Object.entries(this.state.runtimes)) {
      const shouldResetStatus = existing.worker_status === "starting"
        || existing.worker_status === "connected"
        || existing.worker_status === "ready";
      const hasWorkerControl = Boolean(existing.worker_control_url || existing.worker_control_token);

      if (!shouldResetStatus && !hasWorkerControl) {
        continue;
      }

      this.state.runtimes[sessionID] = normalizeRuntime({
        ...existing,
        worker_status: shouldResetStatus ? "stopped" : existing.worker_status,
        worker_pid: shouldResetStatus ? 0 : existing.worker_pid,
        worker_control_url: "",
        worker_control_token: "",
        updated_at: updatedAt,
        last_stopped_at: shouldResetStatus ? lastStoppedAt : existing.last_stopped_at,
      });
      changed = true;
    }

    if (!changed) {
      return false;
    }

    await this.save();
    return true;
  }
}
