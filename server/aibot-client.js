import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import WebSocket from "ws";

function normalizeString(value) {
  return String(value ?? "").trim();
}

const verboseDebugEnabled = process.env.CLAWPOOL_E2E_DEBUG === "1";
const verboseDebugLogPath = normalizeString(process.env.CLAWPOOL_E2E_DEBUG_LOG);

function logDebug(message) {
  if (!verboseDebugEnabled) {
    return;
  }
  if (verboseDebugLogPath) {
    appendFileSync(verboseDebugLogPath, `[clawpool-claude:aibot] ${message}\n`);
  }
}

function buildSendNackError(packet) {
  const payload = packet?.payload ?? {};
  const code = Number(payload.code ?? 5001);
  const msg = normalizeString(payload.msg) || packet?.cmd || "unknown error";
  const error = new Error(`aibot ${packet?.cmd ?? "packet"} error ${code}: ${msg}`);
  error.code = code;
  return error;
}

function withOptionalString(target, key, value) {
  const normalized = normalizeString(value);
  if (normalized) {
    target[key] = normalized;
  }
}

export function buildAuthPayload(config) {
  return {
    agent_id: config.agentID,
    api_key: config.apiKey,
    client: "claude-clawpool-claude-channel",
    client_type: "claude",
  };
}

export function buildSessionActivityPayload({
  sessionID,
  kind,
  active,
  ttlMs = 0,
  refMsgID = "",
  refEventID = "",
}) {
  const payload = {
    session_id: normalizeString(sessionID),
    kind: normalizeString(kind),
    active: active === true,
  };
  if (Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0) {
    payload.ttl_ms = Math.floor(Number(ttlMs));
  }
  withOptionalString(payload, "ref_msg_id", refMsgID);
  withOptionalString(payload, "ref_event_id", refEventID);
  return payload;
}

export class AibotClient {
  constructor({ onEventMessage, onEventStop, onEventRevoke, onStatus } = {}) {
    this.onEventMessage = onEventMessage;
    this.onEventStop = onEventStop;
    this.onEventRevoke = onEventRevoke;
    this.onStatus = onStatus;

    this.desired = false;
    this.config = null;
    this.ws = null;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.seq = 1;
    this.suppressReconnectOnce = false;
    this.pingTimer = null;
    this.reconnectDelay = 2000;
    this.reconnectDelayMax = 30000;
    this.status = {
      configured: false,
      connecting: false,
      connected: false,
      authed: false,
      last_error: "",
    };
  }

  getStatus() {
    return {
      ...this.status,
    };
  }

  async start(config) {
    this.desired = true;
    this.config = config;
    this.status.configured = Boolean(config);
    this.emitStatus();
    await this.restart();
  }

  async reconfigure(config) {
    this.config = config;
    this.status.configured = Boolean(config);
    this.emitStatus();
    await this.restart();
  }

  async stop() {
    this.desired = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.closeCurrentSocket({ suppressReconnect: true });
  }

