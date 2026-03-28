/**
 * Per-session serial queue.
 *
 * Guarantees that only one async operation per session runs at a time.
 * Eliminates race conditions between reconcile, event handling, and
 * worker status updates that all modify the same binding.
 */

function normalizeString(value) {
  return String(value ?? "").trim();
}

export class SessionQueue {
  constructor(sessionID, trace) {
    this.sessionID = normalizeString(sessionID);
    this._trace = trace;
    this._queue = [];
    this._processing = false;
  }

  /**
   * Enqueue an async operation. Returns a promise that resolves/rejects
   * with the operation's result.
   */
  run(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    }
    this._processing = false;
  }
}

/**
 * Registry of per-session queues.
 */
export class SessionQueueRegistry {
  constructor(trace) {
    this._trace = trace;
    this._queues = new Map();
  }

  get(sessionID) {
    const key = String(sessionID ?? "").trim();
    return this._queues.get(key);
  }

  ensure(sessionID) {
    const key = String(sessionID ?? "").trim();
    let queue = this._queues.get(key);
    if (!queue) {
      queue = new SessionQueue(key, this._trace);
      this._queues.set(key, queue);
    }
    return queue;
  }

  delete(sessionID) {
    this._queues.delete(String(sessionID ?? "").trim());
  }

  clear() {
    this._queues.clear();
  }
}
