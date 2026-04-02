import {
  buildQuestionRequestBizCard,
  buildQuestionStatusBizCard,
} from "../claude-card-payload.js";
import { parseQuestionResponseCommand } from "../question-command.js";
import { buildElicitationHookOutput } from "../elicitation-response.js";
import {
  buildElicitationRequestText,
  buildElicitationResponseText,
} from "../elicitation-text.js";

const elicitationPollIntervalMs = 1500;

function normalizeOptionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

export class WorkerElicitationRelayService {
  constructor({
    elicitationStore,
    bridge,
    finalizeEvent,
    logger,
  }) {
    this.elicitationStore = elicitationStore;
    this.bridge = bridge;
    this.finalizeEvent = typeof finalizeEvent === "function"
      ? finalizeEvent
      : async () => false;
    this.logger = logger;
    this.pollTimer = null;
  }

  async finalizeEventSafely(eventID, result, context) {
    return this.finalizeEvent(eventID, result, context);
  }

  async sendCommandReply(event, text, bizCard = null) {
    await this.bridge.sendText({
      eventID: event.event_id,
      sessionID: event.session_id,
      text,
      quotedMessageID: event.msg_id,
      clientMsgID: `elicitation_reply_${event.event_id}`,
      extra: {
        reply_source: "claude_channel_question",
        ...(bizCard ? { biz_card: bizCard } : {}),
      },
    });
  }

  async handleCommandEvent(event) {
    const parsed = parseQuestionResponseCommand(event.content);
    if (!parsed.matched) {
      return {
        handled: false,
        kind: "",
      };
    }

    if (!parsed.ok) {
      await this.sendCommandReply(event, parsed.error, buildQuestionStatusBizCard({
        summary: parsed.error,
      }));
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "elicitation_command_invalid",
        msg: "elicitation command invalid",
      }, "elicitation invalid terminal result failed");
      return {
        handled: true,
        kind: "elicitation",
      };
    }

    const request = await this.elicitationStore.getRequest(parsed.request_id);
    if (!request) {
      await this.sendCommandReply(
        event,
        `Input request ${parsed.request_id} was not found.`,
        buildQuestionStatusBizCard({
          summary: `Input request ${parsed.request_id} was not found.`,
          referenceID: parsed.request_id,
          status: "warning",
        }),
      );
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "elicitation_request_not_found",
        msg: "elicitation request not found",
      }, "elicitation not-found terminal result failed");
      return {
        handled: true,
        kind: "elicitation",
      };
    }

    if (request.channel_context.chat_id !== event.session_id) {
      await this.sendCommandReply(
        event,
        "This input request belongs to a different Grix chat.",
        buildQuestionStatusBizCard({
          summary: "This input request belongs to a different Grix chat.",
          referenceID: parsed.request_id,
          status: "warning",
        }),
      );
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "elicitation_chat_mismatch",
        msg: "elicitation request belongs to a different chat",
      }, "elicitation chat-mismatch terminal result failed");
      return {
        handled: true,
        kind: "elicitation",
      };
    }

    if (request.status !== "pending") {
      await this.sendCommandReply(
        event,
        `Input request ${parsed.request_id} is ${request.status}.`,
        buildQuestionStatusBizCard({
          summary: `Input request ${parsed.request_id} is ${request.status}.`,
          referenceID: parsed.request_id,
          status: "warning",
        }),
      );
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "elicitation_request_not_pending",
        msg: `elicitation request is ${request.status}`,
      }, "elicitation not-pending terminal result failed");
      return {
        handled: true,
        kind: "elicitation",
      };
    }

    let hookOutput;
    try {
      hookOutput = buildElicitationHookOutput(request, parsed.response);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      await this.sendCommandReply(event, message, buildQuestionStatusBizCard({
        summary: message,
        referenceID: parsed.request_id,
        status: "warning",
      }));
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "elicitation_answer_invalid",
        msg: message,
      }, "elicitation invalid-answer terminal result failed");
      return {
        handled: true,
        kind: "elicitation",
      };
    }

    await this.elicitationStore.resolveRequest(parsed.request_id, {
      action: hookOutput.action,
      content: hookOutput.content,
      resolvedBy: {
        sender_id: event.sender_id,
        session_id: event.session_id,
        event_id: event.event_id,
        msg_id: event.msg_id,
      },
    });
    this.logger.trace?.({
      component: "worker.elicitation",
      stage: "elicitation_command_resolved",
      event_id: event.event_id,
      session_id: event.session_id,
      sender_id: event.sender_id,
      request_id: parsed.request_id,
      origin_event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
    });

    const responseText = buildElicitationResponseText({
      requestID: parsed.request_id,
    });
    await this.sendCommandReply(event, responseText, buildQuestionStatusBizCard({
      summary: responseText,
      referenceID: parsed.request_id,
      status: "success",
    }));
    await this.finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "elicitation_recorded",
      msg: "elicitation answers recorded",
    }, "elicitation recorded terminal result failed");
    return {
      handled: true,
      kind: "elicitation",
    };
  }

  async dispatchRequest(request) {
    const ack = await this.bridge.sendText({
      sessionID: request.channel_context.chat_id,
      text: buildElicitationRequestText(request),
      quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
      clientMsgID: `elicitation_request_${request.request_id}`,
      extra: {
        reply_source: "claude_elicitation",
        elicitation_request_id: request.request_id,
        biz_card: buildQuestionRequestBizCard(request),
      },
    });
    await this.elicitationStore.markDispatched(request.request_id, {
      dispatchedAt: Date.now(),
      promptMessageID: normalizeOptionalString(ack.msg_id),
    });
    this.logger.trace?.({
      component: "worker.elicitation",
      stage: "elicitation_request_dispatched",
      request_id: request.request_id,
      event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
      msg_id: request.channel_context.message_id || request.channel_context.msg_id,
    });
  }

  async pumpRequests() {
    const pending = await this.elicitationStore.listPendingDispatches();
    for (const request of pending) {
      try {
        await this.dispatchRequest(request);
      } catch (error) {
        await this.elicitationStore.markDispatchFailed(request.request_id, String(error));
        this.logger.error(`elicitation request dispatch failed request=${request.request_id}: ${String(error)}`);
      }
    }
  }

  startDispatchPumps() {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pumpRequests();
    }, elicitationPollIntervalMs);
  }

  stopDispatchPumps() {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async shutdown() {
    this.stopDispatchPumps();
  }
}
