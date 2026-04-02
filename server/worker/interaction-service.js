import { loadEventEntries } from "../event-state-persistence.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { buildChannelNotificationParams } from "../channel-notification.js";
import {
  defaultWorkerPingProbeTimeoutMs,
  extractWorkerProbeMeta,
} from "../worker-probe.js";
import {
  buildAccessStatusBizCard,
  buildPairingBizCard,
} from "../claude-card-payload.js";
import { WorkerEventLifecycleManager } from "./event-lifecycle-manager.js";
function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function shouldRestoreLocalResultTimeout(entry) {
  return Boolean(entry?.result_intent);
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
    permissionRelayService = null,
    elicitationRelayService = null,
    resultTimeoutMs = undefined,
    resultRetryTimeoutMs = undefined,
    composingHeartbeatMs = undefined,
    composingTTLMS = undefined,
    logger,
  }) {
    this.eventState = eventState;
    this.sessionContextStore = sessionContextStore;
    this.accessStore = accessStore;
    this.eventStatesDir = eventStatesDir;
    this.mcp = mcp;
    this.bridge = bridge;
    this.permissionRelayService = permissionRelayService;
    this.elicitationRelayService = elicitationRelayService;
    this.logger = logger;
    this.eventLifecycle = new WorkerEventLifecycleManager({
      eventState: this.eventState,
      bridge: this.bridge,
      logger: this.logger,
      ...(Number.isFinite(Number(resultTimeoutMs)) && Number(resultTimeoutMs) > 0
        ? { defaultTimeoutMs: Number(resultTimeoutMs) }
        : {}),
      ...(Number.isFinite(Number(resultRetryTimeoutMs)) && Number(resultRetryTimeoutMs) > 0
        ? { retryTimeoutMs: Number(resultRetryTimeoutMs) }
        : {}),
      ...(Number.isFinite(Number(composingHeartbeatMs)) && Number(composingHeartbeatMs) > 0
        ? { composingHeartbeatMs: Number(composingHeartbeatMs) }
        : {}),
      ...(Number.isFinite(Number(composingTTLMS)) && Number(composingTTLMS) > 0
        ? { composingTTLMS: Number(composingTTLMS) }
        : {}),
    });
  }

  markEventAccepted(event) {
    return (
      this.eventState.markAcked(event.event_id, {
        ackedAt: Date.now(),
      }) ?? event
    );
  }

  async finalizeEventSafely(eventID, result, context) {
    return this.eventLifecycle.finalizeEventSafely(eventID, result, context);
  }

  async dispatchChannelNotification(event, { suppressComposing = false } = {}) {
    if (!suppressComposing) {
      this.eventLifecycle.startComposingKeepalive(event.event_id);
    }
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

  async sendAccessStatusMessage(sessionID, text, clientMsgID, bizCard = null) {
    await this.bridge.sendText({
      sessionID,
      text,
      clientMsgID,
      extra: {
        reply_source: "claude_channel_access",
        ...(bizCard ? { biz_card: bizCard } : {}),
      },
    });
  }

  async sendPairingMessage(event) {
    const pair = await this.accessStore.issuePairingCode({
      senderID: event.sender_id,
      sessionID: event.session_id,
    });
    const text = [
      "This sender is not allowlisted for the Claude Grix channel.",
      `Pairing code: ${pair.code}`,
      "Ask the Claude Code user to run /grix:access pair <code> with this code to approve the sender.",
    ].join("\n");

    await this.bridge.sendText({
      sessionID: event.session_id,
      text,
      clientMsgID: `pair_${event.event_id}`,
      extra: {
        biz_card: buildPairingBizCard(pair.code),
      },
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

    this.eventLifecycle.startComposingKeepalive(event.event_id);

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
    this.elicitationRelayService?.startDispatchPumps?.();
  }

  stopDispatchPumps() {
    this.elicitationRelayService?.stopDispatchPumps?.();
  }

  async handleInboundEvent(rawPayload) {
    const probeMeta = extractWorkerProbeMeta(rawPayload);
    const payload = {
      ...normalizeInboundEventPayload(rawPayload),
      transient: Boolean(probeMeta),
      internal_probe: Boolean(probeMeta),
      suppress_composing: Boolean(probeMeta),
    };

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

    if (probeMeta) {
      event = this.markEventAccepted(event);
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "internal_probe_accepted",
        event_id: event.event_id,
        session_id: event.session_id,
        probe_id: probeMeta.probeID,
      });
      this.eventLifecycle.armResultTimeout(event.event_id, defaultWorkerPingProbeTimeoutMs, {
        timeoutKind: "internal_probe",
      });
      try {
        await this.dispatchChannelNotification(event, { suppressComposing: true });
      } catch (error) {
        await this.finalizeEventSafely(event.event_id, {
          status: "failed",
          code: "channel_notification_failed",
          msg: String(error),
        }, "internal probe channel notification result send failed");
      }
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

    if (policy === "disabled") {
      this.logger.debug(`event disabled-policy event=${event.event_id}`);
      try {
        await this.sendAccessStatusMessage(
          event.session_id,
          "Claude Grix access is currently disabled for this channel.",
          `access_disabled_${event.event_id}`,
          buildAccessStatusBizCard({
            summary: "Claude Grix access is currently disabled for this channel.",
            status: "warning",
            referenceID: event.event_id,
          }),
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
            `Claude Grix could not auto-authorize this sender: ${String(error)}.`,
            `sender_bootstrap_failed_${event.event_id}`,
            buildAccessStatusBizCard({
              summary: `Claude Grix could not auto-authorize this sender: ${String(error)}.`,
              status: "error",
              referenceID: event.event_id,
            }),
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
            "This sender is not allowlisted for the Claude Grix channel.",
            `sender_blocked_${event.event_id}`,
            buildAccessStatusBizCard({
              summary: "This sender is not allowlisted for the Claude Grix channel.",
              status: "warning",
              referenceID: event.event_id,
            }),
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

    const permissionRelayCommand = await this.permissionRelayService?.handleCommandEvent?.(event);
    if (permissionRelayCommand?.handled) {
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "permission_relay_command_handled",
        event_id: event.event_id,
        session_id: event.session_id,
        kind: permissionRelayCommand.kind,
      });
      this.logger.debug(`event ${permissionRelayCommand.kind}-command event=${event.event_id}`);
      return;
    }

    const elicitationCommand = await this.elicitationRelayService?.handleCommandEvent?.(event);
    if (elicitationCommand?.handled) {
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "elicitation_command_handled",
        event_id: event.event_id,
        session_id: event.session_id,
        kind: elicitationCommand.kind,
      });
      this.logger.debug(`event ${elicitationCommand.kind}-command event=${event.event_id}`);
      return;
    }

    try {
      await this.dispatchChannelNotification(event);
      this.logger.trace?.({
        component: "worker.interaction",
        stage: "event_waiting_for_claude_result",
        event_id: event.event_id,
        session_id: event.session_id,
        local_result_timeout_armed: false,
        result_timeout_owner: "daemon",
      });
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
      this.eventLifecycle.stopComposingKeepalive(eventID, existing);
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
    this.eventLifecycle.stopComposingKeepalive(eventID);
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
      if (entry.completed || entry.stopped) {
        continue;
      }
      if (shouldRestoreLocalResultTimeout(entry)) {
        this.eventLifecycle.armRestoredEventTimeout(entry, { now });
      } else {
        this.logger.trace?.({
          component: "worker.interaction",
          stage: "event_restored_waiting_for_claude_result",
          event_id: entry.event_id,
          session_id: entry.session_id,
          local_result_timeout_armed: false,
          result_timeout_owner: "daemon",
        });
      }
    }
    if (restored > 0) {
      this.logger.info(`restored ${restored} event state entries`);
    }
    return entries;
  }

  async shutdown() {
    this.stopDispatchPumps();
    await this.eventLifecycle.shutdown();
    await this.permissionRelayService?.shutdown?.();
    await this.elicitationRelayService?.shutdown?.();
  }
}
