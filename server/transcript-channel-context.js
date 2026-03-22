import { readFile } from "node:fs/promises";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseTagAttributes(fragment) {
  const attributes = {};
  const pattern = /([a-zA-Z0-9_:-]+)=("([^"]*)"|'([^']*)')/g;
  for (const match of fragment.matchAll(pattern)) {
    const key = normalizeString(match[1]);
    const value = normalizeString(match[3] ?? match[4]);
    if (key && value) {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function extractLatestClawpoolChannelTag(text) {
  const pattern = /<channel\b([^>]*)>/gi;
  const matches = Array.from(String(text ?? "").matchAll(pattern));
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const attributes = parseTagAttributes(match[1] ?? "");
    if (normalizeString(attributes.source) !== "clawpool-claude") {
      continue;
    }
    return {
      raw_tag: match[0],
      chat_id: normalizeString(attributes.chat_id),
      event_id: normalizeString(attributes.event_id),
      message_id: normalizeString(attributes.message_id),
      sender_id: normalizeString(attributes.sender_id),
      user_id: normalizeString(attributes.user_id),
      msg_id: normalizeString(attributes.msg_id),
    };
  }
  return null;
}

function extractTagFromValue(value) {
  if (typeof value === "string") {
    return extractLatestClawpoolChannelTag(value);
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const nested = extractTagFromValue(value[index]);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const nested = extractTagFromValue(entries[index][1]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function collectTagsFromValue(value, results) {
  if (typeof value === "string") {
    const pattern = /<channel\b([^>]*)>/gi;
    for (const match of String(value).matchAll(pattern)) {
      const attributes = parseTagAttributes(match[1] ?? "");
      if (normalizeString(attributes.source) !== "clawpool-claude") {
        continue;
      }
      results.push({
        raw_tag: match[0],
        chat_id: normalizeString(attributes.chat_id),
        event_id: normalizeString(attributes.event_id),
        message_id: normalizeString(attributes.message_id),
        sender_id: normalizeString(attributes.sender_id),
        user_id: normalizeString(attributes.user_id),
        msg_id: normalizeString(attributes.msg_id),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTagsFromValue(item, results);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectTagsFromValue(entry, results);
    }
  }
}

function extractTagsFromLine(line) {
  const trimmed = normalizeString(line);
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    const results = [];
    collectTagsFromValue(parsed, results);
    return results;
  } catch {
    const results = [];
    collectTagsFromValue(trimmed, results);
    return results;
  }
}

async function listClawpoolChannelContexts(transcriptPath) {
  const normalizedPath = normalizeString(transcriptPath);
  if (!normalizedPath) {
    return [];
  }

  let raw;
  try {
    raw = await readFile(normalizedPath, "utf8");
  } catch {
    return [];
  }

  const results = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    results.push(...extractTagsFromLine(line));
  }
  return results.filter((tag) => tag?.chat_id);
}

export async function extractLatestClawpoolChannelContext(transcriptPath) {
  const contexts = await listClawpoolChannelContexts(transcriptPath);
  return contexts.length > 0 ? contexts[contexts.length - 1] : null;
}

export async function resolveTranscriptClawpoolChannelContext(transcriptPath) {
  const contexts = await listClawpoolChannelContexts(transcriptPath);
  if (contexts.length === 0) {
    return {
      status: "missing",
      context: null,
      unique_chat_ids: [],
    };
  }

  const uniqueChatIDs = Array.from(
    new Set(contexts.map((context) => normalizeString(context.chat_id)).filter(Boolean)),
  );
  if (uniqueChatIDs.length !== 1) {
    return {
      status: "ambiguous",
      context: null,
      latest_context: contexts[contexts.length - 1],
      unique_chat_ids: uniqueChatIDs,
    };
  }

  return {
    status: "resolved",
    context: contexts[contexts.length - 1],
    unique_chat_ids: uniqueChatIDs,
  };
}
