import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AccessStore } from "./access-store.js";
import { AibotClient } from "./aibot-client.js";
import { uploadReplyFileToAgentMedia } from "./agent-api-media.js";
import { parseApprovalDecisionCommand } from "./approval-command.js";
import { ApprovalStore } from "./approval-store.js";
import {
  buildApprovalDecisionResponseText,
  buildApprovalRequestText,
} from "./approval-text.js";
import { ChannelContextStore } from "./channel-context-store.js";
import { ConfigStore } from "./config-store.js";
import { EventState } from "./event-state.js";
import { parseQuestionResponseCommand } from "./question-command.js";
import { buildAskUserQuestionUpdatedInput } from "./question-response.js";
import { QuestionStore } from "./question-store.js";
import {
  buildQuestionRequestText,
  buildQuestionResponseText,
} from "./question-text.js";
import {
  resolveAccessPath,
  resolveApprovalNotificationsDir,
  resolveApprovalRequestsDir,
  resolveConfigPath,
  resolveEventStatesDir,
  resolveQuestionRequestsDir,
  resolveSessionContextsDir,
} from "./paths.js";
import { saveEventEntry, loadEventEntries } from "./event-state-persistence.js";
import {
  buildChannelNotificationParams,
  shouldReplayRestoredEvent,
} from "./channel-notification.js";
import {
  resolveOutboundTextChunkLimit,
  splitTextForAibotProtocol,
} from "./protocol-text.js";
import { ResultTimeoutManager } from "./result-timeout.js";
import { normalizeInboundEventPayload } from "./inbound-event-meta.js";
import { WorkerBridgeClient } from "./worker/worker-bridge-client.js";
import { WorkerInboundBridgeServer } from "./worker/inbound-bridge-server.js";

const defaultResultTimeoutMs = 10 * 60 * 1000;
const resultTimeoutRetryMs = 10 * 1000;
const composingHeartbeatMs = 10 * 1000;
const composingTTLMS = 30 * 1000;
const approvalPollIntervalMs = 1500;
const questionPollIntervalMs = 1500;
const verboseDebugEnabled = process.env.CLAWPOOL_E2E_DEBUG === "1";
const verboseDebugLogPath = normalizeOptionalString(process.env.CLAWPOOL_E2E_DEBUG_LOG);
const composingKeepaliveTimers = new Map();
const daemonBridgeURL = normalizeOptionalString(process.env.CLAWPOOL_DAEMON_BRIDGE_URL);
const daemonBridgeToken = normalizeOptionalString(process.env.CLAWPOOL_DAEMON_BRIDGE_TOKEN);
const daemonModeEnabled = process.env.CLAWPOOL_DAEMON_MODE === "1" && daemonBridgeURL && daemonBridgeToken;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter((item) => item);
}

async function persistEventChannelContext(sessionContextStore, event) {
  if (!normalizeString(event.session_id) || !normalizeString(event.msg_id)) {
    return;
  }
  await sessionContextStore.put({
    session_id: event.session_id,
    transcript_path: `event:${event.event_id}`,
    updated_at: Date.now(),
    context: {
      raw_tag: "",
      chat_id: event.session_id,
      event_id: event.event_id,
      message_id: event.msg_id,
      sender_id: event.sender_id,
      user_id: event.sender_id,
      msg_id: event.msg_id,
    },
  });
}

function mergeRecords(...records) {
  return Object.assign({}, ...records);
}

function isGroupSession(payload) {
  return (
    Number(payload.session_type ?? 0) === 2 ||
    normalizeString(payload.event_type).startsWith("group_")
  );
}

function toolTextResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function buildInstructions() {
  return [
    'Messages arrive as <channel source="clawpool-claude" chat_id="..." event_id="..." message_id="..." user_id="...">text</channel>.',
    "When present, channel metadata includes msg_type plus JSON strings in attachments_json, biz_card_json, channel_data_json, and extra_json. Use those structured fields directly instead of guessing attachment or card semantics from text.",
    "If you want to send a visible reply back to the same chat, call the reply tool with chat_id, event_id, and text. You may also pass reply_to when you want to quote a specific message_id.",
    "The reply tool also accepts files as absolute local paths. Files are uploaded through the Agent API media presign endpoint before they are sent back to the chat.",
    "If you need to remove a previously sent message, call delete_message with chat_id and message_id.",
    "If you intentionally do not want to send a visible reply, you must call the complete tool with event_id and a final status.",
    "Always preserve event_id when using reply or complete. The plugin uses it to enforce stop fences and finish the Aibot event lifecycle.",
  ].join(" ");
}

const configStore = new ConfigStore(resolveConfigPath());
const accessStore = new AccessStore(resolveAccessPath());
const approvalStore = new ApprovalStore({
  requestsDir: resolveApprovalRequestsDir(),
  notificationsDir: resolveApprovalNotificationsDir(),
});
const questionStore = new QuestionStore({
  requestsDir: resolveQuestionRequestsDir(),
});
const sessionContextStore = new ChannelContextStore(resolveSessionContextsDir());
const eventState = new EventState({
  onChange(entry) {
    void saveEventEntry(resolveEventStatesDir(), entry).catch((error) => {
      logError(`event state persist failed event=${entry.event_id}: ${String(error)}`);
    });
  },
});
let approvalPollTimer = null;
let questionPollTimer = null;

let latestClientStatus = {
  configured: false,
  connecting: false,
  connected: false,
  authed: false,
  last_error: "",
};

function logInfo(message) {
  if (verboseDebugLogPath) {
    appendFileSync(verboseDebugLogPath, `[clawpool-claude] ${message}\n`);
  }
  console.error(`[clawpool-claude] ${message}`);
}

function logError(message) {
  if (verboseDebugLogPath) {
    appendFileSync(verboseDebugLogPath, `[clawpool-claude:error] ${message}\n`);
  }
  console.error(`[clawpool-claude:error] ${message}`);
}

function logDebug(message) {
  if (!verboseDebugEnabled) {
    return;
  }
  if (verboseDebugLogPath) {
    appendFileSync(verboseDebugLogPath, `[clawpool-claude:debug] ${message}\n`);
  }
  console.error(`[clawpool-claude:debug] ${message}`);
}

