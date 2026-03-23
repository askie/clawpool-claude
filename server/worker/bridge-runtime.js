import { createSessionActivityDispatcher } from "../session-activity-dispatcher.js";
import { WorkerBridgeClient } from "./worker-bridge-client.js";
import { WorkerInboundBridgeServer } from "./inbound-bridge-server.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

export class DaemonBridgeRuntime {
  constructor({
    env = process.env,
    logger,
    onDeliverEvent = null,
    onDeliverStop = null,
    onDeliverRevoke = null,
  } = {}) {
    this.env = env;
    this.logger = logger;
    this.daemonBridgeURL = normalizeOptionalString(env.CLAWPOOL_DAEMON_BRIDGE_URL);
    this.daemonBridgeToken = normalizeOptionalString(env.CLAWPOOL_DAEMON_BRIDGE_TOKEN);
    this.daemonModeEnabled = (
      env.CLAWPOOL_DAEMON_MODE === "1"
      && this.daemonBridgeURL
      && this.daemonBridgeToken
    );
    this.workerBridgeClient = new WorkerBridgeClient({
      bridgeURL: this.daemonBridgeURL,
      token: this.daemonBridgeToken,
    });
    this.workerControlServer = this.daemonModeEnabled
      ? new WorkerInboundBridgeServer({
          onDeliverEvent: async (input) => {
            this.logger?.trace?.({
              component: "worker.bridge",
              stage: "deliver_event_received",
              event_id: input?.payload?.event_id,
              session_id: input?.payload?.session_id,
              msg_id: input?.payload?.msg_id,
              sender_id: input?.payload?.sender_id,
            });
            if (typeof onDeliverEvent === "function") {
              await onDeliverEvent(input?.payload ?? {});
            }
            return { ok: true };
          },
          onDeliverStop: async (input) => {
            this.logger?.trace?.({
              component: "worker.bridge",
              stage: "deliver_stop_received",
              event_id: input?.payload?.event_id,
              session_id: input?.payload?.session_id,
              stop_id: input?.payload?.stop_id,
            });
            if (typeof onDeliverStop === "function") {
              await onDeliverStop(input?.payload ?? {});
            }
            return { ok: true };
          },
          onDeliverRevoke: async (input) => {
            this.logger?.trace?.({
              component: "worker.bridge",
              stage: "deliver_revoke_received",
              event_id: input?.payload?.event_id,
              session_id: input?.payload?.session_id,
              msg_id: input?.payload?.msg_id,
            });
            if (typeof onDeliverRevoke === "function") {
              await onDeliverRevoke(input?.payload ?? {});
            }
            return { ok: true };
          },
        })
      : null;
    this.workerReadyReported = false;
    this.workerReadyPromise = null;
    this.latestClientStatus = {
      configured: this.daemonModeEnabled,
      connecting: false,
      connected: this.daemonModeEnabled,
      authed: this.daemonModeEnabled,
      last_error: this.daemonModeEnabled
        ? ""
        : "worker must be started by clawpool-claude daemon",
    };
    this.dispatchSessionActivity = createSessionActivityDispatcher(async ({
      sessionID,
      kind = "composing",
      active,
      ttlMs = 0,
      refMsgID = "",
      refEventID = "",
    }) => {
      this.requireDaemonBridge();
      return this.workerBridgeClient.setSessionComposing({
        session_id: sessionID,
        kind,
        active,
        ttl_ms: ttlMs,
        ref_msg_id: refMsgID,
        ref_event_id: refEventID,
      });
    });
  }

  isDaemonBridgeActive() {
    return this.daemonModeEnabled && this.workerBridgeClient.isConfigured();
  }

  requireDaemonBridge() {
    if (!this.isDaemonBridgeActive()) {
      throw new Error("clawpool-claude worker must be started by clawpool-claude daemon");
    }
  }

  getConnectionStatus() {
    return {
      ...this.latestClientStatus,
    };
  }

  buildStatusHints() {
    const hints = [
      "This worker is managed by clawpool-claude daemon.",
      "Use the daemon CLI to change ws_url, agent_id, or api_key.",
      "Send open <目录> from ClawPool to let daemon start or recover a Claude session.",
    ];

    if (!this.isDaemonBridgeActive()) {
      hints.unshift("This worker must be started by clawpool-claude daemon.");
    }

    return hints;
  }

  getWorkerControlURL() {
    return this.workerControlServer?.getURL?.() ?? "";
  }

  getWorkerControlToken() {
    return this.workerControlServer?.token ?? "";
  }

  async startControlServer() {
    if (this.workerControlServer) {
      await this.workerControlServer.start();
    }
  }

  async stopControlServer() {
    if (this.workerControlServer) {
      await this.workerControlServer.stop();
    }
  }

