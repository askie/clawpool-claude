import { parseApprovalDecisionCommand } from "../approval-command.js";
import {
  buildApprovalDecisionResponseText,
  buildApprovalRequestText,
} from "../approval-text.js";
import { parseQuestionResponseCommand } from "../question-command.js";
import { buildAskUserQuestionUpdatedInput } from "../question-response.js";
import {
  buildQuestionRequestText,
  buildQuestionResponseText,
} from "../question-text.js";

const approvalPollIntervalMs = 1500;
const questionPollIntervalMs = 1500;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
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

export class WorkerHumanLoopService {
  constructor({
    accessStore,
    approvalStore,
    questionStore,
    bridge,
    finalizeEvent,
    logger,
  }) {
    this.accessStore = accessStore;
    this.approvalStore = approvalStore;
    this.questionStore = questionStore;
    this.bridge = bridge;
    this.finalizeEvent = typeof finalizeEvent === "function"
      ? finalizeEvent
      : async () => false;
    this.logger = logger;
    this.approvalPollTimer = null;
    this.questionPollTimer = null;
  }

  async finalizeEventSafely(eventID, result, context) {
    return this.finalizeEvent(eventID, result, context);
  }

  async sendCommandReply(event, text, {
    clientMsgPrefix,
    replySource,
  }) {
    await this.bridge.sendText({
      eventID: event.event_id,
      sessionID: event.session_id,
      text,
      quotedMessageID: event.msg_id,
      clientMsgID: `${clientMsgPrefix}_${event.event_id}`,
      extra: {
        reply_source: replySource,
      },
    });
  }

  async sendApprovalCommandReply(event, text) {
    await this.sendCommandReply(event, text, {
      clientMsgPrefix: "approval_reply",
      replySource: "claude_channel_approval",
    });
  }

  async sendQuestionCommandReply(event, text) {
    await this.sendCommandReply(event, text, {
      clientMsgPrefix: "question_reply",
      replySource: "claude_channel_question",
    });
  }

