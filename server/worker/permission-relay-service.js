import {
  NotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  buildApprovalCommandStatusBizCard,
  buildPermissionRelayRequestBizCard,
  buildPermissionRelaySubmittedBizCard,
} from "../claude-card-payload.js";
import {
  buildPermissionRelayRequestText,
  buildPermissionRelayVerdictText,
} from "../permission-relay-text.js";

const pendingRequestTtlMs = 24 * 60 * 60 * 1000;
const permissionReplyPattern = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/iu;

const PermissionRequestNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function parsePermissionReply(text) {
  const match = permissionReplyPattern.exec(String(text ?? ""));
  if (!match) {
    return {
      matched: false,
      request_id: "",
      behavior: "",
    };
  }
  return {
    matched: true,
    request_id: normalizeString(match[2]).toLowerCase(),
    behavior: normalizeString(match[1]).toLowerCase().startsWith("y")
      ? "allow"
      : "deny",
  };
}

function buildStatusResult(code, msg) {
  return {
    status: "responded",
    code,
    msg,
  };
}

export class WorkerPermissionRelayService {
  constructor({
    mcp,
    bridge,
    accessStore,
    eventState,
    finalizeEvent,
    logger,
    aibotSessionID = "",
  }) {
    this.mcp = mcp;
    this.bridge = bridge;
    this.accessStore = accessStore;
    this.eventState = eventState;
    this.finalizeEvent = typeof finalizeEvent === "function"
      ? finalizeEvent
      : async () => false;
    this.logger = logger;
    this.aibotSessionID = normalizeOptionalString(aibotSessionID);
    this.pendingRequests = new Map();
  }

  async finalizeEventSafely(eventID, result, context) {
    return this.finalizeEvent(eventID, result, context);
  }

  registerHandlers() {
    this.mcp.setNotificationHandler(
      PermissionRequestNotificationSchema,
      async ({ params }) => {
        await this.handlePermissionRequest(params);
      },
    );
  }

  getStatus() {
    this.prunePendingRequests();
    return {
      pending_count: this.pendingRequests.size,
      pending_request_ids: Array.from(this.pendingRequests.keys()).sort(),
    };
  }

  prunePendingRequests(now = Date.now()) {
    for (const [requestID, request] of this.pendingRequests.entries()) {
      if (now - Number(request.created_at ?? 0) > pendingRequestTtlMs) {
        this.pendingRequests.delete(requestID);
      }
    }
  }

  getActiveEventContext() {
    this.prunePendingRequests();
    return this.eventState.getLatestActiveBySession(this.aibotSessionID);
  }

  async handlePermissionRequest(params) {
    if (!this.accessStore.hasApprovers()) {
      this.logger.trace?.({
        component: "worker.permission_relay",
        stage: "permission_request_skipped",
        reason: "no_approvers",
        request_id: params.request_id,
      });
      return;
    }

    const activeEvent = this.getActiveEventContext();
    if (!activeEvent) {
      this.logger.trace?.({
        component: "worker.permission_relay",
        stage: "permission_request_skipped",
        reason: "no_active_channel_event",
        request_id: params.request_id,
      });
      return;
    }

    const request = {
      request_id: normalizeString(params.request_id),
      tool_name: normalizeString(params.tool_name),
      description: normalizeString(params.description),
      input_preview: normalizeString(params.input_preview),
      created_at: Date.now(),
      channel_context: {
        chat_id: activeEvent.session_id,
        event_id: activeEvent.event_id,
        message_id: activeEvent.msg_id,
        msg_id: activeEvent.msg_id,
        sender_id: activeEvent.sender_id,
        user_id: activeEvent.sender_id,
      },
    };

    try {
      const ack = await this.bridge.sendText({
        sessionID: request.channel_context.chat_id,
        text: buildPermissionRelayRequestText(request),
        quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
        clientMsgID: `permission_request_${request.request_id}`,
        extra: {
          reply_source: "claude_permission_request",
          approval_request_id: request.request_id,
          biz_card: buildPermissionRelayRequestBizCard(request, {
            expiresAtMs: request.created_at + pendingRequestTtlMs,
          }),
        },
      });
      this.pendingRequests.set(request.request_id, {
        ...request,
        approval_message_id: normalizeOptionalString(ack?.msg_id),
      });
      this.logger.trace?.({
        component: "worker.permission_relay",
        stage: "permission_request_dispatched",
        request_id: request.request_id,
        event_id: request.channel_context.event_id,
        chat_id: request.channel_context.chat_id,
        msg_id: request.channel_context.message_id || request.channel_context.msg_id,
      });
    } catch (error) {
      this.logger.error(
        `permission request dispatch failed request=${request.request_id}: ${String(error)}`,
      );
    }
  }

