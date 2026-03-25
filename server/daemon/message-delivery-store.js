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

function normalizeDeliveryState(value) {
  const normalized = normalizeString(value);
  if (
    normalized === "pending"
    || normalized === "dispatching"
    || normalized === "delivered"
    || normalized === "interrupted"
  ) {
    return normalized;
  }
  return "pending";
}

function cloneRawPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return {};
  }
  return { ...rawPayload };
}

function normalizeEventRoute(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const eventID = normalizeString(input.event_id);
  const sessionID = normalizeString(input.session_id);
  if (!eventID || !sessionID) {
    return null;
  }

  return {
    schema_version: schemaVersion,
    event_id: eventID,
    session_id: sessionID,
    updated_at: normalizeTimestamp(input.updated_at),
  };
}

function normalizePendingEvent(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const eventID = normalizeString(input.event_id);
  const sessionID = normalizeString(input.session_id);
  if (!eventID || !sessionID) {
    return null;
  }

  const deliveryAttempts = Number(input.delivery_attempts);
  return {
    schema_version: schemaVersion,
    event_id: eventID,
    session_id: sessionID,
    msg_id: normalizeString(input.msg_id),
    raw_payload: cloneRawPayload(input.raw_payload),
    delivery_attempts: Number.isFinite(deliveryAttempts) && deliveryAttempts >= 0
      ? Math.floor(deliveryAttempts)
      : 0,
    delivery_state: normalizeDeliveryState(input.delivery_state),
    last_worker_id: normalizeString(input.last_worker_id),
    updated_at: normalizeTimestamp(input.updated_at),
  };
}

function normalizeState(input) {
  const eventRoutes = {};
  const pendingEvents = {};
  const recentRevokes = {};

  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return {
      schema_version: schemaVersion,
      event_routes: eventRoutes,
      pending_events: pendingEvents,
      recent_revokes: recentRevokes,
    };
  }

  for (const [key, rawRoute] of Object.entries(input.event_routes ?? {})) {
    const normalizedKey = normalizeString(key);
    const route = normalizeEventRoute(rawRoute);
    if (!normalizedKey || !route || route.event_id !== normalizedKey) {
      continue;
    }
    eventRoutes[normalizedKey] = route;
  }

  for (const [key, rawPendingEvent] of Object.entries(input.pending_events ?? {})) {
    const normalizedKey = normalizeString(key);
    const pendingEvent = normalizePendingEvent(rawPendingEvent);
    if (!normalizedKey || !pendingEvent || pendingEvent.event_id !== normalizedKey) {
      continue;
    }
    pendingEvents[normalizedKey] = pendingEvent;
  }

  for (const [key, rawTimestamp] of Object.entries(input.recent_revokes ?? {})) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) {
      continue;
    }
    recentRevokes[normalizedKey] = normalizeTimestamp(rawTimestamp);
  }

  return {
    schema_version: schemaVersion,
    event_routes: eventRoutes,
    pending_events: pendingEvents,
    recent_revokes: recentRevokes,
  };
}

function toPendingRecord(record) {
  if (!record) {
    return null;
  }
  return {
    eventID: record.event_id,
    sessionID: record.session_id,
    msgID: record.msg_id,
    rawPayload: cloneRawPayload(record.raw_payload),
    delivery_attempts: record.delivery_attempts,
    delivery_state: record.delivery_state,
    last_worker_id: record.last_worker_id,
    updated_at: record.updated_at,
  };
}

export class MessageDeliveryStore {
  constructor(filePath = "") {
    this.filePath = normalizeString(filePath);
    this.state = normalizeState(null);
  }

  async load() {
    if (!this.filePath) {
      this.state = normalizeState(null);
      return this.listPendingEvents();
    }

    const stored = await readJSONFile(this.filePath, null);
    this.state = normalizeState(stored);
    return this.listPendingEvents();
  }

