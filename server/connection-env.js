function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInt(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.floor(numeric);
}

function readFirstNonEmpty(values = []) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function readConnectionEnv(env = process.env) {
  return {
    ws_url: readFirstNonEmpty([
      env.GRIX_CLAUDE_WS_URL,
      env.GRIX_CLAUDE_ENDPOINT,
    ]),
    agent_id: readFirstNonEmpty([
      env.GRIX_CLAUDE_AGENT_ID,
    ]),
    api_key: readFirstNonEmpty([
      env.GRIX_CLAUDE_API_KEY,
    ]),
    outbound_text_chunk_limit: normalizePositiveInt(
      readFirstNonEmpty([
        env.GRIX_CLAUDE_OUTBOUND_TEXT_CHUNK_LIMIT,
        env.GRIX_CLAUDE_TEXT_CHUNK_LIMIT,
      ]),
    ),
  };
}
