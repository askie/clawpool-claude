function normalizeString(value) {
  return String(value ?? "").trim();
}

async function parseJSONResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

export class WorkerControlClient {
  constructor({ controlURL, token, fetchImpl = globalThis.fetch } = {}) {
    this.controlURL = normalizeString(controlURL).replace(/\/+$/u, "");
    this.token = normalizeString(token);
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.controlURL && this.token && typeof this.fetchImpl === "function");
  }

  async deliverEvent(rawPayload) {
    if (!this.isConfigured()) {
      throw new Error("worker control is not configured");
    }
    const response = await this.fetchImpl(`${this.controlURL}/v1/worker/deliver-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ payload: rawPayload }),
    });
    const json = await parseJSONResponse(response);
    if (!response.ok) {
      throw new Error(normalizeString(json.error) || `worker control failed ${response.status}`);
    }
    return json;
  }

  async deliverStop(rawPayload) {
    if (!this.isConfigured()) {
      throw new Error("worker control is not configured");
    }
    const response = await this.fetchImpl(`${this.controlURL}/v1/worker/deliver-stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ payload: rawPayload }),
    });
    const json = await parseJSONResponse(response);
    if (!response.ok) {
      throw new Error(normalizeString(json.error) || `worker control failed ${response.status}`);
    }
    return json;
  }

  async deliverRevoke(rawPayload) {
    if (!this.isConfigured()) {
      throw new Error("worker control is not configured");
    }
    const response = await this.fetchImpl(`${this.controlURL}/v1/worker/deliver-revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ payload: rawPayload }),
    });
    const json = await parseJSONResponse(response);
    if (!response.ok) {
      throw new Error(normalizeString(json.error) || `worker control failed ${response.status}`);
    }
    return json;
  }
}
