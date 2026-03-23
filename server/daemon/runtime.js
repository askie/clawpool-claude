import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { parseControlCommand } from "./control-command.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { resolveWorkerPluginDataDir } from "./daemon-paths.js";
import { WorkerControlClient } from "./worker-control-client.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

async function ensureDirectoryExists(directoryPath) {
  const info = await stat(directoryPath);
  if (!info.isDirectory()) {
    throw new Error("指定路径不是目录。");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBindingSummary(binding) {
  if (!binding) {
    return "当前会话还没有绑定目录。";
  }
  return [
    `Aibot 会话: ${binding.aibot_session_id}`,
    `Claude 会话: ${binding.claude_session_id}`,
    `目录: ${binding.cwd}`,
    `Worker 状态: ${binding.worker_status}`,
  ].join("\n");
}

function buildPendingEventRecord(rawPayload) {
  return {
    eventID: normalizeString(rawPayload?.event_id),
    sessionID: normalizeString(rawPayload?.session_id),
    msgID: normalizeString(rawPayload?.msg_id),
    rawPayload: { ...(rawPayload ?? {}) },
    delivery_attempts: 0,
    delivery_state: "pending",
    last_worker_id: "",
  };
}

function buildInterruptedEventNotice() {
  return "Claude 刚刚中断了，这条消息没有处理完成。请再发一次。";
}

export class DaemonRuntime {
  constructor({
    env = process.env,
    bindingRegistry,
    workerProcessManager,
    aibotClient,
    bridgeServer,
    workerControlClientFactory = null,
  }) {
    this.env = env;
    this.bindingRegistry = bindingRegistry;
    this.workerProcessManager = workerProcessManager;
    this.aibotClient = aibotClient;
    this.bridgeServer = bridgeServer;
    this.workerControlClientFactory = typeof workerControlClientFactory === "function"
        ? workerControlClientFactory
        : (binding) => new WorkerControlClient({
          controlURL: binding.worker_control_url,
          token: binding.worker_control_token,
        });
    this.eventSessionIndex = new Map();
    this.pendingEvents = new Map();
  }

  async reply(event, text, extra = {}) {
    return this.aibotClient.sendText({
      eventID: event.event_id,
      sessionID: event.session_id,
      text,
      quotedMessageID: event.msg_id,
      extra,
    });
  }

  ack(event) {
    this.aibotClient.ackEvent(event.event_id, {
      sessionID: event.session_id,
      msgID: event.msg_id,
      receivedAt: Date.now(),
    });
  }

  async ensureWorker(binding) {
    if (binding.worker_status === "ready" && binding.worker_control_url && binding.worker_control_token) {
      return {
        worker_id: binding.worker_id,
        status: "ready",
      };
    }

    if (binding.worker_status === "connected" && binding.worker_control_url && binding.worker_control_token) {
      const current = await this.waitForWorkerBridgeState(binding.aibot_session_id);
      if (
        current &&
        current.worker_status === "ready" &&
        current.worker_control_url &&
        current.worker_control_token
      ) {
        return {
          worker_id: current.worker_id,
          status: "ready",
        };
      }
      return {
        worker_id: binding.worker_id,
        status: "connected",
      };
    }

    if (binding.worker_status === "starting") {
      const current = await this.waitForWorkerBridgeState(binding.aibot_session_id);
      if (
        current &&
        current.worker_status === "ready" &&
        current.worker_control_url &&
        current.worker_control_token
      ) {
        return {
          worker_id: current.worker_id,
          status: current.worker_status,
        };
      }
    }

    await this.bindingRegistry.markWorkerStarting(binding.aibot_session_id, {
      workerID: binding.worker_id || randomUUID(),
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    return this.workerProcessManager.spawnWorker({
      aibotSessionID: binding.aibot_session_id,
      cwd: binding.cwd,
      pluginDataDir: binding.plugin_data_dir,
      claudeSessionID: binding.claude_session_id,
      workerID: binding.worker_id || randomUUID(),
      bridgeURL: this.bridgeServer.getURL(),
      bridgeToken: this.bridgeServer.token,
      resumeSession: true,
    });
  }

  async waitForReadyBinding(aibotSessionID, { timeoutMs = 15000, intervalMs = 100 } = {}) {
    const deadlineAt = Date.now() + timeoutMs;
    while (Date.now() < deadlineAt) {
      const current = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (current && current.worker_status === "ready" && current.worker_control_url && current.worker_control_token) {
        return current;
      }
      await sleep(intervalMs);
    }
    return this.bindingRegistry.getByAibotSessionID(aibotSessionID);
  }

  async waitForWorkerBridgeState(
    aibotSessionID,
    { timeoutMs = 1500, intervalMs = 100 } = {},
  ) {
    const deadlineAt = Date.now() + timeoutMs;
    while (Date.now() < deadlineAt) {
      const current = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (!current) {
        return null;
      }
      if (
        current.worker_status === "ready" &&
        current.worker_control_url &&
        current.worker_control_token
      ) {
        return current;
      }
      if (current.worker_status === "stopped" || current.worker_status === "failed") {
        return current;
      }
      await sleep(intervalMs);
    }
    return this.bindingRegistry.getByAibotSessionID(aibotSessionID);
  }

  async deliverEventToWorker(binding, rawPayload) {
    const client = this.workerControlClientFactory(binding);
    if (!client?.isConfigured?.()) {
      throw new Error("worker control client is not configured");
    }
    return client.deliverEvent(rawPayload);
  }

  async deliverStopToWorker(binding, rawPayload) {
    const client = this.workerControlClientFactory(binding);
    if (!client?.isConfigured?.()) {
      throw new Error("worker control client is not configured");
    }
    return client.deliverStop(rawPayload);
  }

  async deliverRevokeToWorker(binding, rawPayload) {
    const client = this.workerControlClientFactory(binding);
    if (!client?.isConfigured?.()) {
      throw new Error("worker control client is not configured");
    }
    return client.deliverRevoke(rawPayload);
  }

  trackPendingEvent(rawPayload) {
    const record = buildPendingEventRecord(rawPayload);
    if (!record.eventID || !record.sessionID) {
      return null;
    }
    const existing = this.pendingEvents.get(record.eventID);
    if (existing) {
      return existing;
    }
    this.pendingEvents.set(record.eventID, record);
    return record;
  }

  markPendingEventDelivered(eventID, binding) {
    const record = this.pendingEvents.get(normalizeString(eventID));
    if (!record) {
      return null;
    }
    record.delivery_attempts += 1;
    record.delivery_state = "delivered";
    record.last_worker_id = normalizeString(binding?.worker_id);
    return record;
  }

  markPendingEventInterrupted(eventID) {
    const record = this.pendingEvents.get(normalizeString(eventID));
    if (!record) {
      return null;
    }
    record.delivery_state = "interrupted";
    return record;
  }

  clearPendingEvent(eventID) {
    this.pendingEvents.delete(normalizeString(eventID));
  }

  listPendingEventsForSession(sessionID) {
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return [];
    }
    return Array.from(this.pendingEvents.values())
      .filter((record) => record.sessionID === normalizedSessionID);
  }

  async flushPendingSessionEvents(sessionID, binding) {
    const normalizedSessionID = normalizeString(sessionID);
    if (
      !normalizedSessionID ||
      !binding?.worker_control_url ||
      !binding?.worker_control_token
    ) {
      return;
    }

    for (const record of this.listPendingEventsForSession(normalizedSessionID)) {
      if (record.delivery_state !== "pending") {
        continue;
      }
      try {
        await this.deliverEventToWorker(binding, record.rawPayload);
        this.markPendingEventDelivered(record.eventID, binding);
      } catch {
        return;
      }
    }
  }

  async failPendingEvent(record) {
    if (!record?.eventID || !record?.sessionID) {
      return;
    }
    try {
      await this.aibotClient.sendText({
        eventID: record.eventID,
        sessionID: record.sessionID,
        text: buildInterruptedEventNotice(),
        quotedMessageID: record.msgID,
        extra: {
          reply_source: "daemon_worker_interrupted",
        },
      });
    } catch {
      // best effort only
    }
    try {
      this.aibotClient.sendEventResult({
        event_id: record.eventID,
        status: "failed",
        code: "worker_interrupted",
        msg: "worker interrupted while processing event",
      });
    } catch {
      // best effort only
    }
    this.clearPendingEvent(record.eventID);
  }

  async handleWorkerStatusUpdate(previousBinding, nextBinding) {
    const sessionID = normalizeString(nextBinding?.aibot_session_id || previousBinding?.aibot_session_id);
    const nextStatus = normalizeString(nextBinding?.worker_status);
    if (!sessionID || !nextStatus) {
      return;
    }

    if (nextStatus === "ready" && nextBinding?.worker_control_url && nextBinding?.worker_control_token) {
      await this.flushPendingSessionEvents(sessionID, nextBinding);
    }

    if (nextStatus !== "stopped" && nextStatus !== "failed") {
      return;
    }

    const previousWorkerID = normalizeString(previousBinding?.worker_id);
    for (const record of this.listPendingEventsForSession(sessionID)) {
      if (record.delivery_state !== "delivered") {
        continue;
      }
      if (previousWorkerID && normalizeString(record.last_worker_id) !== previousWorkerID) {
        continue;
      }
      this.markPendingEventInterrupted(record.eventID);
      await this.failPendingEvent(record);
    }
  }

  async handleEventCompleted(eventID) {
    this.clearPendingEvent(eventID);
  }

  async deliverWithRecovery(aibotSessionID, rawPayload, deliverFn) {
    const binding = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    if (!binding) {
      return null;
    }

    let readyBinding = binding;
    if (binding.worker_status === "ready" && binding.worker_control_url && binding.worker_control_token) {
      try {
        await deliverFn.call(this, binding, rawPayload);
        return binding;
      } catch {
        readyBinding = await this.bindingRegistry.markWorkerStarting(binding.aibot_session_id, {
          workerID: binding.worker_id || randomUUID(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      }
    }

    readyBinding = await this.ensureReadyBinding(readyBinding.aibot_session_id);
    if (
      readyBinding?.worker_status !== "ready" ||
      !readyBinding?.worker_control_url ||
      !readyBinding?.worker_control_token
    ) {
      return null;
    }

    await deliverFn.call(this, readyBinding, rawPayload);
    return readyBinding;
  }

  async ensureReadyBinding(aibotSessionID) {
    const binding = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    if (!binding) {
      return null;
    }

    let readyBinding = binding;
    if (binding.worker_status === "ready" && binding.worker_control_url && binding.worker_control_token) {
      return binding;
    }

    const nextRuntime = await this.ensureWorker(binding);
    if (!readyBinding.worker_control_url || !readyBinding.worker_control_token || nextRuntime?.status === "starting") {
      readyBinding = await this.waitForWorkerBridgeState(aibotSessionID, {
        timeoutMs: 15000,
      });
    }
    return readyBinding ?? binding;
  }

  async handleOpenCommand(event, parsed) {
    const cwd = normalizeString(parsed.args.cwd);
    await ensureDirectoryExists(cwd);

    const existing = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (existing) {
      if (existing.cwd !== cwd) {
        await this.reply(
          event,
          `当前会话已经固定绑定目录，不能改成新目录。\n\n${formatBindingSummary(existing)}`,
          { reply_source: "daemon_control_open_reject" },
        );
        return;
      }

      await this.ensureWorker(existing);
      await this.reply(
        event,
        `当前会话已经绑定，已按原目录恢复或保持原会话。\n\n${formatBindingSummary(existing)}`,
        { reply_source: "daemon_control_open_existing" },
      );
      return;
    }

    const workerID = randomUUID();
    const claudeSessionID = randomUUID();
    const pluginDataDir = resolveWorkerPluginDataDir(event.session_id, this.env);
    const created = await this.bindingRegistry.createBinding({
      aibot_session_id: event.session_id,
      claude_session_id: claudeSessionID,
      cwd,
      worker_id: workerID,
      worker_status: "starting",
      plugin_data_dir: pluginDataDir,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_started_at: Date.now(),
      last_stopped_at: 0,
    });

    await this.workerProcessManager.spawnWorker({
      aibotSessionID: created.aibot_session_id,
      cwd: created.cwd,
      pluginDataDir: created.plugin_data_dir,
      claudeSessionID: created.claude_session_id,
      workerID: created.worker_id,
      bridgeURL: this.bridgeServer.getURL(),
      bridgeToken: this.bridgeServer.token,
    });

    await this.reply(
      event,
      `已新建目录会话。\n\n${formatBindingSummary(created)}`,
      { reply_source: "daemon_control_open_created" },
    );
  }

  async handleStatusCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    await this.reply(event, formatBindingSummary(binding), {
      reply_source: "daemon_control_status",
    });
  }

  async handleWhereCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    const text = binding
      ? `当前目录: ${binding.cwd}`
      : "当前会话还没有绑定目录。";
    await this.reply(event, text, {
      reply_source: "daemon_control_where",
    });
  }

  async handleStopCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.reply(event, "当前会话还没有绑定目录。", {
        reply_source: "daemon_control_stop_missing",
      });
      return;
    }

    if (binding.worker_id) {
      await this.workerProcessManager.stopWorker(binding.worker_id);
    }
    await this.bindingRegistry.markWorkerStopped(event.session_id, {
      updatedAt: Date.now(),
      lastStoppedAt: Date.now(),
    });
    await this.reply(event, `已停止当前会话对应的 Claude。\n\n${formatBindingSummary({
      ...binding,
      worker_status: "stopped",
    })}`, {
      reply_source: "daemon_control_stop",
    });
  }

  async handleControlCommand(event, parsed) {
    if (!parsed.ok) {
      await this.reply(event, parsed.error, {
        reply_source: "daemon_control_invalid",
      });
      return true;
    }

    switch (parsed.command) {
      case "open":
        await this.handleOpenCommand(event, parsed);
        return true;
      case "status":
        await this.handleStatusCommand(event);
        return true;
      case "where":
        await this.handleWhereCommand(event);
        return true;
      case "stop":
        await this.handleStopCommand(event);
        return true;
      default:
        return false;
    }
  }

  async handleEvent(rawPayload) {
    const event = normalizeInboundEventPayload(rawPayload);
    if (!event.event_id || !event.session_id || !event.msg_id) {
      return;
    }
    this.eventSessionIndex.set(event.event_id, event.session_id);
    this.ack(event);

    const parsed = parseControlCommand(event.content);
    if (parsed.matched) {
      await this.handleControlCommand(event, parsed);
      return;
    }

    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.reply(
        event,
        "当前会话还没有绑定目录。先发送 open <目录> 来创建会话。",
        { reply_source: "daemon_route_missing" },
      );
      return;
    }

    const pending = this.trackPendingEvent(rawPayload);
    const deliveredBinding = await this.deliverWithRecovery(
      binding.aibot_session_id,
      rawPayload,
      this.deliverEventToWorker,
    );
    if (deliveredBinding) {
      if (pending) {
        this.markPendingEventDelivered(pending.eventID, deliveredBinding);
      }
      return;
    }

    const readyBinding = this.bindingRegistry.getByAibotSessionID(binding.aibot_session_id) ?? binding;
    if (!readyBinding.worker_control_url || !readyBinding.worker_control_token) {
      await this.reply(
        event,
        `当前会话已经绑定到原 Claude，但 worker 还没准备好。\n\n${formatBindingSummary(readyBinding ?? binding)}`,
        { reply_source: "daemon_route_pending" },
      );
      return;
    }
  }

  async handleStopEvent(rawPayload) {
    const eventID = normalizeString(rawPayload?.event_id);
    if (!eventID) {
      return;
    }
    const sessionID = normalizeString(rawPayload?.session_id) || this.eventSessionIndex.get(eventID) || "";
    if (!sessionID) {
      return;
    }

    await this.deliverWithRecovery(sessionID, rawPayload, this.deliverStopToWorker);
  }

  async handleRevokeEvent(rawPayload) {
    const eventID = normalizeString(rawPayload?.event_id);
    if (!eventID) {
      return;
    }
    const sessionID = normalizeString(rawPayload?.session_id) || this.eventSessionIndex.get(eventID) || "";
    if (!sessionID) {
      return;
    }

    await this.deliverWithRecovery(sessionID, rawPayload, this.deliverRevokeToWorker);
  }
}