const mcp = new Server(
  {
    name: "clawpool-claude",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions: buildInstructions(),
  },
);

async function onResultTimeout(eventID) {
  const event = eventState.get(eventID);
  if (!event || event.completed) {
    return;
  }

  const result = event.result_intent
    ? buildTerminalResult(event.result_intent)
    : buildTerminalResult({
        status: "failed",
        code: "claude_result_timeout",
        msg: "Claude did not call reply or complete before timeout.",
      });

  eventState.setResultIntent(eventID, result);
  try {
    await sendEventResultOutbound({
      event_id: eventID,
      ...result,
    });
    cancelResultTimeout(eventID);
    eventState.clearResultIntent(eventID);
    eventState.markCompleted(eventID, result);
    logInfo(`result timeout finalized event=${eventID} status=${result.status}`);
  } catch (error) {
    logError(`result timeout send failed event=${eventID}: ${String(error)}`);
    const deadlineAt = resultTimeouts.arm(eventID, {
      timeoutMs: resultTimeoutRetryMs,
    });
    eventState.setResultDeadline(eventID, { deadlineAt });
  }
}

const resultTimeouts = new ResultTimeoutManager({
  defaultResultTimeoutMs,
  onTimeout: onResultTimeout,
});

const aibotClient = new AibotClient({
  onStatus(status) {
    latestClientStatus = status;
    logDebug(
      `status configured=${status.configured} connecting=${status.connecting} connected=${status.connected} authed=${status.authed} last_error=${status.last_error || ""}`,
    );
  },
  async onEventMessage(payload) {
    await handleInboundEvent(payload);
  },
  async onEventStop(payload) {
    await handleStopEvent(payload);
  },
  async onEventRevoke(payload) {
    await handleRevokeEvent(payload);
  },
});

const workerBridgeClient = new WorkerBridgeClient({
  bridgeURL: daemonBridgeURL,
  token: daemonBridgeToken,
});
const workerControlServer = daemonModeEnabled
  ? new WorkerInboundBridgeServer({
      onDeliverEvent: async (input) => {
        await handleInboundEvent(input?.payload ?? {});
        return { ok: true };
      },
      onDeliverStop: async (input) => {
        await handleStopEvent(input?.payload ?? {});
        return { ok: true };
      },
      onDeliverRevoke: async (input) => {
        await handleRevokeEvent(input?.payload ?? {});
        return { ok: true };
      },
    })
  : null;

function isDaemonBridgeActive() {
  return daemonModeEnabled && workerBridgeClient.isConfigured();
}

async function sendTextOutbound(payload) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.sendText({
      event_id: payload.eventID,
      session_id: payload.sessionID,
      text: payload.text,
      quoted_message_id: payload.quotedMessageID,
      client_msg_id: payload.clientMsgID,
      extra: payload.extra,
    });
  }
  return aibotClient.sendText(payload);
}

async function sendMediaOutbound(payload) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.sendMedia({
      event_id: payload.eventID,
      session_id: payload.sessionID,
      media_url: payload.mediaURL,
      caption: payload.caption,
      quoted_message_id: payload.quotedMessageID,
      client_msg_id: payload.clientMsgID,
      extra: payload.extra,
    });
  }
  return aibotClient.sendMedia(payload);
}

async function deleteMessageOutbound(sessionID, messageID) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.deleteMessage({
      session_id: sessionID,
      msg_id: messageID,
    });
  }
  return aibotClient.deleteMessage(sessionID, messageID);
}

async function ackEventOutbound(eventID, { sessionID, msgID, receivedAt = Date.now() } = {}) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.ackEvent({
      event_id: eventID,
      session_id: sessionID,
      msg_id: msgID,
      received_at: Math.floor(receivedAt),
    });
  }
  aibotClient.ackEvent(eventID, {
    sessionID,
    msgID,
    receivedAt,
  });
  return { ok: true };
}

async function sendEventResultOutbound(payload) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.sendEventResult(payload);
  }
  aibotClient.sendEventResult(payload);
  return { ok: true };
}

async function sendEventStopAckOutbound(payload) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.sendEventStopAck(payload);
  }
  aibotClient.sendEventStopAck(payload);
  return { ok: true };
}

async function sendEventStopResultOutbound(payload) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.sendEventStopResult(payload);
  }
  aibotClient.sendEventStopResult(payload);
  return { ok: true };
}

async function setSessionComposingOutbound({
  sessionID,
  active,
  ttlMs = 0,
  refMsgID = "",
  refEventID = "",
}) {
  if (isDaemonBridgeActive()) {
    return workerBridgeClient.setSessionComposing({
      session_id: sessionID,
      active,
      ttl_ms: ttlMs,
      ref_msg_id: refMsgID,
      ref_event_id: refEventID,
    });
  }
  aibotClient.setSessionComposing({
    sessionID,
    active,
    ttlMs,
    refMsgID,
    refEventID,
  });
  return { ok: true };
}

function resendAck(event) {
  void ackEventOutbound(event.event_id, {
    sessionID: event.session_id,
    msgID: event.msg_id,
    receivedAt: Date.now(),
  }).catch((error) => {
    logError(`event ack send failed event=${event.event_id}: ${String(error)}`);
  });
}

function markAcked(event) {
  resendAck(event);
  return (
    eventState.markAcked(event.event_id, {
      ackedAt: Date.now(),
    }) ?? event
  );
}

function armResultTimeout(eventID, timeoutMs = defaultResultTimeoutMs) {
  const deadlineAt = resultTimeouts.arm(eventID, { timeoutMs });
  eventState.setResultDeadline(eventID, { deadlineAt });
  return deadlineAt;
}

function cancelResultTimeout(eventID) {
  resultTimeouts.cancel(eventID);
  eventState.clearResultDeadline(eventID);
}

function clearComposingKeepaliveTimer(eventID) {
  const normalizedEventID = normalizeString(eventID);
  if (!normalizedEventID) {
    return;
  }
  const timer = composingKeepaliveTimers.get(normalizedEventID);
  if (!timer) {
    return;
  }
  clearInterval(timer);
  composingKeepaliveTimers.delete(normalizedEventID);
}

