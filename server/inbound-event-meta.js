function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  return normalizeString(value) || "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeString(item)).filter((item) => item);
}

function normalizeJSONObject(value) {
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

function normalizeJSONArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeAttachmentRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const attachment = {
    attachment_type: normalizeOptionalString(value.attachment_type),
    media_url: normalizeOptionalString(value.media_url),
    file_name: normalizeOptionalString(value.file_name),
    content_type: normalizeOptionalString(value.content_type),
  };
  if (
    !attachment.attachment_type &&
    !attachment.media_url &&
    !attachment.file_name &&
    !attachment.content_type
  ) {
    return null;
  }
  return attachment;
}

function deriveAttachments(payload, extra) {
  const explicit = normalizeJSONArray(payload.attachments)
    .map((item) => normalizeAttachmentRecord(item))
    .filter(Boolean);
  if (explicit.length > 0) {
    return explicit;
  }

  const extraAttachments = normalizeJSONArray(extra?.attachments)
    .map((item) => normalizeAttachmentRecord(item))
    .filter(Boolean);
  if (extraAttachments.length > 0) {
    return extraAttachments;
  }

  const single = normalizeAttachmentRecord({
    attachment_type: payload.attachment_type ?? extra?.attachment_type,
    media_url: payload.media_url ?? extra?.media_url,
    file_name: payload.file_name ?? extra?.file_name,
    content_type: payload.content_type ?? extra?.content_type,
  });
  return single ? [single] : [];
}

function stringifyJSON(value) {
  if (!value) {
    return "";
  }
  if (Array.isArray(value) && value.length === 0) {
    return "";
  }
  if (!Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0) {
    return "";
  }
  return JSON.stringify(value);
}

export function normalizeInboundEventPayload(rawPayload) {
  const extra = normalizeJSONObject(rawPayload.extra);
  const attachments = deriveAttachments(rawPayload, extra);
  const bizCard = normalizeJSONObject(rawPayload.biz_card) ?? normalizeJSONObject(extra?.biz_card);
  const channelData =
    normalizeJSONObject(rawPayload.channel_data) ?? normalizeJSONObject(extra?.channel_data);

  return {
    event_id: normalizeString(rawPayload.event_id),
    event_type: normalizeString(rawPayload.event_type),
    session_id: normalizeString(rawPayload.session_id),
    session_type: normalizeOptionalString(rawPayload.session_type),
    msg_id: normalizeString(rawPayload.msg_id),
    quoted_message_id: normalizeOptionalString(rawPayload.quoted_message_id),
    sender_id: normalizeString(rawPayload.sender_id),
    owner_id: normalizeOptionalString(rawPayload.owner_id),
    agent_id: normalizeOptionalString(rawPayload.agent_id),
    msg_type: normalizeOptionalString(rawPayload.msg_type),
    created_at: Number(rawPayload.created_at ?? 0),
    mention_user_ids: normalizeStringArray(rawPayload.mention_user_ids),
    content: String(rawPayload.content ?? ""),
    extra_json: stringifyJSON(extra),
    attachments_json: stringifyJSON(attachments),
    attachment_count: attachments.length > 0 ? String(attachments.length) : "",
    biz_card_json: stringifyJSON(bizCard),
    channel_data_json: stringifyJSON(channelData),
  };
}