  async handleApprovalDecisionEvent(event) {
    const parsed = parseApprovalDecisionCommand(event.content);
    if (!parsed.matched) {
      return false;
    }

    if (!parsed.ok) {
      await this.sendApprovalCommandReply(event, parsed.error);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "approval_command_invalid",
        msg: "approval command invalid",
      }, "approval invalid terminal result failed");
      return true;
    }

    if (!this.accessStore.isSenderApprover(event.sender_id)) {
      await this.sendApprovalCommandReply(event, "This sender is not configured as a Claude approval approver.");
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "approval_sender_not_authorized",
        msg: "sender not configured as approver",
      }, "approval unauthorized terminal result failed");
      return true;
    }

    const request = await this.approvalStore.getRequest(parsed.request_id);
    if (!request) {
      await this.sendApprovalCommandReply(event, `Approval request ${parsed.request_id} was not found.`);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "approval_request_not_found",
        msg: "approval request not found",
      }, "approval not-found terminal result failed");
      return true;
    }

    if (request.channel_context.chat_id !== event.session_id) {
      await this.sendApprovalCommandReply(event, "This approval request belongs to a different ClawPool chat.");
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "approval_chat_mismatch",
        msg: "approval request belongs to a different chat",
      }, "approval chat-mismatch terminal result failed");
      return true;
    }

    if (request.status !== "pending") {
      await this.sendApprovalCommandReply(event, `Approval request ${parsed.request_id} is ${request.status}.`);
      await this.finalizeEventSafely(event.event_id, {
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
      const message = String(error instanceof Error ? error.message : error);
      await this.sendApprovalCommandReply(event, message);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "approval_rule_invalid",
        msg: message,
      }, "approval invalid-rule terminal result failed");
      return true;
    }

    await this.approvalStore.resolveRequest(parsed.request_id, {
      decision,
      resolvedBy: {
        sender_id: event.sender_id,
        session_id: event.session_id,
        event_id: event.event_id,
        msg_id: event.msg_id,
      },
    });
    this.logger.trace?.({
      component: "worker.human_loop",
      stage: "approval_command_resolved",
      event_id: event.event_id,
      session_id: event.session_id,
      sender_id: event.sender_id,
      request_id: parsed.request_id,
      origin_event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
    });
    await this.sendApprovalCommandReply(event, buildApprovalDecisionResponseText({
      requestID: parsed.request_id,
      resolution: parsed.resolution,
    }));
    await this.finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "approval_recorded",
      msg: "approval decision recorded",
    }, "approval recorded terminal result failed");
    return true;
  }

  async handleQuestionResponseEvent(event) {
    const parsed = parseQuestionResponseCommand(event.content);
    if (!parsed.matched) {
      return false;
    }

    if (!parsed.ok) {
      await this.sendQuestionCommandReply(event, parsed.error);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "question_command_invalid",
        msg: "question command invalid",
      }, "question invalid terminal result failed");
      return true;
    }

    const request = await this.questionStore.getRequest(parsed.request_id);
    if (!request) {
      await this.sendQuestionCommandReply(event, `Question request ${parsed.request_id} was not found.`);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "question_request_not_found",
        msg: "question request not found",
      }, "question not-found terminal result failed");
      return true;
    }

    if (request.channel_context.chat_id !== event.session_id) {
      await this.sendQuestionCommandReply(event, "This question request belongs to a different ClawPool chat.");
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "question_chat_mismatch",
        msg: "question request belongs to a different chat",
      }, "question chat-mismatch terminal result failed");
      return true;
    }

    if (request.status !== "pending") {
      await this.sendQuestionCommandReply(event, `Question request ${parsed.request_id} is ${request.status}.`);
      await this.finalizeEventSafely(event.event_id, {
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
      const message = String(error instanceof Error ? error.message : error);
      await this.sendQuestionCommandReply(event, message);
      await this.finalizeEventSafely(event.event_id, {
        status: "responded",
        code: "question_answer_invalid",
        msg: message,
      }, "question invalid-answer terminal result failed");
      return true;
    }

    await this.questionStore.resolveRequest(parsed.request_id, {
      answers: updatedInput.answers,
      resolvedBy: {
        sender_id: event.sender_id,
        session_id: event.session_id,
        event_id: event.event_id,
        msg_id: event.msg_id,
      },
    });
    this.logger.trace?.({
      component: "worker.human_loop",
      stage: "question_command_resolved",
      event_id: event.event_id,
      session_id: event.session_id,
      sender_id: event.sender_id,
      request_id: parsed.request_id,
      origin_event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
    });
    await this.sendQuestionCommandReply(event, buildQuestionResponseText({
      requestID: parsed.request_id,
    }));
    await this.finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "question_recorded",
      msg: "question answers recorded",
    }, "question recorded terminal result failed");
    return true;
  }

  async handleCommandEvent(event) {
    if (await this.handleApprovalDecisionEvent(event)) {
      return {
        handled: true,
        kind: "approval",
      };
    }

    if (await this.handleQuestionResponseEvent(event)) {
      return {
        handled: true,
        kind: "question",
      };
    }

    return {
      handled: false,
      kind: "",
    };
  }

  async dispatchApprovalRequest(request) {
    const ack = await this.bridge.sendText({
      sessionID: request.channel_context.chat_id,
      text: buildApprovalRequestText(request),
      quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
      clientMsgID: `approval_request_${request.request_id}`,
      extra: {
        reply_source: "claude_permission_request",
        approval_request_id: request.request_id,
      },
    });
    await this.approvalStore.markDispatched(request.request_id, {
      dispatchedAt: Date.now(),
      approvalMessageID: normalizeOptionalString(ack.msg_id),
    });
    this.logger.trace?.({
      component: "worker.human_loop",
      stage: "approval_request_dispatched",
      request_id: request.request_id,
      event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
      msg_id: request.channel_context.message_id || request.channel_context.msg_id,
    });
  }

  async dispatchQuestionRequest(request) {
    const ack = await this.bridge.sendText({
      sessionID: request.channel_context.chat_id,
      text: buildQuestionRequestText(request),
      quotedMessageID: request.channel_context.message_id || request.channel_context.msg_id,
      clientMsgID: `question_request_${request.request_id}`,
      extra: {
        reply_source: "claude_ask_user_question",
        question_request_id: request.request_id,
      },
    });
    await this.questionStore.markDispatched(request.request_id, {
      dispatchedAt: Date.now(),
      questionMessageID: normalizeOptionalString(ack.msg_id),
    });
    this.logger.trace?.({
      component: "worker.human_loop",
      stage: "question_request_dispatched",
      request_id: request.request_id,
      event_id: request.channel_context.event_id,
      chat_id: request.channel_context.chat_id,
      msg_id: request.channel_context.message_id || request.channel_context.msg_id,
    });
  }

  async pumpApprovalRequests() {
    const pending = await this.approvalStore.listPendingDispatches();
    for (const request of pending) {
      try {
        await this.dispatchApprovalRequest(request);
      } catch (error) {
        await this.approvalStore.markDispatchFailed(request.request_id, String(error));
        this.logger.error(`approval request dispatch failed request=${request.request_id}: ${String(error)}`);
      }
    }
  }

  async pumpQuestionRequests() {
    const pending = await this.questionStore.listPendingDispatches();
    for (const request of pending) {
      try {
        await this.dispatchQuestionRequest(request);
      } catch (error) {
        await this.questionStore.markDispatchFailed(request.request_id, String(error));
        this.logger.error(`question request dispatch failed request=${request.request_id}: ${String(error)}`);
      }
    }
  }

  startApprovalPump() {
    if (this.approvalPollTimer) {
      return;
    }
    this.approvalPollTimer = setInterval(() => {
      void this.pumpApprovalRequests();
    }, approvalPollIntervalMs);
  }

  startQuestionPump() {
    if (this.questionPollTimer) {
      return;
    }
    this.questionPollTimer = setInterval(() => {
      void this.pumpQuestionRequests();
    }, questionPollIntervalMs);
  }

  startDispatchPumps() {
    this.startApprovalPump();
    this.startQuestionPump();
  }

  stopApprovalPump() {
    if (!this.approvalPollTimer) {
      return;
    }
    clearInterval(this.approvalPollTimer);
    this.approvalPollTimer = null;
  }

  stopQuestionPump() {
    if (!this.questionPollTimer) {
      return;
    }
    clearInterval(this.questionPollTimer);
    this.questionPollTimer = null;
  }

  stopDispatchPumps() {
    this.stopApprovalPump();
    this.stopQuestionPump();
  }

  async shutdown() {
    this.stopDispatchPumps();
  }
}
