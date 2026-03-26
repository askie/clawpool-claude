import { ResultTimeoutManager } from "../result-timeout.js";

const defaultResultTimeoutMs = 90 * 1000;
const defaultResultTimeoutRetryMs = 10 * 1000;
const defaultComposingHeartbeatMs = 10 * 1000;
const defaultComposingTTLMS = 30 * 1000;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function normalizePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

export class WorkerEventLifecycleManager {
  constructor({
    eventState,
    bridge,
    logger,
    defaultTimeoutMs = defaultResultTimeoutMs,
    retryTimeoutMs = defaultResultTimeoutRetryMs,
    composingHeartbeatMs = defaultComposingHeartbeatMs,
    composingTTLMS = defaultComposingTTLMS,
  } = {}) {
    this.eventState = eventState;
    this.bridge = bridge;
    this.logger = logger;
    this.defaultTimeoutMs = normalizePositiveInt(defaultTimeoutMs, defaultResultTimeoutMs);
    this.retryTimeoutMs = normalizePositiveInt(retryTimeoutMs, defaultResultTimeoutRetryMs);
    this.composingHeartbeatMs = normalizePositiveInt(composingHeartbeatMs, defaultComposingHeartbeatMs);
    this.composingTTLMS = normalizePositiveInt(composingTTLMS, defaultComposingTTLMS);
    this.composingKeepaliveTimers = new Map();
    this.resultTimeouts = new ResultTimeoutManager({
      defaultResultTimeoutMs: this.defaultTimeoutMs,
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
        timeoutMs: this.retryTimeoutMs,
      });
      this.eventState.setResultDeadline(eventID, { deadlineAt });
    }
  }

  armResultTimeout(eventID, timeoutMs = this.defaultTimeoutMs) {
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

  shouldSuppressComposing(event) {
    return event?.suppress_composing === true;
  }

  sendComposingState(event, active) {
    if (!event || !normalizeString(event.session_id) || this.shouldSuppressComposing(event)) {
      return false;
    }
    void this.bridge.setSessionComposing({
      sessionID: event.session_id,
      active,
      ttlMs: active ? this.composingTTLMS : 0,
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
    const timer = setInterval(tick, this.composingHeartbeatMs);
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
    if (this.shouldSuppressComposing(current)) {
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
      const deadlineAt = this.resultTimeouts.arm(eventID, { timeoutMs: this.retryTimeoutMs });
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

  resolveRestoreTimeoutMs(entry, now = Date.now()) {
    const persistedDeadline = Number(entry.result_deadline_at);
    if (persistedDeadline > 0) {
      return Math.max(0, persistedDeadline - now);
    }
    if (entry.result_intent) {
      return this.retryTimeoutMs;
    }
    return this.defaultTimeoutMs;
  }

  armRestoredEventTimeout(entry, { now = Date.now() } = {}) {
    const timeoutMs = this.resolveRestoreTimeoutMs(entry, now);
    const deadlineAt = this.resultTimeouts.arm(entry.event_id, { timeoutMs });
    this.eventState.setResultDeadline(entry.event_id, { deadlineAt });
    return deadlineAt;
  }

  async shutdown() {
    this.resultTimeouts.close();
    for (const eventID of this.composingKeepaliveTimers.keys()) {
      this.clearComposingKeepaliveTimer(eventID);
    }
  }
}
