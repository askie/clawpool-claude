import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "../json-file.js";

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
    normalized === "starting" ||
    normalized === "connected" ||
    normalized === "ready" ||
    normalized === "stopped" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return "starting";
}

function normalizeBinding(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const aibotSessionID = normalizeString(input.aibot_session_id);
  const claudeSessionID = normalizeString(input.claude_session_id);
  const cwd = normalizeString(input.cwd);
  if (!aibotSessionID || !claudeSessionID || !cwd) {
    return null;
  }

  return {
    schema_version: schemaVersion,
    aibot_session_id: aibotSessionID,
    claude_session_id: claudeSessionID,
    cwd,
    worker_id: normalizeString(input.worker_id),
    worker_status: normalizeWorkerStatus(input.worker_status),
    plugin_data_dir: normalizeString(input.plugin_data_dir),
    worker_control_url: normalizeString(input.worker_control_url),
    worker_control_token: normalizeString(input.worker_control_token),
    created_at: normalizeTimestamp(input.created_at),
    updated_at: normalizeTimestamp(input.updated_at),
    last_started_at: normalizeTimestamp(input.last_started_at, 0),
    last_stopped_at: normalizeTimestamp(input.last_stopped_at, 0),
  };
}

function normalizeRegistry(input) {
  const bindings = {};
  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return {
      schema_version: schemaVersion,
      bindings,
    };
  }

  for (const [key, rawBinding] of Object.entries(input.bindings ?? {})) {
    const normalizedKey = normalizeString(key);
    const binding = normalizeBinding(rawBinding);
    if (!normalizedKey || !binding || binding.aibot_session_id !== normalizedKey) {
      continue;
    }
    bindings[normalizedKey] = binding;
  }

  return {
    schema_version: schemaVersion,
    bindings,
  };
}

export class BindingRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = normalizeRegistry(null);
  }

  async load() {
    const stored = await readJSONFile(this.filePath, null);
    this.state = normalizeRegistry(stored);
    return this.listBindings();
  }

  listBindings() {
    return Object.values(this.state.bindings)
      .map((binding) => ({ ...binding }))
      .sort((left, right) => left.aibot_session_id.localeCompare(right.aibot_session_id));
  }

  getByAibotSessionID(aibotSessionID) {
    const normalized = normalizeString(aibotSessionID);
    if (!normalized) {
      return null;
    }
    const binding = this.state.bindings[normalized];
    return binding ? { ...binding } : null;
  }

  async createBinding(input) {
    const normalized = normalizeBinding({
      ...input,
      worker_status: input.worker_status || "starting",
      created_at: input.created_at ?? Date.now(),
      updated_at: input.updated_at ?? Date.now(),
    });
    if (!normalized) {
      throw new Error("valid binding is required");
    }
    if (this.state.bindings[normalized.aibot_session_id]) {
      throw new Error("binding already exists for aibot_session_id");
    }
    this.state.bindings[normalized.aibot_session_id] = normalized;
    await this.save();
    return { ...normalized };
  }

  async markWorkerStarting(aibotSessionID, {
    workerID = "",
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    return this.updateBinding(aibotSessionID, {
      worker_id: workerID,
      worker_status: "starting",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
  }

  async markWorkerConnected(aibotSessionID, {
    workerID = "",
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    return this.updateBinding(aibotSessionID, {
      worker_id: workerID,
      worker_status: "connected",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
  }

  async markWorkerReady(aibotSessionID, {
    workerID = "",
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    return this.updateBinding(aibotSessionID, {
      worker_id: workerID,
      worker_status: "ready",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
  }

  async markWorkerStopped(aibotSessionID, { updatedAt = Date.now(), lastStoppedAt = Date.now() } = {}) {
    return this.updateBinding(aibotSessionID, {
      worker_status: "stopped",
      worker_control_url: "",
      worker_control_token: "",
      updated_at: updatedAt,
      last_stopped_at: lastStoppedAt,
    });
  }

  async markWorkerFailed(aibotSessionID, { updatedAt = Date.now(), lastStoppedAt = Date.now() } = {}) {
    return this.updateBinding(aibotSessionID, {
      worker_status: "failed",
      worker_control_url: "",
      worker_control_token: "",
      updated_at: updatedAt,
      last_stopped_at: lastStoppedAt,
    });
  }

  async updateBinding(aibotSessionID, patch) {
    const normalizedSessionID = normalizeString(aibotSessionID);
    const existing = this.state.bindings[normalizedSessionID];
    if (!existing) {
      throw new Error("binding not found");
    }
    const next = normalizeBinding({
      ...existing,
      ...patch,
      aibot_session_id: existing.aibot_session_id,
      claude_session_id: existing.claude_session_id,
      cwd: existing.cwd,
      plugin_data_dir: patch.plugin_data_dir ?? existing.plugin_data_dir,
      created_at: existing.created_at,
    });
    this.state.bindings[normalizedSessionID] = next;
    await this.save();
    return { ...next };
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJSONFileAtomic(this.filePath, this.state);
  }
}