function sendComposingState(event, active) {
  if (!event || !normalizeString(event.session_id)) {
    return false;
  }
  void setSessionComposingOutbound({
    sessionID: event.session_id,
    active,
    ttlMs: active ? composingTTLMS : 0,
    refMsgID: event.msg_id,
    refEventID: event.event_id,
  }).catch((error) => {
    logError(
      `composing state send failed event=${event?.event_id ?? ""} active=${active}: ${String(error)}`,
    );
  });
  return true;
}

function startComposingKeepalive(eventID) {
  const normalizedEventID = normalizeString(eventID);
  if (!normalizedEventID) {
    return;
  }
  clearComposingKeepaliveTimer(normalizedEventID);
  const tick = () => {
    const current = eventState.get(normalizedEventID);
    if (!current || current.completed || current.stopped) {
      clearComposingKeepaliveTimer(normalizedEventID);
      return;
    }
    sendComposingState(current, true);
  };
  tick();
  const timer = setInterval(tick, composingHeartbeatMs);
  composingKeepaliveTimers.set(normalizedEventID, timer);
}

function stopComposingKeepalive(eventID, fallbackEvent = null) {
  const normalizedEventID = normalizeString(eventID);
  if (!normalizedEventID) {
    return;
  }
  clearComposingKeepaliveTimer(normalizedEventID);
  const current = eventState.get(normalizedEventID) ?? fallbackEvent;
  if (!current) {
    return;
  }
  sendComposingState(current, false);
}

function buildTerminalResult({ status, code = "", msg = "" }) {
  return {
    status: normalizeString(status),
    code: normalizeOptionalString(code),
    msg: normalizeOptionalString(msg),
    updated_at: Date.now(),
  };
}

async function sendTerminalResult(eventID, { status, code = "", msg = "" }) {
  const event = eventState.get(eventID);
  const result = buildTerminalResult({
    status,
    code,
    msg,
  });
  eventState.setResultIntent(eventID, result);
  try {
    await sendEventResultOutbound({
      event_id: eventID,
      ...result,
    });
  } catch (error) {
    logError(`sendTerminalResult send failed event=${eventID}, will retry: ${String(error)}`);
    const deadlineAt = resultTimeouts.arm(eventID, { timeoutMs: resultTimeoutRetryMs });
    eventState.setResultDeadline(eventID, { deadlineAt });
    stopComposingKeepalive(eventID, event);
    return null;
  }
  cancelResultTimeout(eventID);
  eventState.clearResultIntent(eventID);
  const completed = eventState.markCompleted(eventID, result);
  stopComposingKeepalive(eventID, event);
  return completed;
}

async function finalizeEventSafely(eventID, result, context) {
  try {
    await sendTerminalResult(eventID, result);
    return true;
  } catch (error) {
    logError(`${context} event=${eventID}: ${String(error)}`);
    return false;
  }
}

async function dispatchChannelNotification(event) {
  startComposingKeepalive(event.event_id);
  await mcp.notification({
    method: "notifications/claude/channel",
    params: buildChannelNotificationParams(event),
  });
  eventState.markNotificationDispatched(event.event_id, {
    dispatchedAt: Date.now(),
  });
  logDebug(`event notification-dispatched event=${event.event_id}`);
}

function buildStatusHints() {
  const hints = [
    "Open Claude through the clawpool-claude command so the channel and plugin are loaded together.",
    "Team and Enterprise orgs must also enable channelsEnabled or channel notifications will not arrive.",
  ];

  if (isDaemonBridgeActive()) {
    hints.unshift("This worker is running under the clawpool-claude daemon bridge.");
  } else if (!configStore.isConfigured()) {
    hints.unshift("Clawpool is not configured. Run /clawpool:configure.");
  } else if (!latestClientStatus.authed) {
    hints.unshift("Clawpool is configured but not authenticated. Check ws_url, agent_id, api_key, and backend reachability.");
  }

  return hints;
}

async function buildStatusPayload() {
  return {
    config: configStore.getStatus(),
    access: accessStore.getStatus(),
    approvals: await approvalStore.getStatus(),
    questions: await questionStore.getStatus(),
    connection: latestClientStatus,
    hints: buildStatusHints(),
  };
}

async function sendPairingMessage(event) {
  const pair = await accessStore.issuePairingCode({
    senderID: event.sender_id,
    sessionID: event.session_id,
  });
  const text = [
    "This sender is not allowlisted for the Claude Clawpool channel.",
    `Pairing code: ${pair.code}`,
    "Ask the Claude Code user to run /clawpool:access pair <code> with this code to approve the sender.",
  ].join("\n");

  await sendTextOutbound({
    sessionID: event.session_id,
    text,
    clientMsgID: `pair_${event.event_id}`,
  });
  eventState.markPairingSent(event.event_id, {
    sentAt: Date.now(),
  });
  await finalizeEventSafely(event.event_id, {
    status: "responded",
    code: "pairing_required",
    msg: "pairing code sent",
  }, "pairing terminal result failed");
}

async function sendAccessStatusMessage(sessionID, text, clientMsgID) {
  await sendTextOutbound({
    sessionID,
    text,
    clientMsgID,
    extra: {
      reply_source: "claude_channel_access",
    },
  });
}

async function handleDuplicateEvent(event) {
  logInfo(`duplicate inbound event handled event=${event.event_id}`);

  if (event.acked) {
    resendAck(event);
  } else {
    markAcked(event);
  }

  if (event.completed) {
    await sendEventResultOutbound({
      event_id: event.event_id,
      status: event.completed.status,
      code: event.completed.code,
      msg: event.completed.msg,
      updated_at: Date.now(),
    });
    return;
  }

  if (event.result_intent) {
    await finalizeEventSafely(event.event_id, event.result_intent, "duplicate result resend failed");
    return;
  }

  startComposingKeepalive(event.event_id);

  if (event.pairing_sent_at && eventState.canResendPairing(event.event_id)) {
    try {
      await sendPairingMessage(event);
    } catch (error) {
      logError(`duplicate pairing resend failed event=${event.event_id}: ${String(error)}`);
    }
    return;
  }

  if (event.notification_dispatched_at) {
    return;
  }
}

