const defaultTTLMS = 30 * 60 * 1000;
const defaultPendingTTLMS = 48 * 60 * 60 * 1000;
const defaultPairingCooldownMs = 60 * 1000;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeString(item)).filter((item) => item);
}

function cloneEntry(entry) {
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

export class EventState {
  constructor({
    ttlMs = defaultTTLMS,
    pendingTTLms = defaultPendingTTLMS,
    pairingCooldownMs = defaultPairingCooldownMs,
    onChange = null,
  } = {}) {
    this.ttlMs = ttlMs;
    this.pendingTTLms = pendingTTLms;
    this.pairingCooldownMs = pairingCooldownMs;
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.events = new Map();
  }

  _notify(entry) {
    if (this.onChange) {
      this.onChange(cloneEntry(entry));
    }
  }

  restore(rawEntry) {
    const eventID = normalizeString(rawEntry?.event_id);
    if (!eventID || this.events.has(eventID)) {
      return;
    }
    this.events.set(eventID, JSON.parse(JSON.stringify(rawEntry)));
  }

  registerInbound(payload) {
    const eventID = normalizeString(payload.event_id);
    const sessionID = normalizeString(payload.session_id);
    const msgID = normalizeString(payload.msg_id);
    if (!eventID || !sessionID || !msgID) {
      throw new Error("event_id, session_id, and msg_id are required");
    }

    this.prune();
    const existing = this.events.get(eventID);
    if (existing) {
      existing.last_seen_at = Date.now();
      return {
        duplicate: true,
        event: cloneEntry(existing),
      };
    }

    const now = Date.now();
    const next = {
      event_id: eventID,
      session_id: sessionID,
      msg_id: msgID,
      quoted_message_id: normalizeString(payload.quoted_message_id),
      sender_id: normalizeString(payload.sender_id),
      event_type: normalizeString(payload.event_type),
      session_type: normalizeString(payload.session_type),
      content: String(payload.content ?? ""),
      owner_id: normalizeString(payload.owner_id),
      agent_id: normalizeString(payload.agent_id),
      msg_type: normalizeString(payload.msg_type),
      message_created_at: Number(payload.message_created_at ?? payload.created_at ?? 0),
      mention_user_ids: normalizeStringArray(payload.mention_user_ids),
      extra_json: String(payload.extra_json ?? ""),
      attachments_json: String(payload.attachments_json ?? ""),
      attachment_count: normalizeString(payload.attachment_count),
      biz_card_json: String(payload.biz_card_json ?? ""),
      channel_data_json: String(payload.channel_data_json ?? ""),
      acked: false,
      ack_at: 0,
      notification_dispatched_at: 0,
      pairing_sent_at: 0,
      pairing_retry_after: 0,
      result_deadline_at: 0,
      result_intent: null,
      completed: null,
      stopped: null,
      created_at: now,
      last_seen_at: now,
    };
    this.events.set(eventID, next);
    this._notify(next);
    return {
      duplicate: false,
      event: cloneEntry(next),
    };
  }

  get(eventID) {
    const existing = this.events.get(normalizeString(eventID));
    if (!existing) {
      return null;
    }
    existing.last_seen_at = Date.now();
    return cloneEntry(existing);
  }

  getLatestActiveBySession(sessionID) {
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return null;
    }

    let latest = null;
    for (const entry of this.events.values()) {
      if (normalizeString(entry.session_id) !== normalizedSessionID) {
        continue;
      }
      if (entry.completed || entry.stopped) {
        continue;
      }
      if (!latest || Number(entry.created_at ?? 0) >= Number(latest.created_at ?? 0)) {
        latest = entry;
      }
    }

    if (!latest) {
      return null;
    }
    latest.last_seen_at = Date.now();
    return cloneEntry(latest);
  }

  markAcked(eventID, { ackedAt = Date.now() } = {}) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.acked = true;
    entry.ack_at = Math.floor(ackedAt);
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  markNotificationDispatched(eventID, { dispatchedAt = Date.now() } = {}) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.notification_dispatched_at = Math.floor(dispatchedAt);
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  markPairingSent(eventID, { sentAt = Date.now(), cooldownMs = this.pairingCooldownMs } = {}) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.pairing_sent_at = Math.floor(sentAt);
    entry.pairing_retry_after = Math.floor(sentAt + cooldownMs);
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  canResendPairing(eventID, now = Date.now()) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return false;
    }
    if (!entry.pairing_sent_at) {
      return true;
    }
    return now >= Number(entry.pairing_retry_after ?? 0);
  }

  setResultDeadline(eventID, { deadlineAt } = {}) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.result_deadline_at = Math.floor(deadlineAt ?? 0);
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  clearResultDeadline(eventID) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.result_deadline_at = 0;
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  setResultIntent(eventID, result) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.result_intent = {
      status: normalizeString(result.status),
      code: normalizeString(result.code),
      msg: normalizeString(result.msg),
      updated_at: Number(result.updated_at ?? Date.now()),
    };
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  clearResultIntent(eventID) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.result_intent = null;
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  markCompleted(eventID, result) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.result_deadline_at = 0;
    entry.result_intent = null;
    entry.completed = {
      status: normalizeString(result.status),
      code: normalizeString(result.code),
      msg: normalizeString(result.msg),
      updated_at: Number(result.updated_at ?? Date.now()),
    };
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  markStopped(eventID, stop) {
    const entry = this.events.get(normalizeString(eventID));
    if (!entry) {
      return null;
    }
    entry.stopped = {
      stop_id: normalizeString(stop.stop_id),
      reason: normalizeString(stop.reason),
      updated_at: Number(stop.updated_at ?? Date.now()),
    };
    entry.last_seen_at = Date.now();
    this._notify(entry);
    return cloneEntry(entry);
  }

  prune(now = Date.now()) {
    for (const [eventID, entry] of this.events.entries()) {
      const ttlMs = entry.completed || entry.stopped ? this.ttlMs : this.pendingTTLms;
      if (now - Number(entry.last_seen_at ?? 0) > ttlMs) {
        this.events.delete(eventID);
      }
    }
  }
}
