function normalizeString(value) {
  return String(value ?? "").trim();
}

function truncateText(value, maxLength = 240) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function buildPermissionRelayCommandText(request) {
  const toolName = normalizeString(request?.tool_name) || "unknown";
  const description = truncateText(request?.description, 200);
  const inputPreview = truncateText(request?.input_preview, 240);
  const lines = [
    `Tool: ${toolName}`,
    description ? `Description: ${description}` : "",
    inputPreview ? `Input: ${inputPreview}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildPermissionRelayRequestText(request) {
  const requestID = normalizeString(request?.request_id);
  const commandText = buildPermissionRelayCommandText(request);
  const lines = [
    "Claude needs permission to continue this Grix turn.",
    `Request ID: ${requestID}`,
    commandText,
    `Reply "yes ${requestID}" to allow once, or "no ${requestID}" to deny.`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildPermissionRelayVerdictText({ requestID, behavior }) {
  const normalizedRequestID = normalizeString(requestID);
  const normalizedBehavior = normalizeString(behavior);
  if (normalizedBehavior === "allow") {
    return `Allow reply for request ${normalizedRequestID} sent to Claude.`;
  }
  return `Deny reply for request ${normalizedRequestID} sent to Claude.`;
}
