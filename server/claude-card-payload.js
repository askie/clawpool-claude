import {
  buildApprovalCardCommandText,
  buildApprovalDecisionCommands,
} from "./approval-text.js";
import {
  buildQuestionAnswerCommandHint,
  buildQuestionFooterText,
} from "./question-text.js";
import { buildMessageCardEnvelope } from "./message-card-envelope.js";

const claudeHostLabel = "Claude Clawpool";
const pairingCommandHint = "/clawpool:access pair <code>";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeQuestionOptions(question) {
  if (!Array.isArray(question?.options)) {
    return [];
  }
  return question.options
    .map((option) => normalizeString(option?.label))
    .filter(Boolean);
}

export function buildApprovalRequestBizCard(request) {
  const requestID = normalizeString(request?.request_id);
  const { allowedDecisions, decisionCommands } = buildApprovalDecisionCommands(request);
  return buildMessageCardEnvelope("exec_approval", {
    approval_id: requestID,
    approval_slug: requestID,
    approval_command_id: requestID,
    command: buildApprovalCardCommandText(request),
    host: claudeHostLabel,
    allowed_decisions: allowedDecisions,
    decision_commands: decisionCommands,
  });
}

export function buildApprovalResolutionBizCard({
  request,
  resolution,
  summary,
  resolvedByID = "",
}) {
  let status = "resolved-deny";
  let decision = "deny";
  let detailText = "";

  if (resolution?.type === "allow") {
    status = "resolved-allow-once";
    decision = "allow-once";
  } else if (resolution?.type === "allow-rule") {
    status = "resolved-allow-rule";
    decision = "allow-rule";
    detailText = `Saved rule: ${resolution.suggestion_index}`;
  }

  return buildMessageCardEnvelope("exec_status", {
    status,
    summary: normalizeString(summary),
    detail_text: detailText,
    approval_id: normalizeString(request?.request_id),
    approval_command_id: normalizeString(request?.request_id),
    host: claudeHostLabel,
    decision,
    resolved_by_id: normalizeString(resolvedByID),
    command: buildApprovalCardCommandText(request),
    channel_label: claudeHostLabel,
  });
}

export function buildApprovalCommandStatusBizCard({
  summary,
  referenceID = "",
  detailText = "",
  status = "warning",
}) {
  return buildMessageCardEnvelope("claude_status", {
    category: "approval",
    status,
    summary: normalizeString(summary),
    detail_text: normalizeString(detailText),
    reference_id: normalizeString(referenceID),
  });
}

export function buildQuestionRequestBizCard(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  return buildMessageCardEnvelope("claude_question", {
    request_id: normalizeString(request?.request_id),
    questions: questions.map((question, index) => ({
      index: index + 1,
      header: normalizeString(question?.header) || `Question ${index + 1}`,
      prompt: normalizeString(question?.question) || "(missing question text)",
      options: normalizeQuestionOptions(question),
      multi_select: question?.multiSelect === true,
    })),
    answer_command_hint: buildQuestionAnswerCommandHint(request),
    footer_text: buildQuestionFooterText(),
  });
}

export function buildQuestionStatusBizCard({
  summary,
  referenceID = "",
  detailText = "",
  status = "warning",
}) {
  return buildMessageCardEnvelope("claude_status", {
    category: "question",
    status,
    summary: normalizeString(summary),
    detail_text: normalizeString(detailText),
    reference_id: normalizeString(referenceID),
  });
}

export function buildAccessStatusBizCard({
  summary,
  detailText = "",
  status = "info",
  referenceID = "",
}) {
  return buildMessageCardEnvelope("claude_status", {
    category: "access",
    status,
    summary: normalizeString(summary),
    detail_text: normalizeString(detailText),
    reference_id: normalizeString(referenceID),
  });
}

export function buildPairingBizCard(pairingCode) {
  return buildMessageCardEnvelope("claude_pairing", {
    pairing_code: normalizeString(pairingCode),
    instruction_text: `Ask the Claude Code user to run ${pairingCommandHint} with this code to approve the sender.`,
    command_hint: pairingCommandHint,
  });
}
