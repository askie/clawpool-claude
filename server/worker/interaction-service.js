import { loadEventEntries } from "../event-state-persistence.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { ResultTimeoutManager } from "../result-timeout.js";
import { buildChannelNotificationParams } from "../channel-notification.js";

const defaultResultTimeoutMs = 10 * 60 * 1000;
const resultTimeoutRetryMs = 10 * 1000;
const composingHeartbeatMs = 10 * 1000;
const composingTTLMS = 30 * 1000;
function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function isGroupSession(payload) {
  return (
    Number(payload.session_type ?? 0) === 2
    || normalizeString(payload.event_type).startsWith("group_")
  );
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

export class WorkerInteractionService {
  constructor({
    eventState,
    sessionContextStore,
    accessStore,
    eventStatesDir,
    mcp,
    bridge,
    humanLoopService = null,
    logger,
  }) {
    this.eventState = eventState;
    this.sessionContextStore = sessionContextStore;
    this.accessStore = accessStore;
    this.eventStatesDir = eventStatesDir;
    this.mcp = mcp;
    this.bridge = bridge;
    this.humanLoopService = humanLoopService;
    this.logger = logger;
    this.composingKeepaliveTimers = new Map();
    this.resultTimeouts = new ResultTimeoutManager({
      defaultResultTimeoutMs,
      onTimeout: async (eventID) => this.onResultTimeout(eventID),
    });
  }

  async onResultTimeout(eventID) {
    const event = this.eventState.get(eventID);
    if (!event || event.completed) {
      return;
    }

    const result = event.result_intent
      ? this.buildTerminalResult(event.result_intent)
      : this.buildTerminalResult({
          status: "failed",
          code: "claude_result_timeout",
          msg: "Claude did not call reply or complete before timeout.",
        });

    this.eventState.setResultIntent(eventID, result);
    try {
      await this.bridge.sendEventResult({
        event_id: eventID,
        ...result,
      });
      this.cancelResultTimeout(eventID);
      this.eventState.clearResultIntent(eventID);
      this.eventState.markCompleted(eventID, result);
      this.logger.info(`result timeout finalized event=${eventID} status=${result.status}`);
    } catch (error) {
      this.logger.error(`result timeout send failed event=${eventID}: ${String(error)}`);
      const deadlineAt = this.resultTimeouts.arm(eventID, {
        timeoutMs: resultTimeoutRetryMs,
      });
      this.eventState.setResultDeadline(eventID, { deadlineAt });
    }
  }

  markEventAccepted(event) {
    return (
      this.eventState.markAcked(event.event_id, {
        ackedAt: Date.now(),
      }) ?? event
    );
  }

  armResultTimeout(eventID, timeoutMs = defaultResultTimeoutMs) {
    const deadlineAt = this.resultTimeouts.arm(eventID, { timeoutMs });
    this.eventState.setResultDeadline(eventID, { deadlineAt });
    return deadlineAt;
  }

  cancelResultTimeout(eventID) {
    this.resultTimeouts.cancel(eventID);
    this.eventState.clearResultDeadline(eventID);
  }

  clearComposingKeepaliveTimer(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return;
    }
    const timer = this.composingKeepaliveTimers.get(normalizedEventID);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.composingKeepaliveTimers.delete(normalizedEventID);
  }

  sendComposingState(event, active) {
    if (!event || !normalizeString(event.session_id)) {
      return false;
    }
    void this.bridge.setSessionComposing({
      sessionID: event.session_id,
      active,
      ttlMs: active ? composingTTLMS : 0,
      refMsgID: event.msg_id,
      refEventID: event.event_id,
    }).catch((error) => {
      this.logger.error(
        `composing state send failed event=${event?.event_id ?? ""} active=${active}: ${String(error)}`,
      );
    });
    return true;
  }

  startComposingKeepalive(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return;
    }
    this.clearComposingKeepaliveTimer(normalizedEventID);
    const tick = () => {
      const current = this.eventState.get(normalizedEventID);
      if (!current || current.completed || current.stopped) {
        this.clearComposingKeepaliveTimer(normalizedEventID);
        return;
      }
      this.sendComposingState(current, true);
    };
    tick();
    const timer = setInterval(tick, composingHeartbeatMs);
    this.composingKeepaliveTimers.set(normalizedEventID, timer);
  }

  stopComposingKeepalive(eventID, fallbackEvent = null) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return;
    }
    this.clearComposingKeepaliveTimer(normalizedEventID);
    const current = this.eventState.get(normalizedEventID) ?? fallbackEvent;
    if (!current) {
      return;
    }
    this.sendComposingState(current, false);
  }

  buildTerminalResult({ status, code = "", msg = "" }) {
    return {
      status: normalizeString(status),
      code: normalizeOptionalString(code),
      msg: normalizeOptionalString(msg),
      updated_at: Date.now(),
    };
  }

  async sendTerminalResult(eventID, { status, code = "", msg = "" }) {
    const event = this.eventState.get(eventID);
    const result = this.buildTerminalResult({
      status,
      code,
      msg,
    });
    this.eventState.setResultIntent(eventID, result);
    try {
      await this.bridge.sendEventResult({
        event_id: eventID,
        ...result,
      });
    } catch (error) {
      this.logger.error(`sendTerminalResult send failed event=${eventID}, will retry: ${String(error)}`);
      const deadlineAt = this.resultTimeouts.arm(eventID, { timeoutMs: resultTimeoutRetryMs });
      this.eventState.setResultDeadline(eventID, { deadlineAt });
      this.stopComposingKeepalive(eventID, event);
      return null;
    }
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "event_finalized",
      event_id: eventID,
      session_id: event?.session_id,
      status: result.status,
      code: result.code,
    });
    this.cancelResultTimeout(eventID);
    this.eventState.clearResultIntent(eventID);
    const completed = this.eventState.markCompleted(eventID, result);
    this.stopComposingKeepalive(eventID, event);
    return completed;
  }

  async finalizeEventSafely(eventID, result, context) {
    try {
      await this.sendTerminalResult(eventID, result);
      return true;
    } catch (error) {
      this.logger.error(`${context} event=${eventID}: ${String(error)}`);
      return false;
    }
  }

  async dispatchChannelNotification(event) {
    this.startComposingKeepalive(event.event_id);
    await this.mcp.notification({
      method: "notifications/claude/channel",
      params: buildChannelNotificationParams(event),
    });
    this.eventState.markNotificationDispatched(event.event_id, {
      dispatchedAt: Date.now(),
    });
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "channel_notification_dispatched",
      event_id: event.event_id,
      session_id: event.session_id,
      msg_id: event.msg_id,
      sender_id: event.sender_id,
    });
    this.logger.debug(`event notification-dispatched event=${event.event_id}`);
  }

  async sendAccessStatusMessage(sessionID, text, clientMsgID) {
    await this.bridge.sendText({
      sessionID,
      text,
      clientMsgID,
      extra: {
        reply_source: "claude_channel_access",
      },
    });
  }

  async sendPairingMessage(event) {
    const pair = await this.accessStore.issuePairingCode({
      senderID: event.sender_id,
      sessionID: event.session_id,
    });
    const text = [
      "This sender is not allowlisted for the Claude Clawpool channel.",
      `Pairing code: ${pair.code}`,
      "Ask the Claude Code user to run /clawpool:access pair <code> with this code to approve the sender.",
    ].join("\n");

    await this.bridge.sendText({
      sessionID: event.session_id,
      text,
      clientMsgID: `pair_${event.event_id}`,
    });
    this.eventState.markPairingSent(event.event_id, {
      sentAt: Date.now(),
    });
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "pairing_sent",
      event_id: event.event_id,
      session_id: event.session_id,
      sender_id: event.sender_id,
    });
    await this.finalizeEventSafely(event.event_id, {
      status: "responded",
      code: "pairing_required",
      msg: "pairing code sent",
    }, "pairing terminal result failed");
  }

  async handleDuplicateEvent(event) {
    this.logger.info(`duplicate inbound event handled event=${event.event_id}`);

    if (!event.acked) {
      this.markEventAccepted(event);
    }

    if (event.completed) {
      await this.bridge.sendEventResult({
        event_id: event.event_id,
        status: event.completed.status,
        code: event.completed.code,
        msg: event.completed.msg,
        updated_at: Date.now(),
      });
      return;
    }

    if (event.result_intent) {
      await this.finalizeEventSafely(event.event_id, event.result_intent, "duplicate result resend failed");
      return;
    }

    this.startComposingKeepalive(event.event_id);

    if (event.pairing_sent_at && this.eventState.canResendPairing(event.event_id)) {
      try {
        await this.sendPairingMessage(event);
      } catch (error) {
        this.logger.error(`duplicate pairing resend failed event=${event.event_id}: ${String(error)}`);
      }
      return;
    }

    if (event.notification_dispatched_at) {
      return;
    }
  }

  startDispatchPumps() {
    this.humanLoopService?.startDispatchPumps?.();
  }

  stopDispatchPumps() {
    this.humanLoopService?.stopDispatchPumps?.();
  }

  async handleInboundEvent(rawPayload) {
    const payload = normalizeInboundEventPayload(rawPayload);

    if (!payload.event_id || !payload.session_id || !payload.msg_id || !payload.sender_id) {
      this.logger.error(`invalid event_msg payload: ${JSON.stringify(rawPayload)}`);
      return;
    }

    this.logger.debug(
      `event_msg event=${payload.event_id} session=${payload.session_id} msg=${payload.msg_id} sender=${payload.sender_id} content=${JSON.stringify(payload.content)}`,
    );

    let registration;
    try {
      registration = this.eventState.registerInbound(payload);
    } catch (error) {
      this.logger.error(`register inbound failed event=${payload.event_id}: ${String(error)}`);
      return;
    }

    let event = registration.event;
    if (registration.duplicate) {
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "event_duplicate",
        event_id: event.event_id,
        session_id: event.session_id,
        msg_id: event.msg_id,
      });
      await this.handleDuplicateEvent(event);
      return;
    }

    try {
      await persistEventChannelContext(this.sessionContextStore, event);
      this.logger.debug(`session-context stored session=${event.session_id} event=${event.event_id}`);
    } catch (error) {
      this.logger.error(`session-context store failed event=${event.event_id}: ${String(error)}`);
    }

    let policy = this.accessStore.getPolicy();
    const senderAllowlisted = this.accessStore.isSenderAllowlisted(event.sender_id);
    let senderAllowed = this.accessStore.isSenderAllowed(event.sender_id);
    const hasAllowedSenders = this.accessStore.hasAllowedSenders();
    event = this.markEventAccepted(event);
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "event_accepted",
      event_id: event.event_id,
      session_id: event.session_id,
      msg_id: event.msg_id,
      sender_id: event.sender_id,
      policy,
    });
    this.armResultTimeout(event.event_id);

    if (policy === "disabled") {
      this.logger.debug(`event disabled-policy event=${event.event_id}`);
      try {
        await this.sendAccessStatusMessage(
          event.session_id,
          "Claude Clawpool access is currently disabled for this channel.",
          `access_disabled_${event.event_id}`,
        );
      } catch (error) {
        this.logger.error(`disabled-policy notice failed event=${event.event_id}: ${String(error)}`);
      }
      await this.finalizeEventSafely(event.event_id, {
        status: "canceled",
        code: "policy_disabled",
        msg: "channel policy disabled",
      }, "policy-disabled result send failed");
      return;
    }

    if (
      !senderAllowlisted
      && !isGroupSession(rawPayload)
      && (
        policy === "open"
        || (policy === "allowlist" && !hasAllowedSenders)
      )
    ) {
      try {
        const bootstrap = await this.accessStore.bootstrapFirstSender(event.sender_id, {
          lockPolicyToAllowlist: policy === "open",
        });
        if (bootstrap.bootstrapped) {
          policy = bootstrap.policy;
          senderAllowed = true;
          this.logger.trace?.({
            component: "worker.interaction",
            stage: "sender_bootstrapped",
            event_id: event.event_id,
            session_id: event.session_id,
            sender_id: event.sender_id,
            policy,
          });
          this.logger.info(`bootstrapped sender allowlist sender=${event.sender_id} policy=${policy}`);
          this.logger.debug(`event first-sender-bootstrap event=${event.event_id} sender=${event.sender_id}`);
        }
      } catch (error) {
        try {
          await this.sendAccessStatusMessage(
            event.session_id,
            `Claude Clawpool could not auto-authorize this sender: ${String(error)}.`,
            `sender_bootstrap_failed_${event.event_id}`,
          );
        } catch (notifyError) {
          this.logger.error(`sender bootstrap notice failed event=${event.event_id}: ${String(notifyError)}`);
        }
        await this.finalizeEventSafely(event.event_id, {
          status: "failed",
          code: "sender_bootstrap_failed",
          msg: String(error),
        }, "sender bootstrap result send failed");
        return;
      }
    }

    if (!senderAllowed) {
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "sender_blocked",
        event_id: event.event_id,
        session_id: event.session_id,
        sender_id: event.sender_id,
        policy,
        group_session: isGroupSession(rawPayload),
      }, { level: "error" });
      this.logger.debug(`event sender-blocked event=${event.event_id} sender=${event.sender_id} group=${isGroupSession(rawPayload)}`);
      if (isGroupSession(rawPayload)) {
        try {
          await this.sendAccessStatusMessage(
            event.session_id,
            "This sender is not allowlisted for the Claude Clawpool channel.",
            `sender_blocked_${event.event_id}`,
          );
        } catch (error) {
          this.logger.error(`group allowlist notice failed event=${event.event_id}: ${String(error)}`);
        }
        await this.finalizeEventSafely(event.event_id, {
          status: "canceled",
          code: "sender_not_allowlisted",
          msg: "sender not allowlisted",
        }, "group allowlist result send failed");
        return;
      }
      try {
        await this.sendPairingMessage(event);
      } catch (error) {
        await this.finalizeEventSafely(event.event_id, {
          status: "failed",
          code: "pairing_send_failed",
          msg: String(error),
        }, "pairing failure result send failed");
      }
      return;
    }

    const humanLoopCommand = await this.humanLoopService?.handleCommandEvent?.(event);
    if (humanLoopCommand?.handled) {
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "human_loop_command_handled",
        event_id: event.event_id,
        session_id: event.session_id,
        kind: humanLoopCommand.kind,
      });
      this.logger.debug(`event ${humanLoopCommand.kind}-command event=${event.event_id}`);
      return;
    }

    try {
      await this.dispatchChannelNotification(event);
    } catch (error) {
      await this.finalizeEventSafely(event.event_id, {
        status: "failed",
        code: "channel_notification_failed",
        msg: String(error),
      }, "channel notification result send failed");
    }
  }

  async handleStopEvent(rawPayload) {
    const eventID = normalizeString(rawPayload.event_id);
    if (!eventID) {
      return;
    }
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "stop_received",
      event_id: eventID,
      session_id: rawPayload.session_id,
      stop_id: rawPayload.stop_id,
    });
    const stopID = normalizeString(rawPayload.stop_id);
    const existing = this.eventState.get(eventID);

    try {
      await this.bridge.sendEventStopAck({
        event_id: eventID,
        stop_id: stopID,
        accepted: true,
        updated_at: Date.now(),
      });
    } catch (error) {
      this.logger.error(`sendEventStopAck failed event=${eventID}: ${String(error)}`);
    }

    if (!existing || existing.completed) {
      this.stopComposingKeepalive(eventID, existing);
      try {
        await this.bridge.sendEventStopResult({
          event_id: eventID,
          stop_id: stopID,
          status: "already_finished",
          updated_at: Date.now(),
        });
      } catch (error) {
        this.logger.error(`sendEventStopResult(already_finished) failed event=${eventID}: ${String(error)}`);
      }
      return;
    }

    this.eventState.markStopped(eventID, {
      stop_id: stopID,
      reason: "owner_requested_stop",
      updated_at: Date.now(),
    });
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "stop_recorded",
      event_id: eventID,
      session_id: existing?.session_id,
      stop_id: stopID,
    });
    try {
      await this.bridge.sendEventStopResult({
        event_id: eventID,
        stop_id: stopID,
        status: "stopped",
        code: "owner_requested_stop",
        msg: "owner requested stop",
        updated_at: Date.now(),
      });
    } catch (error) {
      this.logger.error(`sendEventStopResult(stopped) failed event=${eventID}: ${String(error)}`);
    }
    await this.finalizeEventSafely(eventID, {
      status: "canceled",
      code: "owner_requested_stop",
      msg: "owner requested stop",
    }, "stop terminal result failed");
  }

  async handleRevokeEvent(rawPayload) {
    const eventID = normalizeString(rawPayload.event_id);
    if (!eventID) {
      return;
    }
    this.logger.trace?.({
      component: "worker.interaction",
      stage: "revoke_received",
      event_id: eventID,
      session_id: rawPayload.session_id,
      msg_id: rawPayload.msg_id,
    });
    this.stopComposingKeepalive(eventID);
    await this.bridge.ackEvent(eventID, {
      sessionID: normalizeOptionalString(rawPayload.session_id),
      msgID: normalizeOptionalString(rawPayload.msg_id),
      receivedAt: Date.now(),
    });
    this.logger.info(`event_revoke acked event=${eventID}`);
  }

  async restoreEventState() {
    const entries = await loadEventEntries(this.eventStatesDir, {
      completedTTLms: this.eventState.ttlMs,
      pendingTTLms: this.eventState.pendingTTLms,
    });
    const now = Date.now();
    let restored = 0;
    for (const entry of entries) {
      this.eventState.restore(entry);
      restored += 1;
      if (!entry.completed && Number(entry.result_deadline_at) > 0) {
        const remaining = Math.max(0, Number(entry.result_deadline_at) - now);
        const deadlineAt = this.resultTimeouts.arm(entry.event_id, { timeoutMs: remaining });
        this.eventState.setResultDeadline(entry.event_id, { deadlineAt });
      }
    }
    if (restored > 0) {
      this.logger.info(`restored ${restored} event state entries`);
    }
    return entries;
  }

  async shutdown() {
    this.stopDispatchPumps();
    this.resultTimeouts.close();
    for (const eventID of this.composingKeepaliveTimers.keys()) {
      this.clearComposingKeepaliveTimer(eventID);
    }
  }
}