function buildApprovalDecision(request, resolution) {
  if (resolution.type === "allow") {
    return {
      behavior: "allow",
    };
  }

  if (resolution.type === "allow-rule") {
    const suggestion = request.permission_suggestions[resolution.suggestion_index - 1];
    if (!suggestion) {
      throw new Error(`approval rule ${resolution.suggestion_index} not found`);
    }
    return {
      behavior: "allow",
      updatedPermissions: [suggestion],
    };
  }

  return {
    behavior: "deny",
    interrupt: true,
    ...(resolution.reason ? { message: resolution.reason } : {}),
  };
}

async function sendApprovalCommandReply(event, text) {
  await sendTextOutbound({
    eventID: event.event_id,
    sessionID: event.session_id,
    text,
    quotedMessageID: event.msg_id,
    clientMsgID: `approval_reply_${event.event_id}`,
    extra: {
      reply_source: "claude_channel_approval",
    },
  });
}

async function sendQuestionCommandReply(event, text) {
  await sendTextOutbound({
    eventID: event.event_id,
    sessionID: event.session_id,
    text,
    quotedMessageID: event.msg_id,
    clientMsgID: `question_reply_${event.event_id}`,
    extra: {
      reply_source: "claude_channel_question",
    },
  });
}

async function handleApprovalDecisionEvent(event) {
  const parsed = parseApprovalDecisionCommand(event.content);
  if (!parsed.matched) {
    return false;
  }

  if (!parsed.ok) {
    await sendApprovalCommandReply(event, parsed.error);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_command_invalid",
      msg: "approval command invalid",
    }, "approval invalid terminal result failed");
    return true;
  }

  if (!accessStore.isSenderApprover(event.sender_id)) {
    await sendApprovalCommandReply(event, "This sender is not configured as a Claude approval approver.");
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_sender_not_authorized",
      msg: "sender not configured as approver",
    }, "approval unauthorized terminal result failed");
    return true;
  }

  const request = await approvalStore.getRequest(parsed.request_id);
  if (!request) {
    await sendApprovalCommandReply(event, `Approval request ${parsed.request_id} was not found.`);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_request_not_found",
      msg: "approval request not found",
    }, "approval not-found terminal result failed");
    return true;
  }

  if (request.channel_context.chat_id !== event.session_id) {
    await sendApprovalCommandReply(event, "This approval request belongs to a different ClawPool chat.");
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_chat_mismatch",
      msg: "approval request belongs to a different chat",
    }, "approval chat-mismatch terminal result failed");
    return true;
  }

  if (request.status !== "pending") {
    await sendApprovalCommandReply(event, `Approval request ${parsed.request_id} is ${request.status}.`);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_request_not_pending",
      msg: `approval request is ${request.status}`,
    }, "approval not-pending terminal result failed");
    return true;
  }

  let decision;
  try {
    decision = buildApprovalDecision(request, parsed.resolution);
  } catch (error) {
    await sendApprovalCommandReply(event, String(error instanceof Error ? error.message : error));
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_rule_invalid",
      msg: String(error instanceof Error ? error.message : error),
    }, "approval invalid-rule terminal result failed");
    return true;
  }

  await approvalStore.resolveRequest(parsed.request_id, {
    decision,
    resolvedBy: {
      sender_id: event.sender_id,
      session_id: event.session_id,
      event_id: event.event_id,
      msg_id: event.msg_id,
    },
  });
  await sendApprovalCommandReply(event, buildApprovalDecisionResponseText({
    requestID: parsed.request_id,
    resolution: parsed.resolution,
  }));
  await finalizeEventSafely(event.event_id, {
    status: "responded",
    code: "approval_recorded",
    msg: "approval decision recorded",
  }, "approval recorded terminal result failed");
  return true;
}

async function handleQuestionResponseEvent(event) {
  const parsed = parseQuestionResponseCommand(event.content);
  if (!parsed.matched) {
    return false;
  }

  if (!parsed.ok) {
    await sendQuestionCommandReply(event, parsed.error);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_command_invalid",
      msg: "question command invalid",
    }, "question invalid terminal result failed");
    return true;
  }

  const request = await questionStore.getRequest(parsed.request_id);
  if (!request) {
    await sendQuestionCommandReply(event, `Question request ${parsed.request_id} was not found.`);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_request_not_found",
      msg: "question request not found",
    }, "question not-found terminal result failed");
    return true;
  }

  if (request.channel_context.chat_id !== event.session_id) {
    await sendQuestionCommandReply(event, "This question request belongs to a different ClawPool chat.");
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_chat_mismatch",
      msg: "question request belongs to a different chat",
    }, "question chat-mismatch terminal result failed");
    return true;
  }

  if (request.status !== "pending") {
    await sendQuestionCommandReply(event, `Question request ${parsed.request_id} is ${request.status}.`);
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_request_not_pending",
      msg: `question request is ${request.status}`,
    }, "question not-pending terminal result failed");
    return true;
  }

  let updatedInput;
  try {
    updatedInput = buildAskUserQuestionUpdatedInput(request, parsed.response);
  } catch (error) {
    await sendQuestionCommandReply(event, String(error instanceof Error ? error.message : error));
    await finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_answer_invalid",
      msg: String(error instanceof Error ? error.message : error),
    }, "question invalid-answer terminal result failed");
    return true;
  }

  await questionStore.resolveRequest(parsed.request_id, {
    answers: updatedInput.answers,
    resolvedBy: {
      sender_id: event.sender_id,
      session_id: event.session_id,
      event_id: event.event_id,
      msg_id: event.msg_id,
    },
  });
  await sendQuestionCommandReply(event, buildQuestionResponseText({
    requestID: parsed.request_id,
  }));
  await finalizeEventSafely(event.event_id, {
    status: "responded",
    code: "question_recorded",
    msg: "question answers recorded",
  }, "question recorded terminal result failed");
  return true;
}

async function dispatchApprovalRequest(request) {
  const ack = await sendTextOutbound({
    sessionID: request.channel_context.chat_id,
    text: buildApprovalRequestText(request),
    quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
    clientMsgID: `approval_request_${request.request_id}`,
    extra: {
      reply_source: "claude_permission_request",
      approval_request_id: request.request_id,
    },
  });
  await approvalStore.markDispatched(request.request_id, {
    dispatchedAt: Date.now(),
    approvalMessageID: normalizeOptionalString(ack.msg_id),
  });
}

