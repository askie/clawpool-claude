function normalizeString(value) {
  return String(value ?? "").trim();
}

function compactRecord(source) {
  const target = {};
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        target[key] = value.join(",");
      }
      continue;
    }
    if (normalizeString(value)) {
      target[key] = normalizeString(value);
    }
  }
  return target;
}

function formatTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return new Date(numeric).toISOString();
}

function resolveEventType(event) {
  const explicit = normalizeString(event?.event_type);
  if (explicit) {
    return explicit;
  }
  return normalizeString(event?.session_type) === "2" ? "group_message" : "user_chat";
}

export function buildChannelNotificationParams(event) {
  return {
    content: String(event?.content ?? ""),
    meta: compactRecord({
      chat_id: event?.session_id,
      event_id: event?.event_id,
      event_type: resolveEventType(event),
      message_id: event?.msg_id,
      sender_id: event?.sender_id,
      user: event?.sender_id,
      user_id: event?.sender_id,
      msg_id: event?.msg_id,
      quoted_message_id: event?.quoted_message_id,
      session_type: event?.session_type,
      msg_type: event?.msg_type,
      ts: formatTimestamp(event?.message_created_at),
      mention_user_ids: Array.isArray(event?.mention_user_ids) ? event.mention_user_ids : [],
      owner_id: event?.owner_id,
      agent_id: event?.agent_id,
      extra_json: event?.extra_json,
      attachments_json: event?.attachments_json,
      attachment_count: event?.attachment_count,
      biz_card_json: event?.biz_card_json,
      channel_data_json: event?.channel_data_json,
    }),
  };
}

export function shouldReplayRestoredEvent(event) {
  return (
    normalizeString(event?.event_id) !== "" &&
    event?.acked === true &&
    !event?.completed &&
    !event?.stopped &&
    !event?.result_intent
  );
}
