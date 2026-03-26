import { canDeliverToWorker, hasWorkerControl } from "./worker-state.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function resolveRecordInFlightActivityAt(record) {
  const updatedAt = Number(record?.updated_at ?? 0);
  const composingAt = Number(record?.last_composing_at ?? 0);
  const normalizedUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
  const normalizedComposingAt = Number.isFinite(composingAt) && composingAt > 0 ? composingAt : 0;
  return Math.max(normalizedUpdatedAt, normalizedComposingAt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PendingEventOrchestrator {
  constructor({
    messageDeliveryStore,
    bindingRegistry,
    deliverEventToWorker,
    trace = () => {},
    deliveredInFlightMaxAgeMs = 0,
    retryDelayMs = 200,
  }) {
    this.messageDeliveryStore = messageDeliveryStore;
    this.bindingRegistry = bindingRegistry;
    this.deliverEventToWorker = deliverEventToWorker;
    this.trace = trace;
    this.deliveredInFlightMaxAgeMs = Number.isFinite(Number(deliveredInFlightMaxAgeMs))
      ? Math.max(0, Math.floor(Number(deliveredInFlightMaxAgeMs)))
      : 0;
    this.retryDelayMs = Number.isFinite(Number(retryDelayMs))
      ? Math.max(0, Math.floor(Number(retryDelayMs)))
      : 200;
  }

  async trackPendingEvent(rawPayload) {
    return this.messageDeliveryStore.trackPendingEvent(rawPayload);
  }

  async markPendingEventDelivered(eventID, binding) {
    return this.messageDeliveryStore.markPendingEventDelivered(
      eventID,
      normalizeString(binding?.worker_id),
    );
  }

  async markPendingEventDispatching(eventID, binding) {
    return this.messageDeliveryStore.markPendingEventDispatching(
      eventID,
      normalizeString(binding?.worker_id),
    );
  }

  async markPendingEventPending(eventID) {
    return this.messageDeliveryStore.markPendingEventPending(eventID);
  }

  async markPendingEventInterrupted(eventID) {
    return this.messageDeliveryStore.markPendingEventInterrupted(eventID);
  }

  async clearPendingEvent(eventID) {
    return this.messageDeliveryStore.clearEventState(eventID);
  }

  listPendingEventsForSession(sessionID) {
    return this.messageDeliveryStore.listPendingEventsForSession(sessionID);
  }

  listPendingEvents() {
    return this.messageDeliveryStore.listPendingEvents();
  }

  getPendingEvent(eventID) {
    return this.messageDeliveryStore.getPendingEvent(eventID);
  }

  async touchPendingEvent(eventID) {
    return this.messageDeliveryStore.touchPendingEvent(eventID);
  }

  async touchPendingEventComposing(eventID) {
    return this.messageDeliveryStore.touchPendingEventComposing(eventID);
  }

  hasInFlightSessionEvent(sessionID, { excludeEventID = "" } = {}) {
    const normalizedSessionID = normalizeString(sessionID);
    const excludedEventID = normalizeString(excludeEventID);
    if (!normalizedSessionID) {
      return false;
    }
    return this.listPendingEventsForSession(normalizedSessionID).some((record) => {
      if (excludedEventID && normalizeString(record.eventID) === excludedEventID) {
        return false;
      }
      const deliveryState = normalizeString(record.delivery_state);
      if (deliveryState === "dispatching") {
        return true;
      }
      if (deliveryState !== "delivered") {
        return false;
      }
      if (this.deliveredInFlightMaxAgeMs <= 0) {
        return false;
      }
      const activityAt = resolveRecordInFlightActivityAt(record);
      if (!Number.isFinite(activityAt) || activityAt <= 0) {
        return true;
      }
      const ageMs = Date.now() - activityAt;
      if (ageMs <= this.deliveredInFlightMaxAgeMs) {
        return true;
      }
      this.trace({
        stage: "delivered_inflight_released",
        session_id: normalizedSessionID,
        event_id: record.eventID,
        age_ms: ageMs,
      }, "error");
      return false;
    });
  }

  async flushPendingSessionEvents(sessionID, binding) {
    const normalizedSessionID = normalizeString(sessionID);
    if (
      !normalizedSessionID
      || !binding?.worker_control_url
      || !binding?.worker_control_token
    ) {
      return;
    }

    if (this.hasInFlightSessionEvent(normalizedSessionID)) {
      this.trace({
        stage: "pending_event_flush_skipped_inflight",
        session_id: normalizedSessionID,
        worker_id: binding?.worker_id,
      });
      return;
    }

    for (const record of this.listPendingEventsForSession(normalizedSessionID)) {
      const currentRecord = this.getPendingEvent(record.eventID) ?? record;
      if (currentRecord.delivery_state !== "pending") {
        continue;
      }
      try {
        this.trace({
          stage: "pending_event_flushing",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
          attempt: 1,
        });
        await this.markPendingEventDispatching(currentRecord.eventID, binding);
        await this.deliverEventToWorker(binding, currentRecord.rawPayload);
        await this.markPendingEventDelivered(currentRecord.eventID, binding);
        this.trace({
          stage: "pending_event_flushed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
        });
        return;
      } catch (error) {
        await this.markPendingEventPending(currentRecord.eventID);
        this.trace({
          stage: "pending_event_flush_retrying",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
          attempt: 1,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
      }

      await sleep(this.retryDelayMs);
      const latestBinding = this.bindingRegistry.getByAibotSessionID(normalizedSessionID);
      if (!canDeliverToWorker(latestBinding)) {
        this.trace({
          stage: "pending_event_flush_retry_aborted",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          status: latestBinding?.worker_status,
        }, "error");
        return;
      }

      try {
        this.trace({
          stage: "pending_event_flushing",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          attempt: 2,
        });
        await this.markPendingEventDispatching(currentRecord.eventID, latestBinding);
        await this.deliverEventToWorker(latestBinding, currentRecord.rawPayload);
        await this.markPendingEventDelivered(currentRecord.eventID, latestBinding);
        this.trace({
          stage: "pending_event_flushed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          attempt: 2,
        });
        return;
      } catch (error) {
        await this.markPendingEventPending(currentRecord.eventID);
        this.trace({
          stage: "pending_event_flush_failed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id || binding?.worker_id,
          attempt: 2,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
        return;
      }
    }
  }
}