  ensureReady() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.status.authed) {
      throw new Error("clawpool-claude websocket is not ready");
    }
  }

  ensureSocketOpen() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("clawpool-claude websocket is not open");
    }
  }

  async restart() {
    this.reconnectDelay = 2000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.closeCurrentSocket({ suppressReconnect: true });
    if (!this.desired || !this.config) {
      this.setStatus({
        connecting: false,
        connected: false,
        authed: false,
      });
      return;
    }
    this.scheduleReconnect(0);
  }

  scheduleReconnect(delayMs) {
    if (!this.desired || !this.config || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectOnce();
      } catch (error) {
        this.setStatus({
          connecting: false,
          connected: false,
          authed: false,
          last_error: String(error),
        });
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectDelayMax);
        const jitter = Math.floor(this.reconnectDelay * 0.2 * Math.random());
        this.scheduleReconnect(this.reconnectDelay + jitter);
      }
    }, delayMs);
  }

  async connectOnce() {
    if (!this.config) {
      return;
    }
    this.setStatus({
      connecting: true,
      connected: false,
      authed: false,
      last_error: "",
    });

    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.wsURL);
      const handleError = (error) => {
        socket.removeAllListeners();
        reject(error);
      };
      const handleOpen = () => {
        socket.off("error", handleError);
        resolve(socket);
      };
      socket.once("error", handleError);
      socket.once("open", handleOpen);
    });

    this.ws = ws;
    this.bindSocket(ws);
    logDebug(`socket open url=${this.config.wsURL}`);
    this.setStatus({
      connecting: false,
      connected: true,
      authed: false,
      last_error: "",
    });

    const auth = await this.request("auth", buildAuthPayload(this.config), {
      expected: ["auth_ack"],
      timeoutMs: 10000,
    });
    logDebug(`auth response code=${Number(auth?.payload?.code ?? 0)} msg=${normalizeString(auth?.payload?.msg)}`);
    const code = Number(auth?.payload?.code ?? 0);
    if (code !== 0) {
      throw new Error(normalizeString(auth?.payload?.msg) || `auth failed code=${code}`);
    }
    this.setStatus({
      connecting: false,
      connected: true,
      authed: true,
      last_error: "",
    });
    this.reconnectDelay = 2000;
    this.startPingHeartbeat();
  }

  bindSocket(socket) {
    socket.on("message", async (data) => {
      try {
        await this.handleMessage(data.toString("utf8"));
      } catch (error) {
        this.setStatus({
          last_error: String(error),
        });
      }
    });

    socket.on("close", () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.rejectPending(new Error("clawpool-claude websocket closed"));
      this.setStatus({
        connecting: false,
        connected: false,
        authed: false,
      });
      if (this.suppressReconnectOnce) {
        this.suppressReconnectOnce = false;
        return;
      }
      this.scheduleReconnect(this.reconnectDelay);
    });

    socket.on("error", (error) => {
      this.setStatus({
        last_error: String(error),
      });
    });
  }

  async closeCurrentSocket({ suppressReconnect = false } = {}) {
    this.stopPingHeartbeat();
    const socket = this.ws;
    if (!socket) {
      return;
    }
    this.ws = null;
    this.suppressReconnectOnce = suppressReconnect;
    this.rejectPending(new Error("clawpool-claude websocket restarted"));
    await new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", resolve);
      socket.close();
      setTimeout(resolve, 500);
    });
    this.setStatus({
      connecting: false,
      connected: false,
      authed: false,
    });
  }

  startPingHeartbeat() {
    this.stopPingHeartbeat();
    this.pingTimer = setInterval(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.status.authed) {
        return;
      }
      try {
        await this.request("ping", { ts: Date.now() }, { expected: ["pong"], timeoutMs: 5000 });
      } catch {
        await this.closeCurrentSocket({ suppressReconnect: false });
      }
    }, 30000);
  }

  stopPingHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async handleMessage(text) {
    const packet = JSON.parse(text);
    const cmd = normalizeString(packet.cmd);
    const seq = Number(packet.seq ?? 0);
    logDebug(`recv cmd=${cmd} seq=${seq}`);

    if (cmd === "ping") {
      this.sendPacket("pong", { ts: Date.now() }, seq > 0 ? seq : undefined);
      return;
    }

    if (seq > 0 && this.pending.has(seq)) {
      const pending = this.pending.get(seq);
      clearTimeout(pending.timer);
      this.pending.delete(seq);
      pending.resolve(packet);
      return;
    }

    if (cmd === "event_msg" && this.onEventMessage) {
      await this.onEventMessage(packet.payload ?? {});
      return;
    }
    if (cmd === "event_stop" && this.onEventStop) {
      await this.onEventStop(packet.payload ?? {});
      return;
    }
    if (cmd === "event_revoke" && this.onEventRevoke) {
      await this.onEventRevoke(packet.payload ?? {});
    }
  }

  setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
    };
    logDebug(
      `status configured=${this.status.configured} connecting=${this.status.connecting} connected=${this.status.connected} authed=${this.status.authed} last_error=${this.status.last_error || ""}`,
    );
    this.emitStatus();
  }

  emitStatus() {
    if (typeof this.onStatus === "function") {
      this.onStatus(this.getStatus());
    }
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  sendPacket(cmd, payload, seq) {
    this.ensureSocketOpen();
    const packet = {
      cmd,
      seq: seq ?? this.nextSeq(),
      payload,
    };
    logDebug(`send cmd=${cmd} seq=${packet.seq}`);
    this.ws.send(JSON.stringify(packet));
    return packet.seq;
  }

  request(cmd, payload, { expected, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      this.ensureSocketOpen();
      const seq = this.nextSeq();
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`aibot request timeout: ${cmd}`));
      }, timeoutMs);
      this.pending.set(seq, {
        expected,
        resolve: (packet) => {
          if (Array.isArray(expected) && expected.length > 0 && !expected.includes(packet.cmd)) {
            reject(new Error(`unexpected aibot response ${packet.cmd} for ${cmd}`));
            return;
          }
          resolve(packet);
        },
        reject,
        timer,
      });
      const packet = {
        cmd,
        seq,
        payload,
      };
      logDebug(`request cmd=${cmd} seq=${seq}`);
      try {
        this.ws.send(JSON.stringify(packet));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error);
      }
    });
  }

  ackEvent(eventID, { sessionID, msgID, receivedAt = Date.now() } = {}) {
    const payload = {
      event_id: normalizeString(eventID),
      received_at: Math.floor(receivedAt),
    };
    withOptionalString(payload, "session_id", sessionID);
    withOptionalString(payload, "msg_id", msgID);
    this.sendPacket("event_ack", payload);
  }

  sendEventResult({ event_id, status, code = "", msg = "", updated_at = Date.now() }) {
    const payload = {
      event_id: normalizeString(event_id),
      status: normalizeString(status),
      updated_at: Math.floor(updated_at),
    };
    withOptionalString(payload, "code", code);
    withOptionalString(payload, "msg", msg);
    this.sendPacket("event_result", payload);
  }

  sendEventStopAck({ event_id, stop_id = "", accepted, updated_at = Date.now() }) {
    const payload = {
      event_id: normalizeString(event_id),
      accepted: accepted === true,
      updated_at: Math.floor(updated_at),
    };
    withOptionalString(payload, "stop_id", stop_id);
    this.sendPacket("event_stop_ack", payload);
  }

  sendEventStopResult({
    event_id,
    stop_id = "",
    status,
    code = "",
    msg = "",
    updated_at = Date.now(),
  }) {
    const payload = {
      event_id: normalizeString(event_id),
      status: normalizeString(status),
      updated_at: Math.floor(updated_at),
    };
    withOptionalString(payload, "stop_id", stop_id);
    withOptionalString(payload, "code", code);
    withOptionalString(payload, "msg", msg);
    this.sendPacket("event_stop_result", payload);
  }

  setSessionComposing({
    sessionID,
    kind = "composing",
    active,
    ttlMs = 0,
    refMsgID = "",
    refEventID = "",
  }) {
    this.sendPacket(
      "session_activity_set",
      buildSessionActivityPayload({
        sessionID,
        kind,
        active,
        ttlMs,
        refMsgID,
        refEventID,
      }),
    );
  }

  async sendText({
    eventID = "",
    sessionID,
    text,
    quotedMessageID = "",
    clientMsgID = randomUUID(),
    extra = {},
  }) {
    const payload = {
      session_id: normalizeString(sessionID),
      client_msg_id: normalizeString(clientMsgID),
      msg_type: 1,
      content: String(text ?? ""),
      extra,
    };
    withOptionalString(payload, "event_id", eventID);
    withOptionalString(payload, "quoted_message_id", quotedMessageID);
    const packet = await this.request("send_msg", payload, {
      expected: ["send_ack", "send_nack", "error"],
      timeoutMs: 20000,
    });
    if (packet.cmd !== "send_ack") {
      throw buildSendNackError(packet);
    }
    return packet.payload ?? {};
  }

  async sendMedia({
    eventID = "",
    sessionID,
    mediaURL,
    caption = "",
    quotedMessageID = "",
    clientMsgID = randomUUID(),
    extra = {},
  }) {
    const payload = {
      session_id: normalizeString(sessionID),
      client_msg_id: normalizeString(clientMsgID),
      msg_type: 2,
      content: normalizeString(caption) || "[attachment]",
      media_url: normalizeString(mediaURL),
      extra,
    };
    withOptionalString(payload, "event_id", eventID);
    withOptionalString(payload, "quoted_message_id", quotedMessageID);
    const packet = await this.request("send_msg", payload, {
      expected: ["send_ack", "send_nack", "error"],
      timeoutMs: 20000,
    });
    if (packet.cmd !== "send_ack") {
      throw buildSendNackError(packet);
    }
    return packet.payload ?? {};
  }

  async deleteMessage(sessionID, messageID, { timeoutMs = 20000 } = {}) {
    const normalizedSessionID = normalizeString(sessionID);
    const normalizedMessageID = normalizeString(messageID);
    if (!normalizedSessionID) {
      throw new Error("deleteMessage requires sessionID");
    }
    if (!/^\d+$/.test(normalizedMessageID)) {
      throw new Error("deleteMessage requires numeric messageID");
    }

    const packet = await this.request("delete_msg", {
      session_id: normalizedSessionID,
      msg_id: normalizedMessageID,
    }, {
      expected: ["send_ack", "send_nack", "error"],
      timeoutMs,
    });
    if (packet.cmd !== "send_ack") {
      throw buildSendNackError(packet);
    }
    return packet.payload ?? {};
  }
}