async function dispatchQuestionRequest(request) {
  const ack = await sendTextOutbound({
    sessionID: request.channel_context.chat_id,
    text: buildQuestionRequestText(request),
    quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
    clientMsgID: `question_request_${request.request_id}`,
    extra: {
      reply_source: "claude_ask_user_question",
      question_request_id: request.request_id,
    },
  });
  await questionStore.markDispatched(request.request_id, {
    dispatchedAt: Date.now(),
    questionMessageID: normalizeOptionalString(ack.msg_id),
  });
}

async function pumpApprovalRequests() {
  if (!isDaemonBridgeActive() && !latestClientStatus.authed) {
    return;
  }

  const pending = await approvalStore.listPendingDispatches();
  for (const request of pending) {
    try {
      await dispatchApprovalRequest(request);
    } catch (error) {
      await approvalStore.markDispatchFailed(request.request_id, String(error));
      logError(`approval request dispatch failed request=${request.request_id}: ${String(error)}`);
    }
  }
}

async function pumpQuestionRequests() {
  if (!isDaemonBridgeActive() && !latestClientStatus.authed) {
    return;
  }

  const pending = await questionStore.listPendingDispatches();
  for (const request of pending) {
    try {
      await dispatchQuestionRequest(request);
    } catch (error) {
      await questionStore.markDispatchFailed(request.request_id, String(error));
      logError(`question request dispatch failed request=${request.request_id}: ${String(error)}`);
    }
  }
}

function startApprovalPump() {
  if (approvalPollTimer) {
    return;
  }
  approvalPollTimer = setInterval(() => {
    void pumpApprovalRequests();
  }, approvalPollIntervalMs);
}

function startQuestionPump() {
  if (questionPollTimer) {
    return;
  }
  questionPollTimer = setInterval(() => {
    void pumpQuestionRequests();
  }, questionPollIntervalMs);
}

function stopApprovalPump() {
  if (!approvalPollTimer) {
    return;
  }
  clearInterval(approvalPollTimer);
  approvalPollTimer = null;
}

function stopQuestionPump() {
  if (!questionPollTimer) {
    return;
  }
  clearInterval(questionPollTimer);
  questionPollTimer = null;
}

async function handleInboundEvent(rawPayload) {
  const payload = normalizeInboundEventPayload(rawPayload);

  if (!payload.event_id || !payload.session_id || !payload.msg_id || !payload.sender_id) {
    logError(`invalid event_msg payload: ${JSON.stringify(rawPayload)}`);
    return;
  }

  logDebug(
    `event_msg event=${payload.event_id} session=${payload.session_id} msg=${payload.msg_id} sender=${payload.sender_id} content=${JSON.stringify(payload.content)}`,
  );

  let registration;
  try {
    registration = eventState.registerInbound(payload);
  } catch (error) {
    logError(`register inbound failed event=${payload.event_id}: ${String(error)}`);
    return;
  }

  let event = registration.event;
  if (registration.duplicate) {
    await handleDuplicateEvent(event);
    return;
  }

  try {
    await persistEventChannelContext(sessionContextStore, event);
    logDebug(`session-context stored session=${event.session_id} event=${event.event_id}`);
  } catch (error) {
    logError(`session-context store failed event=${event.event_id}: ${String(error)}`);
  }

  let policy = accessStore.getPolicy();
  const senderAllowlisted = accessStore.isSenderAllowlisted(event.sender_id);
  let senderAllowed = accessStore.isSenderAllowed(event.sender_id);
  const hasAllowedSenders = accessStore.hasAllowedSenders();
  event = markAcked(event);
  armResultTimeout(event.event_id);

  if (policy === "disabled") {
    logDebug(`event disabled-policy event=${event.event_id}`);
    try {
      await sendAccessStatusMessage(
        event.session_id,
        "Claude Clawpool access is currently disabled for this channel.",
        `access_disabled_${event.event_id}`,
      );
    } catch (error) {
      logError(`disabled-policy notice failed event=${event.event_id}: ${String(error)}`);
    }
    await finalizeEventSafely(event.event_id, {
      status: "canceled",
      code: "policy_disabled",
      msg: "channel policy disabled",
    }, "policy-disabled result send failed");
    return;
  }

  if (
    !senderAllowlisted &&
    !isGroupSession(rawPayload) &&
    (
      policy === "open" ||
      (policy === "allowlist" && !hasAllowedSenders)
    )
  ) {
    try {
      const bootstrap = await accessStore.bootstrapFirstSender(event.sender_id, {
        lockPolicyToAllowlist: policy === "open",
      });
      if (bootstrap.bootstrapped) {
        policy = bootstrap.policy;
        senderAllowed = true;
        logInfo(`bootstrapped sender allowlist sender=${event.sender_id} policy=${policy}`);
        logDebug(`event first-sender-bootstrap event=${event.event_id} sender=${event.sender_id}`);
      }
    } catch (error) {
      try {
        await sendAccessStatusMessage(
          event.session_id,
          `Claude Clawpool could not auto-authorize this sender: ${String(error)}.`,
          `sender_bootstrap_failed_${event.event_id}`,
        );
      } catch (notifyError) {
        logError(`sender bootstrap notice failed event=${event.event_id}: ${String(notifyError)}`);
      }
      await finalizeEventSafely(event.event_id, {
        status: "failed",
        code: "sender_bootstrap_failed",
        msg: String(error),
      }, "sender bootstrap result send failed");
      return;
    }
  }

  if (!senderAllowed) {
    logDebug(`event sender-blocked event=${event.event_id} sender=${event.sender_id} group=${isGroupSession(rawPayload)}`);
    if (isGroupSession(rawPayload)) {
      try {
        await sendAccessStatusMessage(
          event.session_id,
          "This sender is not allowlisted for the Claude Clawpool channel.",
          `sender_blocked_${event.event_id}`,
        );
      } catch (error) {
        logError(`group allowlist notice failed event=${event.event_id}: ${String(error)}`);
      }
      await finalizeEventSafely(event.event_id, {
        status: "canceled",
        code: "sender_not_allowlisted",
        msg: "sender not allowlisted",
      }, "group allowlist result send failed");
      return;
    }
    try {
      await sendPairingMessage(event);
    } catch (error) {
      await finalizeEventSafely(event.event_id, {
        status: "failed",
        code: "pairing_send_failed",
        msg: String(error),
      }, "pairing failure result send failed");
    }
    return;
  }

  if (await handleApprovalDecisionEvent(event)) {
    logDebug(`event approval-command event=${event.event_id}`);
    return;
  }

  if (await handleQuestionResponseEvent(event)) {
    logDebug(`event question-command event=${event.event_id}`);
    return;
  }

  try {
    await dispatchChannelNotification(event);
  } catch (error) {
    await finalizeEventSafely(event.event_id, {
      status: "failed",
      code: "channel_notification_failed",
      msg: String(error),
    }, "channel notification result send failed");
  }
}

