const usageText = [
  "usage:",
  "/clawpool-question <request_id> <answer>",
  "/clawpool-question <request_id> 1=first answer; 2=second answer",
].join("\n");

function normalizeString(value) {
  return String(value ?? "").trim();
}

function buildInvalidResult(error) {
  return {
    matched: true,
    ok: false,
    error: `${error}\n${usageText}`,
  };
}

function parseMappedAnswers(payload) {
  const entries = [];
  for (const segment of payload.split(";")) {
    const trimmed = normalizeString(segment);
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return null;
    }
    const key = normalizeString(trimmed.slice(0, separatorIndex));
    const value = normalizeString(trimmed.slice(separatorIndex + 1));
    if (!key || !value) {
      return null;
    }
    entries.push({ key, value });
  }
  return entries.length > 0 ? entries : null;
}

export function parseQuestionResponseCommand(text) {
  const trimmed = normalizeString(text);
  if (!trimmed.startsWith("/clawpool-question")) {
    return {
      matched: false,
    };
  }

  const parts = trimmed.split(/\s+/u);
  if (parts.length < 3) {
    return buildInvalidResult("missing request_id or answer");
  }

  const requestID = normalizeString(parts[1]);
  const answerPayload = normalizeString(trimmed.slice(trimmed.indexOf(requestID) + requestID.length));
  if (!requestID || !answerPayload) {
    return buildInvalidResult("missing request_id or answer");
  }

  const responseText = normalizeString(answerPayload);
  if (!responseText) {
    return buildInvalidResult("missing answer");
  }

  const usesIndexedFormat = /^[1-9][0-9]*\s*=/u.test(responseText) || responseText.includes(";");
  const mappedAnswers = usesIndexedFormat
    ? parseMappedAnswers(responseText)
    : null;
  if (usesIndexedFormat && !mappedAnswers) {
    return buildInvalidResult("invalid indexed answer format");
  }

  return {
    matched: true,
    ok: true,
    request_id: requestID,
    response: mappedAnswers
      ? {
          type: "map",
          entries: mappedAnswers,
        }
      : {
          type: "single",
          value: responseText,
        },
  };
}
