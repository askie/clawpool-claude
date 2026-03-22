function normalizeString(value) {
  return String(value ?? "").trim();
}

function buildUsageText() {
  return [
    "usage:",
    "/clawpool-approval <request_id> allow",
    "/clawpool-approval <request_id> allow-rule <index>",
    "/clawpool-approval <request_id> deny [reason]",
  ].join("\n");
}

export function parseApprovalDecisionCommand(content) {
  const body = normalizeString(content);
  if (!body.toLowerCase().startsWith("/clawpool-approval")) {
    return {
      matched: false,
    };
  }

  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    return {
      matched: true,
      ok: false,
      error: buildUsageText(),
    };
  }

  const requestID = normalizeString(parts[1]);
  const action = normalizeString(parts[2]).toLowerCase();
  if (!requestID) {
    return {
      matched: true,
      ok: false,
      error: buildUsageText(),
    };
  }

  if (action === "allow") {
    if (parts.length !== 3) {
      return {
        matched: true,
        ok: false,
        error: buildUsageText(),
      };
    }
    return {
      matched: true,
      ok: true,
      request_id: requestID,
      resolution: {
        type: "allow",
      },
    };
  }

  if (action === "allow-rule") {
    const index = Number(parts[3] ?? 0);
    if (!Number.isInteger(index) || index <= 0 || parts.length !== 4) {
      return {
        matched: true,
        ok: false,
        error: buildUsageText(),
      };
    }
    return {
      matched: true,
      ok: true,
      request_id: requestID,
      resolution: {
        type: "allow-rule",
        suggestion_index: index,
      },
    };
  }

  if (action === "deny") {
    return {
      matched: true,
      ok: true,
      request_id: requestID,
      resolution: {
        type: "deny",
        reason: normalizeString(parts.slice(3).join(" ")),
      },
    };
  }

  return {
    matched: true,
    ok: false,
    error: buildUsageText(),
  };
}