  async sendText(payload) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "send_text_requested",
      event_id: payload.eventID,
      session_id: payload.sessionID,
      client_msg_id: payload.clientMsgID,
    });
    return this.workerBridgeClient.sendText({
      event_id: payload.eventID,
      session_id: payload.sessionID,
      text: payload.text,
      quoted_message_id: payload.quotedMessageID,
      client_msg_id: payload.clientMsgID,
      extra: payload.extra,
    });
  }

  async sendMedia(payload) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "send_media_requested",
      event_id: payload.eventID,
      session_id: payload.sessionID,
      client_msg_id: payload.clientMsgID,
    });
    return this.workerBridgeClient.sendMedia({
      event_id: payload.eventID,
      session_id: payload.sessionID,
      media_url: payload.mediaURL,
      caption: payload.caption,
      quoted_message_id: payload.quotedMessageID,
      client_msg_id: payload.clientMsgID,
      extra: payload.extra,
    });
  }

  async deleteMessage(sessionID, messageID) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "delete_message_requested",
      session_id: sessionID,
      msg_id: messageID,
    });
    return this.workerBridgeClient.deleteMessage({
      session_id: sessionID,
      msg_id: messageID,
    });
  }

  async ackEvent(eventID, { sessionID, msgID, receivedAt = Date.now() } = {}) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "ack_event_requested",
      event_id: eventID,
      session_id: sessionID,
      msg_id: msgID,
    });
    return this.workerBridgeClient.ackEvent({
      event_id: eventID,
      session_id: sessionID,
      msg_id: msgID,
      received_at: Math.floor(receivedAt),
    });
  }

  async sendEventResult(payload) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "event_result_requested",
      event_id: payload?.event_id,
      status: payload?.status,
      code: payload?.code,
    });
    return this.workerBridgeClient.sendEventResult(payload);
  }

  async sendEventStopAck(payload) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "event_stop_ack_requested",
      event_id: payload?.event_id,
      stop_id: payload?.stop_id,
      accepted: payload?.accepted,
    });
    return this.workerBridgeClient.sendEventStopAck(payload);
  }

  async sendEventStopResult(payload) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "event_stop_result_requested",
      event_id: payload?.event_id,
      stop_id: payload?.stop_id,
      status: payload?.status,
      code: payload?.code,
    });
    return this.workerBridgeClient.sendEventStopResult(payload);
  }

  async setSessionComposing({
    sessionID,
    kind = "composing",
    active,
    ttlMs = 0,
    refMsgID = "",
    refEventID = "",
  }) {
    return this.dispatchSessionActivity({
      sessionID,
      kind,
      active,
      ttlMs,
      refMsgID,
      refEventID,
    });
  }

  async registerWorker({ cwd, pluginDataDir, pid = process.pid } = {}) {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "worker_register_requested",
      aibot_session_id: this.env.CLAWPOOL_AIBOT_SESSION_ID,
      worker_id: this.env.CLAWPOOL_WORKER_ID,
      pid,
    });
    return this.workerBridgeClient.registerWorker({
      worker_id: normalizeOptionalString(this.env.CLAWPOOL_WORKER_ID),
      aibot_session_id: normalizeOptionalString(this.env.CLAWPOOL_AIBOT_SESSION_ID),
      claude_session_id: normalizeOptionalString(this.env.CLAWPOOL_CLAUDE_SESSION_ID),
      cwd,
      plugin_data_dir: normalizeOptionalString(pluginDataDir),
      worker_control_url: this.getWorkerControlURL(),
      worker_control_token: this.getWorkerControlToken(),
      pid,
    });
  }

  async sendConnectedStatus() {
    this.requireDaemonBridge();
    this.logger?.trace?.({
      component: "worker.bridge",
      stage: "worker_status_requested",
      aibot_session_id: this.env.CLAWPOOL_AIBOT_SESSION_ID,
      worker_id: this.env.CLAWPOOL_WORKER_ID,
      status: "connected",
    });
    return this.workerBridgeClient.sendStatusUpdate({
      worker_id: normalizeOptionalString(this.env.CLAWPOOL_WORKER_ID),
      aibot_session_id: normalizeOptionalString(this.env.CLAWPOOL_AIBOT_SESSION_ID),
      claude_session_id: normalizeOptionalString(this.env.CLAWPOOL_CLAUDE_SESSION_ID),
      worker_control_url: this.getWorkerControlURL(),
      worker_control_token: this.getWorkerControlToken(),
      status: "connected",
    });
  }

  async reportWorkerReadyOnce() {
    if (!this.daemonModeEnabled || !this.workerBridgeClient.isConfigured() || this.workerReadyReported) {
      return;
    }
    if (this.workerReadyPromise) {
      await this.workerReadyPromise;
      return;
    }

    this.workerReadyPromise = (async () => {
      this.logger?.trace?.({
        component: "worker.bridge",
        stage: "worker_status_requested",
        aibot_session_id: this.env.CLAWPOOL_AIBOT_SESSION_ID,
        worker_id: this.env.CLAWPOOL_WORKER_ID,
        status: "ready",
      });
      await this.workerBridgeClient.sendStatusUpdate({
        worker_id: normalizeOptionalString(this.env.CLAWPOOL_WORKER_ID),
        aibot_session_id: normalizeOptionalString(this.env.CLAWPOOL_AIBOT_SESSION_ID),
        claude_session_id: normalizeOptionalString(this.env.CLAWPOOL_CLAUDE_SESSION_ID),
        worker_control_url: this.getWorkerControlURL(),
        worker_control_token: this.getWorkerControlToken(),
        status: "ready",
      });
      this.workerReadyReported = true;
      this.logger?.info?.("worker ready after MCP tools handshake");
    })();

    try {
      await this.workerReadyPromise;
    } finally {
      this.workerReadyPromise = null;
    }
  }

  async shutdown() {
    if (!this.daemonModeEnabled || !this.workerBridgeClient.isConfigured()) {
      return;
    }

    try {
      await this.stopControlServer();
      await this.workerBridgeClient.sendStatusUpdate({
        worker_id: normalizeOptionalString(this.env.CLAWPOOL_WORKER_ID),
        aibot_session_id: normalizeOptionalString(this.env.CLAWPOOL_AIBOT_SESSION_ID),
        claude_session_id: normalizeOptionalString(this.env.CLAWPOOL_CLAUDE_SESSION_ID),
        status: "stopped",
      });
    } catch (error) {
      this.logger?.error?.(`worker bridge stop update failed: ${String(error)}`);
    }
  }
}