async function handleStopEvent(rawPayload) {
  const eventID = normalizeString(rawPayload.event_id);
  if (!eventID) {
    return;
  }
  const stopID = normalizeString(rawPayload.stop_id);
  const existing = eventState.get(eventID);

  try {
    await sendEventStopAckOutbound({
      event_id: eventID,
      stop_id: stopID,
      accepted: true,
      updated_at: Date.now(),
    });
  } catch (error) {
    logError(`sendEventStopAck failed event=${eventID}: ${String(error)}`);
  }

  if (!existing || existing.completed) {
    stopComposingKeepalive(eventID, existing);
    try {
      await sendEventStopResultOutbound({
        event_id: eventID,
        stop_id: stopID,
        status: "already_finished",
        updated_at: Date.now(),
      });
    } catch (error) {
      logError(`sendEventStopResult(already_finished) failed event=${eventID}: ${String(error)}`);
    }
    return;
  }

  eventState.markStopped(eventID, {
    stop_id: stopID,
    reason: "owner_requested_stop",
    updated_at: Date.now(),
  });
  try {
    await sendEventStopResultOutbound({
      event_id: eventID,
      stop_id: stopID,
      status: "stopped",
      code: "owner_requested_stop",
      msg: "owner requested stop",
      updated_at: Date.now(),
    });
  } catch (error) {
    logError(`sendEventStopResult(stopped) failed event=${eventID}: ${String(error)}`);
  }
  await finalizeEventSafely(eventID, {
    status: "canceled",
    code: "owner_requested_stop",
    msg: "owner requested stop",
  }, "stop terminal result failed");
}

async function handleRevokeEvent(rawPayload) {
  const eventID = normalizeString(rawPayload.event_id);
  if (!eventID) {
    return;
  }
  stopComposingKeepalive(eventID);
  await ackEventOutbound(eventID, {
    sessionID: normalizeOptionalString(rawPayload.session_id),
    msgID: normalizeOptionalString(rawPayload.msg_id),
    receivedAt: Date.now(),
  });
  logInfo(`event_revoke acked event=${eventID}`);
}

async function handleReplyTool(args) {
  const chatID = normalizeString(args.chat_id);
  const eventID = normalizeString(args.event_id);
  const replyTo = normalizeOptionalString(args.reply_to);
  const text = String(args.text ?? "");
  const files = normalizeStringArray(args.files);
  logDebug(
    `tool reply event=${eventID} chat=${chatID} reply_to=${replyTo} text=${JSON.stringify(text)} files=${files.length}`,
  );
  if (!chatID || !eventID || (!text.trim() && files.length === 0)) {
    throw new Error("reply requires chat_id, event_id, and at least one of text or files");
  }

  const event = eventState.get(eventID);
  if (!event) {
    return toolTextResult("ignored: event not found");
  }
  if (event.session_id !== chatID) {
    throw new Error("chat_id does not match event session");
  }
  if (event.completed) {
    return toolTextResult("ignored: event already completed");
  }
  if (event.stopped) {
    return toolTextResult("ignored: event already stopped");
  }

  const connectionConfig = configStore.getConnectionConfig();
  if (!connectionConfig) {
    throw new Error("clawpool-claude is not configured");
  }

  const chunkLimit = resolveOutboundTextChunkLimit(
    connectionConfig.outboundTextChunkLimit,
    1200,
  );
  const chunks = splitTextForAibotProtocol(text, chunkLimit);
  let chunkIndex = 0;
  const sentMessageIDs = [];

  try {
    for (const chunk of chunks) {
      const current = eventState.get(eventID);
      if (!current || current.completed || current.stopped) {
        return toolTextResult("ignored: event no longer active");
      }
      chunkIndex += 1;
      const ack = await sendTextOutbound({
        eventID,
        sessionID: chatID,
        text: chunk,
        quotedMessageID: replyTo || current.msg_id,
        clientMsgID: `${randomUUID()}_${chunkIndex}`,
        extra: {
          reply_source: "claude_channel",
        },
      });
      const messageID = normalizeOptionalString(ack.msg_id);
      if (messageID) {
        sentMessageIDs.push(messageID);
      }
    }

    for (const filePath of files) {
      const current = eventState.get(eventID);
      if (!current || current.completed || current.stopped) {
        return toolTextResult("ignored: event no longer active");
      }

      chunkIndex += 1;
      const upload = await uploadReplyFileToAgentMedia({
        wsURL: connectionConfig.wsURL,
        apiKey: connectionConfig.apiKey,
        sessionID: chatID,
        filePath,
      });
      const ack = await sendMediaOutbound({
        eventID,
        sessionID: chatID,
        mediaURL: upload.access_url,
        caption: upload.file_name,
        quotedMessageID: replyTo || current.msg_id,
        clientMsgID: `${randomUUID()}_${chunkIndex}`,
        extra: mergeRecords(
          {
            reply_source: "claude_channel",
          },
          upload.extra,
        ),
      });
      const messageID = normalizeOptionalString(ack.msg_id);
      if (messageID) {
        sentMessageIDs.push(messageID);
      }
    }
  } catch (error) {
    const current = eventState.get(eventID);
    if (!current || current.completed || current.stopped) {
      return toolTextResult("ignored: event no longer active");
    }
    await finalizeEventSafely(eventID, {
      status: "failed",
      code: "send_msg_failed",
      msg: String(error),
    }, "send_msg failure result send failed");
    throw error;
  }

  if (!await finalizeEventSafely(eventID, {
    status: "responded",
  }, "reply terminal result failed")) {
    return toolTextResult("sent: backend finalization pending retry");
  }
  if (sentMessageIDs.length === 1) {
    return toolTextResult(`sent (id: ${sentMessageIDs[0]})`);
  }
  if (sentMessageIDs.length > 1) {
    return toolTextResult(`sent ${sentMessageIDs.length} parts (ids: ${sentMessageIDs.join(", ")})`);
  }
  return toolTextResult("sent");
}

