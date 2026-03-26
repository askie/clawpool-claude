import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";
import { formatTraceLine } from "./logging.js";
import { resolvePluginDataDir } from "./paths.js";

const schemaVersion = 1;
const defaultRecentEventLimit = 20;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function pickHookEventDetail(input = {}, hookEventName) {
  if (hookEventName === "SessionStart") {
    return normalizeString(input.source);
  }
  if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
    return normalizeString(input.tool_name);
  }
  if (hookEventName === "Elicitation") {
    return normalizeString(input.mode);
  }
  if (hookEventName === "Notification") {
    return normalizeString(input.matcher)
      || normalizeString(input.notification_type)
      || normalizeString(input.type);
  }
  return "";
}

function normalizeHookSignalEvent(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const hookEventName = normalizeString(input.hook_event_name);
  const eventID = normalizeString(input.event_id);
  if (!hookEventName || !eventID) {
    return null;
  }

  return {
    event_id: eventID,
    hook_event_name: hookEventName,
    event_at: normalizeOptionalTimestamp(input.event_at),
    detail: normalizeString(input.detail),
    tool_name: normalizeString(input.tool_name),
    session_id: normalizeString(input.session_id),
    cwd: normalizeString(input.cwd),
    transcript_path: normalizeString(input.transcript_path),
  };
}

function normalizeState(input) {
  const empty = {
    schema_version: schemaVersion,
    updated_at: 0,
    latest_event: null,
    recent_events: [],
  };
  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return empty;
  }

  return {
    schema_version: schemaVersion,
    updated_at: normalizeOptionalTimestamp(input.updated_at),
    latest_event: normalizeHookSignalEvent(input.latest_event),
    recent_events: Array.isArray(input.recent_events)
      ? input.recent_events
        .map((item) => normalizeHookSignalEvent(item))
        .filter(Boolean)
      : [],
  };
}

export function resolveHookSignalsPath(pluginID) {
  return path.join(resolvePluginDataDir(pluginID), "hook-signals.json");
}

export function resolveHookSignalsPathFromDataDir(pluginDataDir, pluginID) {
  const normalizedDir = normalizeString(pluginDataDir);
  if (normalizedDir) {
    return path.join(normalizedDir, "hook-signals.json");
  }
  return resolveHookSignalsPath(pluginID);
}

export function resolveHookSignalsLogPath(pluginID) {
  return path.join(resolvePluginDataDir(pluginID), "hook-signals.log");
}

export function resolveHookSignalsLogPathFromDataDir(pluginDataDir, pluginID) {
  const normalizedDir = normalizeString(pluginDataDir);
  if (normalizedDir) {
    return path.join(normalizedDir, "hook-signals.log");
  }
  return resolveHookSignalsLogPath(pluginID);
}

export function buildHookSignalEvent(input, { recordedAt = Date.now() } = {}) {
  const hookEventName = normalizeString(input?.hook_event_name);
  if (!hookEventName) {
    return null;
  }

  return {
    event_id: randomUUID(),
    hook_event_name: hookEventName,
    event_at: normalizeOptionalTimestamp(recordedAt) || Date.now(),
    detail: pickHookEventDetail(input, hookEventName),
    tool_name: normalizeString(input?.tool_name),
    session_id: normalizeString(input?.session_id),
    cwd: normalizeString(input?.cwd),
    transcript_path: normalizeString(input?.transcript_path),
  };
}

export function summarizeHookSignalEvent(event) {
  const normalized = normalizeHookSignalEvent(event);
  if (!normalized) {
    return "";
  }
  if (normalized.detail) {
    return `${normalized.hook_event_name}:${normalized.detail}`;
  }
  return normalized.hook_event_name;
}

export class HookSignalStore {
  constructor(
    filePath = resolveHookSignalsPath(),
    { logPath = path.join(path.dirname(filePath), "hook-signals.log") } = {},
  ) {
    this.filePath = filePath;
    this.logPath = logPath;
  }

  async readState() {
    const stored = await readJSONFile(this.filePath, null);
    return normalizeState(stored);
  }

  async writeState(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJSONFileAtomic(this.filePath, normalizeState(state));
  }

  async reset() {
    await this.writeState(normalizeState(null));
    return this.readState();
  }

  async appendEventLog(event) {
    const normalized = normalizeHookSignalEvent(event);
    if (!normalized) {
      return false;
    }
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${formatTraceLine({
      stage: "hook_signal_recorded",
      event_id: normalized.event_id,
      hook_event_name: normalized.hook_event_name,
      hook_detail: normalized.detail,
      event_at: normalized.event_at,
      tool_name: normalized.tool_name,
      session_id: normalized.session_id,
      cwd: normalized.cwd,
      transcript_path: normalized.transcript_path,
    })}\n`, "utf8");
    return true;
  }

  async recordHookEvent(input, {
    recordedAt = Date.now(),
    recentEventLimit = defaultRecentEventLimit,
  } = {}) {
    const nextEvent = buildHookSignalEvent(input, { recordedAt });
    if (!nextEvent) {
      return this.readState();
    }

    const current = await this.readState();
    const nextState = {
      schema_version: schemaVersion,
      updated_at: nextEvent.event_at,
      latest_event: nextEvent,
      recent_events: [
        ...current.recent_events,
        nextEvent,
      ].slice(-Math.max(1, Number(recentEventLimit) || defaultRecentEventLimit)),
    };
    await this.writeState(nextState);
    await this.appendEventLog(nextEvent);
    return normalizeState(nextState);
  }
}
