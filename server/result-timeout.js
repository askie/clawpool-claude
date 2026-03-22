const defaultTimeoutMs = 90 * 1000;

export class ResultTimeoutManager {
  constructor({ defaultResultTimeoutMs = defaultTimeoutMs, onTimeout }) {
    this.defaultResultTimeoutMs = defaultResultTimeoutMs;
    this.onTimeout = onTimeout;
    this.timers = new Map();
  }

  arm(eventID, { timeoutMs = this.defaultResultTimeoutMs } = {}) {
    const normalizedEventID = String(eventID ?? "").trim();
    if (!normalizedEventID) {
      throw new Error("eventID is required");
    }

    this.cancel(normalizedEventID);
    const timer = setTimeout(async () => {
      this.timers.delete(normalizedEventID);
      await this.onTimeout(normalizedEventID);
    }, timeoutMs);
    this.timers.set(normalizedEventID, timer);
    return Date.now() + timeoutMs;
  }

  cancel(eventID) {
    const normalizedEventID = String(eventID ?? "").trim();
    if (!normalizedEventID) {
      return;
    }

    const timer = this.timers.get(normalizedEventID);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(normalizedEventID);
  }

  close() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
