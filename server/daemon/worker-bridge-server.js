import http from "node:http";
import { randomUUID } from "node:crypto";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function unauthorized(response) {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

function notFound(response) {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

function methodNotAllowed(response) {
  response.writeHead(405, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

function badRequest(response, error) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: normalizeString(error) || "bad_request" }));
}

function ok(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJSONBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function parseBearerToken(request) {
  const header = normalizeString(request.headers.authorization);
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return normalizeString(header.slice("bearer ".length));
}

export class WorkerBridgeServer {
  constructor({
    host = "127.0.0.1",
    port = 0,
    token = randomUUID(),
    logger = null,
    onRegisterWorker = null,
    onStatusUpdate = null,
    onSendText = null,
    onSendMedia = null,
    onDeleteMessage = null,
    onAckEvent = null,
    onSendEventResult = null,
    onSendEventStopAck = null,
    onSendEventStopResult = null,
    onSetSessionComposing = null,
  } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.logger = logger;
    this.onRegisterWorker = typeof onRegisterWorker === "function" ? onRegisterWorker : null;
    this.onStatusUpdate = typeof onStatusUpdate === "function" ? onStatusUpdate : null;
    this.onSendText = typeof onSendText === "function" ? onSendText : null;
    this.onSendMedia = typeof onSendMedia === "function" ? onSendMedia : null;
    this.onDeleteMessage = typeof onDeleteMessage === "function" ? onDeleteMessage : null;
    this.onAckEvent = typeof onAckEvent === "function" ? onAckEvent : null;
    this.onSendEventResult = typeof onSendEventResult === "function" ? onSendEventResult : null;
    this.onSendEventStopAck = typeof onSendEventStopAck === "function" ? onSendEventStopAck : null;
    this.onSendEventStopResult = typeof onSendEventStopResult === "function" ? onSendEventStopResult : null;
    this.onSetSessionComposing = typeof onSetSessionComposing === "function" ? onSetSessionComposing : null;
    this.server = null;
    this.address = null;
  }

  trace(fields, level = "info") {
    this.logger?.trace?.({
      component: "daemon.bridge",
      ...fields,
    }, { level });
  }

  getURL() {
    if (!this.address) {
      return "";
    }
    return `http://${this.address.address}:${this.address.port}`;
  }

  async start() {
    if (this.server) {
      return;
    }
    this.server = http.createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        badRequest(response, error instanceof Error ? error.message : String(error));
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.address = this.server.address();
  }

  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.address = null;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async handleRequest(request, response) {
    if (parseBearerToken(request) !== this.token) {
      unauthorized(response);
      return;
    }

    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }

    const pathname = normalizeString(new URL(request.url, "http://localhost").pathname);
    const payload = await readJSONBody(request);

    if (pathname === "/v1/worker/register") {
      this.trace({
        stage: "worker_register_received",
        aibot_session_id: payload?.aibot_session_id,
        worker_id: payload?.worker_id,
      });
      const result = this.onRegisterWorker
        ? await this.onRegisterWorker(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/status") {
      this.trace({
        stage: "worker_status_received",
        aibot_session_id: payload?.aibot_session_id,
        worker_id: payload?.worker_id,
        status: payload?.status,
      });
      const result = this.onStatusUpdate
        ? await this.onStatusUpdate(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/send-text") {
      this.trace({
        stage: "worker_send_text_received",
        event_id: payload?.event_id,
        session_id: payload?.session_id,
        client_msg_id: payload?.client_msg_id,
      });
      const result = this.onSendText
        ? await this.onSendText(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/send-media") {
      this.trace({
        stage: "worker_send_media_received",
        event_id: payload?.event_id,
        session_id: payload?.session_id,
        client_msg_id: payload?.client_msg_id,
      });
      const result = this.onSendMedia
        ? await this.onSendMedia(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/delete-message") {
      this.trace({
        stage: "worker_delete_message_received",
        session_id: payload?.session_id,
        msg_id: payload?.msg_id,
      });
      const result = this.onDeleteMessage
        ? await this.onDeleteMessage(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/ack-event") {
      this.trace({
        stage: "worker_ack_received",
        event_id: payload?.event_id,
        session_id: payload?.session_id,
        msg_id: payload?.msg_id,
      });
      const result = this.onAckEvent
        ? await this.onAckEvent(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/event-result") {
      this.trace({
        stage: "worker_event_result_received",
        event_id: payload?.event_id,
        status: payload?.status,
        code: payload?.code,
      });
      const result = this.onSendEventResult
        ? await this.onSendEventResult(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/event-stop-ack") {
      this.trace({
        stage: "worker_event_stop_ack_received",
        event_id: payload?.event_id,
        stop_id: payload?.stop_id,
        accepted: payload?.accepted,
      });
      const result = this.onSendEventStopAck
        ? await this.onSendEventStopAck(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/event-stop-result") {
      this.trace({
        stage: "worker_event_stop_result_received",
        event_id: payload?.event_id,
        stop_id: payload?.stop_id,
        status: payload?.status,
        code: payload?.code,
      });
      const result = this.onSendEventStopResult
        ? await this.onSendEventStopResult(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/session-composing") {
      this.trace({
        stage: "worker_session_composing_received",
        session_id: payload?.session_id,
        ref_event_id: payload?.ref_event_id,
        active: payload?.active,
      }, "debug");
      const result = this.onSetSessionComposing
        ? await this.onSetSessionComposing(payload)
        : { ok: true };
      ok(response, result ?? { ok: true });
      return;
    }

    notFound(response);
  }
}
