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
    plugin_data_dir: normalizeString(input.plugin_data_dir),
    created_at: normalizeTimestamp(input.created_at),
    updated_at: normalizeTimestamp(input.updated_at),
  };
}

function normalizeState(input) {
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

export class SessionBindingStore {
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
    return Object.values(this.state.bindings)
      .map((binding) => ({ ...binding }))
      .sort((left, right) => left.aibot_session_id.localeCompare(right.aibot_session_id));
  }

  get(aibotSessionID) {
    const normalized = normalizeString(aibotSessionID);
    if (!normalized) {
      return null;
    }
    const binding = this.state.bindings[normalized];
    return binding ? { ...binding } : null;
  }

  async create(input) {
    const normalized = normalizeBinding({
      ...input,
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

  async updateClaudeSessionID(aibotSessionID, claudeSessionID, { updatedAt = Date.now() } = {}) {
    const normalizedAibotSessionID = normalizeString(aibotSessionID);
    const normalizedClaudeSessionID = normalizeString(claudeSessionID);
    if (!normalizedAibotSessionID || !normalizedClaudeSessionID) {
      throw new Error("aibot_session_id and claude_session_id are required");
    }

    const existing = this.state.bindings[normalizedAibotSessionID];
    if (!existing) {
      throw new Error("binding not found");
    }

    const next = normalizeBinding({
      ...existing,
      claude_session_id: normalizedClaudeSessionID,
      updated_at: updatedAt,
    });
    if (!next) {
      throw new Error("valid binding is required");
    }

    this.state.bindings[normalizedAibotSessionID] = next;
    await this.save();
    return { ...next };
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJSONFileAtomic(this.filePath, this.state);
  }
}