async function handleCompleteTool(args) {
  const eventID = normalizeString(args.event_id);
  const status = normalizeString(args.status);
  const code = normalizeOptionalString(args.code);
  const msg = normalizeOptionalString(args.msg);
  logDebug(
    `tool complete event=${eventID} status=${status} code=${code} msg=${JSON.stringify(msg)}`,
  );
  if (!eventID || !status) {
    throw new Error("complete requires event_id and status");
  }
  if (!["responded", "canceled", "failed"].includes(status)) {
    throw new Error("complete status must be responded, canceled, or failed");
  }

  const event = eventState.get(eventID);
  if (!event) {
    return toolTextResult("ignored: event not found");
  }
  if (event.completed) {
    return toolTextResult("ignored: event already completed");
  }
  if (event.stopped) {
    return toolTextResult("ignored: event already stopped");
  }

  if (!await finalizeEventSafely(eventID, {
    status,
    code,
    msg,
  }, "complete terminal result failed")) {
    return toolTextResult("completed: backend finalization pending retry");
  }
  return toolTextResult("completed");
}

async function handleConfigureTool(args) {
  const status = await configStore.update({
    ws_url: normalizeString(args.ws_url),
    agent_id: normalizeString(args.agent_id),
    api_key: normalizeString(args.api_key),
    outbound_text_chunk_limit: args.outbound_text_chunk_limit,
  });
  await aibotClient.reconfigure(configStore.getConnectionConfig());
  return toolTextResult({
    ...status,
    hints: buildStatusHints(),
  });
}

async function handleStatusTool() {
  return toolTextResult(await buildStatusPayload());
}

async function handleDeleteMessageTool(args) {
  const chatID = normalizeString(args.chat_id);
  const messageID = normalizeString(args.message_id);
  logDebug(`tool delete_message chat=${chatID} message=${messageID}`);
  if (!chatID || !messageID) {
    throw new Error("delete_message requires chat_id and message_id");
  }

  await deleteMessageOutbound(chatID, messageID);
  return toolTextResult(`deleted (${messageID})`);
}

async function notifyApprovedSender(sessionID) {
  try {
    await sendAccessStatusMessage(
      sessionID,
      "Paired! Say hi to Claude.",
      `pair_ok_${randomUUID()}`,
    );
    return true;
  } catch (error) {
    logError(`pairing confirmation send failed session=${sessionID}: ${String(error)}`);
    return false;
  }
}

async function notifyDeniedSender(sessionID, code) {
  try {
    await sendAccessStatusMessage(
      sessionID,
      `Pairing request ${code} was denied. Ask the Claude Code user to request a new pairing code if you still need access.`,
      `pair_denied_${randomUUID()}`,
    );
    return true;
  } catch (error) {
    logError(`pairing denial send failed session=${sessionID}: ${String(error)}`);
    return false;
  }
}

async function handleAccessPairTool(args) {
  const result = await accessStore.approvePairing(args.code);
  const pairing_notice_sent = await notifyApprovedSender(result.session_id);
  return toolTextResult({
    ...result,
    pairing_notice_sent,
    hints: buildStatusHints(),
  });
}

async function handleAccessDenyTool(args) {
  const result = await accessStore.denyPairing(args.code);
  const pairing_notice_sent = await notifyDeniedSender(result.session_id, result.code);
  return toolTextResult({
    ...result,
    pairing_notice_sent,
    hints: buildStatusHints(),
  });
}

async function handleAllowSenderTool(args) {
  const result = await accessStore.allowSender(args.sender_id);
  return toolTextResult({
    ...result,
    hints: buildStatusHints(),
  });
}

async function handleAllowApproverTool(args) {
  const result = await accessStore.allowApprover(args.sender_id);
  return toolTextResult({
    ...result,
    hints: buildStatusHints(),
  });
}

async function handleRemoveSenderTool(args) {
  const result = await accessStore.removeSender(args.sender_id);
  return toolTextResult({
    ...result,
    hints: buildStatusHints(),
  });
}

async function handleRemoveApproverTool(args) {
  const result = await accessStore.removeApprover(args.sender_id);
  return toolTextResult({
    ...result,
    hints: buildStatusHints(),
  });
}

async function handleAccessPolicyTool(args) {
  const result = await accessStore.setPolicy(args.policy);
  return toolTextResult({
    ...result,
    hints: buildStatusHints(),
  });
}

