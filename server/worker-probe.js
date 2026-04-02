import { randomUUID } from "node:crypto";

const probeChannelNamespace = "grix-claude";
const probeSenderID = "__grix_claude_probe__";
const probeKind = "ping_pong";

export const defaultWorkerPingProbeTimeoutMs = 15 * 1000;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseJSONObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return null;
}

export function buildWorkerPingProbePayload({ sessionID, workerID = "", claudeSessionID = "" } = {}) {
  const probeID = randomUUID();
  const channelData = {
    [probeChannelNamespace]: {
      internal_probe: {
        kind: probeKind,
        probe_id: probeID,
        expected_reply: "pong",
      },
    },
  };

  return {
    event_id: `probe_${probeID}`,
    event_type: "user_chat",
    session_id: normalizeString(sessionID),
    session_type: "1",
    msg_id: `probe_msg_${probeID}`,
    sender_id: probeSenderID,
    owner_id: "",
    agent_id: "",
    msg_type: "1",
    content: "ping",
    created_at: Date.now(),
    worker_id: normalizeString(workerID),
    claude_session_id: normalizeString(claudeSessionID),
    channel_data: channelData,
  };
}

export function extractWorkerProbeMeta(payload) {
  const channelData = parseJSONObject(payload?.channel_data_json)
    ?? parseJSONObject(payload?.channel_data)
    ?? parseJSONObject(payload?.extra)?.channel_data
    ?? parseJSONObject(parseJSONObject(payload?.extra_json)?.channel_data);
  const probe = channelData?.[probeChannelNamespace]?.internal_probe;
  if (!probe || typeof probe !== "object") {
    return null;
  }
  if (normalizeString(probe.kind) !== probeKind) {
    return null;
  }
  const probeID = normalizeString(probe.probe_id);
  if (!probeID) {
    return null;
  }
  return {
    probeID,
    kind: probeKind,
    expectedReply: normalizeString(probe.expected_reply) || "pong",
  };
}

export function isExpectedWorkerProbeReply(text, expectedReply = "pong") {
  return normalizeString(text).toLowerCase() === normalizeString(expectedReply).toLowerCase();
}
