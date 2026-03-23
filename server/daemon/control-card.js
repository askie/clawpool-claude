import { buildMessageCardEnvelope } from "../message-card-envelope.js";

const openCommandPrefix = "/clawpool open";
const openCommandHint = "/clawpool open <working-directory>";

function normalizeString(value) {
  return String(value ?? "").trim();
}

export function buildOpenWorkspaceCard({
  summaryText = "open 缺少目录路径。",
  detailText = "请输入工作目录来启动或恢复 Claude 会话。",
  initialCwd = "",
} = {}) {
  return buildMessageCardEnvelope("claude_open_session", {
    summary_text: normalizeString(summaryText),
    detail_text: normalizeString(detailText),
    command_prefix: openCommandPrefix,
    command_hint: openCommandHint,
    initial_cwd: normalizeString(initialCwd),
  });
}
