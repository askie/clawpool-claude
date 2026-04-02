function normalizeString(value) {
  return String(value ?? "").trim();
}

function stringifyCompact(value, maxLength = 240) {
  const text = JSON.stringify(value);
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatToolDetails(request) {
  const toolName = normalizeString(request.tool_name);
  const toolInput = request.tool_input ?? {};

  if (toolName === "Bash") {
    return [
      `Tool: ${toolName}`,
      `Command: ${normalizeString(toolInput.command) || stringifyCompact(toolInput)}`,
      normalizeString(toolInput.description)
        ? `Description: ${normalizeString(toolInput.description)}`
        : "",
    ].filter(Boolean);
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    return [
      `Tool: ${toolName}`,
      `Path: ${normalizeString(toolInput.file_path) || stringifyCompact(toolInput)}`,
    ].filter(Boolean);
  }

  if (toolName === "WebFetch") {
    return [
      `Tool: ${toolName}`,
      `URL: ${normalizeString(toolInput.url) || stringifyCompact(toolInput)}`,
    ].filter(Boolean);
  }

  return [
    `Tool: ${toolName || "unknown"}`,
    `Input: ${stringifyCompact(toolInput)}`,
  ];
}

function formatPermissionSuggestions(requestID, suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return [];
  }

  const lines = ["Rule suggestions:"];
  suggestions.forEach((suggestion, index) => {
    lines.push(`${index + 1}. ${stringifyCompact(suggestion, 180)}`);
    lines.push(`   Apply: /grix-approval ${requestID} allow-rule ${index + 1}`);
  });
  return lines;
}

export function buildApprovalCardCommandText(request) {
  const requestID = normalizeString(request.request_id);
  const detailLines = formatToolDetails(request);
  const suggestionLines = formatPermissionSuggestions(requestID, request.permission_suggestions);
  const lines = [
    ...detailLines,
    ...(suggestionLines.length > 0 ? ["", ...suggestionLines] : []),
  ];
  return lines.join("\n").trim();
}

export function buildApprovalDecisionCommands(request) {
  const requestID = normalizeString(request.request_id);
  const decisionCommands = {
    "allow-once": `/grix-approval ${requestID} allow`,
    deny: `/grix-approval ${requestID} deny`,
  };
  const allowedDecisions = ["allow-once"];

  const suggestions = Array.isArray(request?.permission_suggestions)
    ? request.permission_suggestions
    : [];
  suggestions.forEach((_, index) => {
    const key = `allow-rule:${index + 1}`;
    allowedDecisions.push(key);
    decisionCommands[key] = `/grix-approval ${requestID} allow-rule ${index + 1}`;
  });

  allowedDecisions.push("deny");
  return {
    allowedDecisions,
    decisionCommands,
  };
}

export function buildApprovalRequestText(request) {
  const requestID = normalizeString(request.request_id);
  const lines = [
    "Claude needs permission to continue this Grix turn.",
    `Request ID: ${requestID}`,
    ...formatToolDetails(request),
    `Approve once: /grix-approval ${requestID} allow`,
    `Deny: /grix-approval ${requestID} deny optional reason`,
    ...formatPermissionSuggestions(requestID, request.permission_suggestions),
  ];
  return lines.join("\n");
}

export function buildApprovalDecisionResponseText({ requestID, resolution }) {
  if (resolution.type === "allow") {
    return `Approval request ${requestID} allowed once.`;
  }
  if (resolution.type === "allow-rule") {
    return `Approval request ${requestID} allowed with saved rule ${resolution.suggestion_index}.`;
  }
  return `Approval request ${requestID} denied.`;
}
