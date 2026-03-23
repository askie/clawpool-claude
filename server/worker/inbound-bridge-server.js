import http from "node:http";
import { randomUUID } from "node:crypto";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseBearerToken(request) {
  const header = normalizeString(request.headers.authorization);
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return normalizeString(header.slice("bearer ".length));
}

async function readJSONBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeJSON(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

export class WorkerInboundBridgeServer {
  constructor({
    host = "127.0.0.1",
    port = 0,
    token = randomUUID(),
    onDeliverEvent = null,
    onDeliverStop = null,
    onDeliverRevoke = null,
  } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.onDeliverEvent = typeof onDeliverEvent === "function" ? onDeliverEvent : null;
    this.onDeliverStop = typeof onDeliverStop === "function" ? onDeliverStop : null;
    this.onDeliverRevoke = typeof onDeliverRevoke === "function" ? onDeliverRevoke : null;
    this.server = null;
    this.address = null;
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
        writeJSON(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
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
    const current = this.server;
    this.server = null;
    this.address = null;
    await new Promise((resolve, reject) => {
      current.close((error) => {
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
      writeJSON(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method !== "POST") {
      writeJSON(response, 405, { error: "method_not_allowed" });
      return;
    }

    const pathname = normalizeString(new URL(request.url, "http://localhost").pathname);
    const payload = await readJSONBody(request);

    if (pathname === "/v1/worker/deliver-event") {
      if (!this.onDeliverEvent) {
        writeJSON(response, 200, { ok: true });
        return;
      }
      const result = await this.onDeliverEvent(payload);
      writeJSON(response, 200, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/deliver-stop") {
      if (!this.onDeliverStop) {
        writeJSON(response, 200, { ok: true });
        return;
      }
      const result = await this.onDeliverStop(payload);
      writeJSON(response, 200, result ?? { ok: true });
      return;
    }

    if (pathname === "/v1/worker/deliver-revoke") {
      if (!this.onDeliverRevoke) {
        writeJSON(response, 200, { ok: true });
        return;
      }
      const result = await this.onDeliverRevoke(payload);
      writeJSON(response, 200, result ?? { ok: true });
      return;
    }

    writeJSON(response, 404, { error: "not_found" });
  }
}