  getRememberedSessionID(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return "";
    }
    return normalizeString(this.state.event_routes[normalizedEventID]?.session_id);
  }

  getPendingEvent(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return null;
    }
    return toPendingRecord(this.state.pending_events[normalizedEventID]);
  }

  listPendingEvents() {
    return Object.values(this.state.pending_events)
      .map((record) => toPendingRecord(record))
      .sort((left, right) => left.eventID.localeCompare(right.eventID));
  }

  listPendingEventsForSession(sessionID) {
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return [];
    }
    return this.listPendingEvents()
      .filter((record) => record.sessionID === normalizedSessionID);
  }

  hasRecentRevoke(revokeKey, { retentionMs = 0, now = Date.now() } = {}) {
    const normalizedRevokeKey = normalizeString(revokeKey);
    if (!normalizedRevokeKey) {
      return false;
    }
    this.purgeExpiredRecentRevokes({ retentionMs, now });
    return Object.hasOwn(this.state.recent_revokes, normalizedRevokeKey);
  }

  async rememberRecentRevoke(revokeKey, { retentionMs = 0, now = Date.now() } = {}) {
    const normalizedRevokeKey = normalizeString(revokeKey);
    if (!normalizedRevokeKey) {
      return false;
    }
    this.purgeExpiredRecentRevokes({ retentionMs, now });
    this.state.recent_revokes[normalizedRevokeKey] = normalizeTimestamp(now);
    await this.save();
    return true;
  }

  purgeExpiredRecentRevokes({ retentionMs = 0, now = Date.now() } = {}) {
    const normalizedRetentionMs = Math.max(0, Math.floor(Number(retentionMs) || 0));
    if (normalizedRetentionMs <= 0) {
      if (Object.keys(this.state.recent_revokes).length > 0) {
        this.state.recent_revokes = {};
      }
      return false;
    }

    const expireBefore = normalizeTimestamp(now) - normalizedRetentionMs;
    let changed = false;
    for (const [revokeKey, recordedAt] of Object.entries(this.state.recent_revokes)) {
      if (Number(recordedAt) <= expireBefore) {
        delete this.state.recent_revokes[revokeKey];
        changed = true;
      }
    }
    return changed;
  }

  async trackPendingEvent(rawPayload) {
    const pendingEvent = normalizePendingEvent({
      event_id: rawPayload?.event_id,
      session_id: rawPayload?.session_id,
      msg_id: rawPayload?.msg_id,
      raw_payload: rawPayload,
      delivery_attempts: 0,
      delivery_state: "pending",
      last_worker_id: "",
      updated_at: Date.now(),
    });
    if (!pendingEvent) {
      return null;
    }

    const existing = this.state.pending_events[pendingEvent.event_id];
    if (existing) {
      return toPendingRecord(existing);
    }

    this.state.event_routes[pendingEvent.event_id] = normalizeEventRoute({
      event_id: pendingEvent.event_id,
      session_id: pendingEvent.session_id,
      updated_at: Date.now(),
    });
    this.state.pending_events[pendingEvent.event_id] = pendingEvent;
    await this.save();
    return toPendingRecord(pendingEvent);
  }

  async markPendingEventDelivered(eventID, workerID = "") {
    return this.updatePendingEvent(eventID, {
      delivery_attempts_delta: 1,
      delivery_state: "delivered",
      last_worker_id: workerID,
    });
  }

  async markPendingEventDispatching(eventID, workerID = "") {
    return this.updatePendingEvent(eventID, {
      delivery_attempts_delta: 1,
      delivery_state: "dispatching",
      last_worker_id: workerID,
    });
  }

  async markPendingEventPending(eventID) {
    return this.updatePendingEvent(eventID, {
      delivery_state: "pending",
    });
  }

  async markPendingEventInterrupted(eventID) {
    return this.updatePendingEvent(eventID, {
      delivery_state: "interrupted",
    });
  }

  async touchPendingEvent(eventID) {
    return this.updatePendingEvent(eventID);
  }

  async clearEventState(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return false;
    }

    const hadRoute = Boolean(this.state.event_routes[normalizedEventID]);
    const hadPendingEvent = Boolean(this.state.pending_events[normalizedEventID]);
    if (!hadRoute && !hadPendingEvent) {
      return false;
    }

    delete this.state.event_routes[normalizedEventID];
    delete this.state.pending_events[normalizedEventID];
    await this.save();
    return true;
  }

  async save() {
    if (!this.filePath) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJSONFileAtomic(this.filePath, this.state);
  }

  async updatePendingEvent(eventID, patch = {}) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return null;
    }

    const existing = this.state.pending_events[normalizedEventID];
    if (!existing) {
      return null;
    }

    const next = normalizePendingEvent({
      ...existing,
      delivery_attempts: existing.delivery_attempts + Number(patch.delivery_attempts_delta ?? 0),
      delivery_state: patch.delivery_state ?? existing.delivery_state,
      last_worker_id: patch.last_worker_id ?? existing.last_worker_id,
      updated_at: Date.now(),
    });
    this.state.pending_events[normalizedEventID] = next;
    await this.save();
    return toPendingRecord(next);
  }
}