  async sendApprovalReply(event, text, bizCard = null) {
    await this.bridge.sendText({
      eventID: event.event_id,
      sessionID: event.session_id,
      text,
      quotedMessageID: event.msg_id,
      clientMsgID: `approval_reply_${event.event_id}`,
      extra: {
        reply_source: "claude_channel_approval",
        ...(bizCard ? { biz_card: bizCard } : {}),
      },
    });
  }

  async handleCommandEvent(event) {
    const parsed = parsePermissionReply(event.content);
    if (!parsed.matched) {
      return {
        handled: false,
        kind: "",
      };
    }

    if (!this.accessStore.isSenderApprover(event.sender_id)) {
      const summary = "This sender is not configured as a Claude approval approver.";
      await this.sendApprovalReply(event, summary, buildApprovalCommandStatusBizCard({
        summary,
        status: "warning",
        referenceID: parsed.request_id,
      }));
      await this.finalizeEventSafely(
        event.event_id,
        buildStatusResult("approval_sender_not_authorized", "sender not configured as approver"),
        "permission reply unauthorized terminal result failed",
      );
      return {
        handled: true,
        kind: "approval",
      };
    }

    const request = this.pendingRequests.get(parsed.request_id);
    if (!request) {
      const summary = `Approval request ${parsed.request_id} is not open.`;
      await this.sendApprovalReply(event, summary, buildApprovalCommandStatusBizCard({
        summary,
        referenceID: parsed.request_id,
        status: "warning",
      }));
      await this.finalizeEventSafely(
        event.event_id,
        buildStatusResult("approval_request_not_open", "approval request is not open"),
        "permission reply missing terminal result failed",
      );
      return {
        handled: true,
        kind: "approval",
      };
    }

    if (request.channel_context.chat_id !== event.session_id) {
      const summary = "This approval request belongs to a different Grix chat.";
      await this.sendApprovalReply(event, summary, buildApprovalCommandStatusBizCard({
        summary,
        referenceID: parsed.request_id,
        status: "warning",
      }));
      await this.finalizeEventSafely(
        event.event_id,
        buildStatusResult("approval_chat_mismatch", "approval request belongs to a different chat"),
        "permission reply chat-mismatch terminal result failed",
      );
      return {
        handled: true,
        kind: "approval",
      };
    }

    try {
      await this.mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: parsed.request_id,
          behavior: parsed.behavior,
        },
      });
    } catch (error) {
      const summary = `Failed to send approval reply for request ${parsed.request_id}.`;
      await this.sendApprovalReply(event, summary, buildApprovalCommandStatusBizCard({
        summary,
        referenceID: parsed.request_id,
        detailText: String(error),
        status: "error",
      }));
      await this.finalizeEventSafely(
        event.event_id,
        buildStatusResult("approval_forward_failed", "approval verdict send failed"),
        "permission reply forward terminal result failed",
      );
      return {
        handled: true,
        kind: "approval",
      };
    }

    this.pendingRequests.delete(parsed.request_id);
    const responseText = buildPermissionRelayVerdictText({
      requestID: parsed.request_id,
      behavior: parsed.behavior,
    });
    await this.sendApprovalReply(event, responseText, buildPermissionRelaySubmittedBizCard({
      request,
      behavior: parsed.behavior,
      resolvedByID: event.sender_id,
    }));
    await this.finalizeEventSafely(
      event.event_id,
      buildStatusResult("approval_forwarded", "approval verdict sent to Claude"),
      "permission reply recorded terminal result failed",
    );
    this.logger.trace?.({
      component: "worker.permission_relay",
      stage: "permission_reply_forwarded",
      event_id: event.event_id,
      session_id: event.session_id,
      sender_id: event.sender_id,
      request_id: parsed.request_id,
      behavior: parsed.behavior,
    });
    return {
      handled: true,
      kind: "approval",
    };
  }

  async shutdown() {
    this.pendingRequests.clear();
  }
}