const toolDefinitions = [
  {
    name: "reply",
    description: "Send a visible message back to the chat for this clawpool-claude event.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "The target chat/session id from the <channel> tag.",
        },
        event_id: {
          type: "string",
          description: "The Aibot event_id from the <channel> tag.",
        },
        text: {
          type: "string",
          description: "The visible reply text to send.",
        },
        files: {
          type: "array",
          description: "Optional absolute local file paths. Each file is uploaded through Agent API OSS presign before sending.",
          items: {
            type: "string",
          },
        },
        reply_to: {
          type: "string",
          description: "Optional message_id to quote instead of the inbound trigger message.",
        },
      },
      required: ["chat_id", "event_id"],
    },
  },
  {
    name: "delete_message",
    description: "Delete a previously sent message in the same clawpool-claude chat.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["chat_id", "message_id"],
    },
  },
  {
    name: "complete",
    description: "Finish an event without sending a visible reply so the backend does not time out.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        status: { type: "string", enum: ["responded", "canceled", "failed"] },
        code: { type: "string" },
        msg: { type: "string" },
      },
      required: ["event_id", "status"],
    },
  },
  {
    name: "configure",
    description: "Configure the clawpool-claude websocket endpoint, agent id, and api key.",
    inputSchema: {
      type: "object",
      properties: {
        ws_url: { type: "string" },
        agent_id: { type: "string" },
        api_key: { type: "string" },
        outbound_text_chunk_limit: { type: "integer" },
      },
      required: ["ws_url", "agent_id", "api_key"],
    },
  },
  {
    name: "status",
    description: "Show clawpool-claude configuration, access policy, websocket status, and startup hints.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "access_pair",
    description: "Approve a pending sender pairing code and add that sender to the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "access_deny",
    description: "Deny a pending sender pairing code and clear it from pending state.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "allow_sender",
    description: "Add a sender_id directly to the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "remove_sender",
    description: "Remove a sender_id from the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "allow_approver",
    description: "Add a sender_id to the Claude remote approval allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "remove_approver",
    description: "Remove a sender_id from the Claude remote approval allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "access_policy",
    description: "Update the sender access policy for this channel.",
    inputSchema: {
      type: "object",
      properties: {
        policy: { type: "string", enum: ["allowlist", "open", "disabled"] },
      },
      required: ["policy"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = normalizeString(request.params.name);
  const args = request.params.arguments ?? {};

  switch (name) {
    case "reply":
      return handleReplyTool(args);
    case "delete_message":
      return handleDeleteMessageTool(args);
    case "complete":
      return handleCompleteTool(args);
    case "configure":
      return handleConfigureTool(args);
    case "status":
      return handleStatusTool();
    case "access_pair":
      return handleAccessPairTool(args);
    case "access_deny":
      return handleAccessDenyTool(args);
    case "allow_sender":
      return handleAllowSenderTool(args);
    case "remove_sender":
      return handleRemoveSenderTool(args);
    case "allow_approver":
      return handleAllowApproverTool(args);
    case "remove_approver":
      return handleRemoveApproverTool(args);
    case "access_policy":
      return handleAccessPolicyTool(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

async function shutdown() {
  stopApprovalPump();
  stopQuestionPump();
  resultTimeouts.close();
  for (const eventID of composingKeepaliveTimers.keys()) {
    clearComposingKeepaliveTimer(eventID);
  }
  if (daemonModeEnabled && workerBridgeClient.isConfigured()) {
    try {
      if (workerControlServer) {
        await workerControlServer.stop();
      }
      await workerBridgeClient.sendStatusUpdate({
        worker_id: normalizeOptionalString(process.env.CLAWPOOL_WORKER_ID),
        aibot_session_id: normalizeOptionalString(process.env.CLAWPOOL_AIBOT_SESSION_ID),
        claude_session_id: normalizeOptionalString(process.env.CLAWPOOL_CLAUDE_SESSION_ID),
        status: "stopped",
      });
    } catch (error) {
      logError(`worker bridge stop update failed: ${String(error)}`);
    }
    return;
  }
  await aibotClient.stop();
}

async function restoreEventState() {
  const entries = await loadEventEntries(resolveEventStatesDir(), {
    completedTTLms: eventState.ttlMs,
    pendingTTLms: eventState.pendingTTLms,
  });
  const now = Date.now();
  let restored = 0;
  for (const entry of entries) {
    eventState.restore(entry);
    restored += 1;
    if (!entry.completed && Number(entry.result_deadline_at) > 0) {
      const remaining = Math.max(0, Number(entry.result_deadline_at) - now);
      const deadlineAt = resultTimeouts.arm(entry.event_id, { timeoutMs: remaining });
      eventState.setResultDeadline(entry.event_id, { deadlineAt });
    }
  }
  if (restored > 0) {
    logInfo(`restored ${restored} event state entries`);
  }
  return entries;
}

async function replayRestoredEvents(entries) {
  const replayable = entries.filter((entry) => shouldReplayRestoredEvent(entry));
  for (const entry of replayable) {
    try {
      await persistEventChannelContext(sessionContextStore, entry);
      await dispatchChannelNotification(entry);
      logInfo(`replayed restored event=${entry.event_id}`);
    } catch (error) {
      logError(`replay restored event failed event=${entry.event_id}: ${String(error)}`);
    }
  }
}

async function bootstrap() {
  await configStore.load();
  await accessStore.load();
  await approvalStore.init();
  await questionStore.init();
  const restoredEntries = await restoreEventState();
  await mcp.connect(new StdioServerTransport());
  if (daemonModeEnabled && workerBridgeClient.isConfigured()) {
    if (workerControlServer) {
      await workerControlServer.start();
    }
    await workerBridgeClient.registerWorker({
      worker_id: normalizeOptionalString(process.env.CLAWPOOL_WORKER_ID),
      aibot_session_id: normalizeOptionalString(process.env.CLAWPOOL_AIBOT_SESSION_ID),
      claude_session_id: normalizeOptionalString(process.env.CLAWPOOL_CLAUDE_SESSION_ID),
      cwd: process.cwd(),
      plugin_data_dir: normalizeOptionalString(process.env.CLAUDE_PLUGIN_DATA),
      worker_control_url: workerControlServer?.getURL?.() ?? "",
      worker_control_token: workerControlServer?.token ?? "",
      pid: process.pid,
    });
    await workerBridgeClient.sendStatusUpdate({
      worker_id: normalizeOptionalString(process.env.CLAWPOOL_WORKER_ID),
      aibot_session_id: normalizeOptionalString(process.env.CLAWPOOL_AIBOT_SESSION_ID),
      claude_session_id: normalizeOptionalString(process.env.CLAWPOOL_CLAUDE_SESSION_ID),
      worker_control_url: workerControlServer?.getURL?.() ?? "",
      worker_control_token: workerControlServer?.token ?? "",
      status: "ready",
    });
    startApprovalPump();
    startQuestionPump();
    await replayRestoredEvents(restoredEntries);
    logInfo("worker started in daemon bridge mode");
    return;
  }
  await aibotClient.start(configStore.getConnectionConfig());
  startApprovalPump();
  startQuestionPump();
  await replayRestoredEvents(restoredEntries);
  logInfo("server started");
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

bootstrap().catch((error) => {
  logError(`startup failed: ${String(error)}`);
  process.exitCode = 1;
});
