function normalizeString(value) {
  return String(value ?? "").trim();
}

function buildHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${normalizeString(token)}`,
  };
}

async function parseJSONResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid bridge response: ${text}`);
  }
}

export class WorkerBridgeClient {
  constructor({ bridgeURL, token, fetchImpl = globalThis.fetch } = {}) {
    this.bridgeURL = normalizeString(bridgeURL).replace(/\/+$/u, "");
    this.token = normalizeString(token);
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.bridgeURL && this.token && typeof this.fetchImpl === "function");
  }

  async post(pathname, payload) {
    if (!this.isConfigured()) {
      throw new Error("worker bridge is not configured");
    }

    const response = await this.fetchImpl(`${this.bridgeURL}${pathname}`, {
      method: "POST",
      headers: buildHeaders(this.token),
      body: JSON.stringify(payload),
    });
    const json = await parseJSONResponse(response);
    if (!response.ok) {
      throw new Error(normalizeString(json.error) || `bridge request failed ${response.status}`);
    }
    return json;
  }

  async registerWorker(payload) {
    return this.post("/v1/worker/register", payload);
  }

  async sendStatusUpdate(payload) {
    return this.post("/v1/worker/status", payload);
  }

  async sendText(payload) {
    return this.post("/v1/worker/send-text", payload);
  }

  async sendMedia(payload) {
    return this.post("/v1/worker/send-media", payload);
  }

  async deleteMessage(payload) {
    return this.post("/v1/worker/delete-message", payload);
  }

  async ackEvent(payload) {
    return this.post("/v1/worker/ack-event", payload);
  }

  async sendEventResult(payload) {
    return this.post("/v1/worker/event-result", payload);
  }

  async sendEventStopAck(payload) {
    return this.post("/v1/worker/event-stop-ack", payload);
  }

  async sendEventStopResult(payload) {
    return this.post("/v1/worker/event-stop-result", payload);
  }

  async setSessionComposing(payload) {
    return this.post("/v1/worker/session-composing", payload);
  }
}
