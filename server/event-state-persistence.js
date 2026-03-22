import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";

const schemaVersion = 1;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeResultField(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    status: normalizeString(input.status),
    code: normalizeString(input.code),
    msg: normalizeString(input.msg),
    updated_at: Number(input.updated_at ?? 0),
  };
}

function normalizeStopField(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    stop_id: normalizeString(input.stop_id),
    reason: normalizeString(input.reason),
    updated_at: Number(input.updated_at ?? 0),
  };
}

function normalizeEntry(input) {
  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return null;
  }
  const eventID = normalizeString(input.event_id);
  const sessionID = normalizeString(input.session_id);
  const msgID = normalizeString(input.msg_id);
  if (!eventID || !sessionID || !msgID) {
    return null;
  }
  return {
    schema_version: schemaVersion,
    event_id: eventID,
    session_id: sessionID,
    msg_id: msgID,
    quoted_message_id: normalizeString(input.quoted_message_id),
    sender_id: normalizeString(input.sender_id),
    event_type: normalizeString(input.event_type),
    session_type: normalizeString(input.session_type),
    content: String(input.content ?? ""),
    owner_id: normalizeString(input.owner_id),
    agent_id: normalizeString(input.agent_id),
    msg_type: normalizeString(input.msg_type),
    message_created_at: Number(input.message_created_at ?? 0),
    mention_user_ids: Array.isArray(input.mention_user_ids)
      ? input.mention_user_ids.map((item) => normalizeString(item)).filter((item) => item)
      : [],
    extra_json: String(input.extra_json ?? ""),
    attachments_json: String(input.attachments_json ?? ""),
    attachment_count: normalizeString(input.attachment_count),
    biz_card_json: String(input.biz_card_json ?? ""),
    channel_data_json: String(input.channel_data_json ?? ""),
    acked: input.acked === true,
    ack_at: Number(input.ack_at ?? 0),
    notification_dispatched_at: Number(input.notification_dispatched_at ?? 0),
    pairing_sent_at: Number(input.pairing_sent_at ?? 0),
    pairing_retry_after: Number(input.pairing_retry_after ?? 0),
    result_deadline_at: Number(input.result_deadline_at ?? 0),
    result_intent: normalizeResultField(input.result_intent),
    completed: normalizeResultField(input.completed),
    stopped: normalizeStopField(input.stopped),
    created_at: Number(input.created_at ?? 0),
    last_seen_at: Number(input.last_seen_at ?? 0),
  };
}

export async function saveEventEntry(dir, entry) {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${entry.event_id}.json`);
  await writeJSONFileAtomic(filePath, { schema_version: schemaVersion, ...entry });
}

export async function loadEventEntries(dir, ttlMs) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const now = Date.now();
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, name);
    const raw = await readJSONFile(filePath, null);
    const entry = normalizeEntry(raw);
    if (!entry) {
      continue;
    }
    const terminal = Boolean(entry.completed || entry.stopped);
    const resolvedTTL = terminal
      ? Number(ttlMs?.completedTTLms ?? ttlMs ?? 0)
      : Number(ttlMs?.pendingTTLms ?? ttlMs ?? 0);
    if (resolvedTTL > 0 && now - Number(entry.last_seen_at ?? 0) > resolvedTTL) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}
