const AIBOT_PROTOCOL_MAX_RUNES = 2000;
const AIBOT_PROTOCOL_MAX_BYTES = 12 * 1024;

function normalizePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

export function resolveOutboundTextChunkLimit(value, fallbackValue = 1200) {
  return Math.min(
    AIBOT_PROTOCOL_MAX_RUNES,
    normalizePositiveInt(value, fallbackValue),
  );
}

export function splitTextForAibotProtocol(text, preferredRunes) {
  const source = String(text ?? "");
  if (!source) {
    return [];
  }

  const runeLimit = resolveOutboundTextChunkLimit(preferredRunes, 1200);
  const chunks = [];
  let current = "";
  let currentRunes = 0;
  let currentBytes = 0;

  for (const rune of source) {
    const runeBytes = Buffer.byteLength(rune, "utf8");
    const nextRunes = currentRunes + 1;
    const nextBytes = currentBytes + runeBytes;
    if (
      current &&
      (nextRunes > runeLimit || nextBytes > AIBOT_PROTOCOL_MAX_BYTES)
    ) {
      chunks.push(current);
      current = "";
      currentRunes = 0;
      currentBytes = 0;
    }

    current += rune;
    currentRunes += 1;
    currentBytes += runeBytes;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}
