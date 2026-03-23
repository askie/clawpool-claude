import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { parseControlCommand } from "./control-command.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { MessageDeliveryStore } from "./message-delivery-store.js";
import { resolveWorkerPluginDataDir } from "./daemon-paths.js";
import { WorkerControlClient } from "./worker-control-client.js";
import { claudeSessionExists as defaultClaudeSessionExists } from "./claude-session-store.js";
import { isProcessRunning as defaultIsProcessRunning } from "../process-control.js";

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

function buildInterruptedEventNotice() {
  return "Claude 刚刚中断了，这条消息没有处理完成。请再发一次。";
}

function hasWorkerControl(binding) {
  return Boolean(binding?.worker_control_url && binding?.worker_control_token);
}

function canDeliverToWorker(binding) {
  const status = normalizeString(binding?.worker_status);
  return hasWorkerControl(binding) && status === "ready";
}

function withWorkerLaunchFailure(binding, code) {
  return {
    ...(binding ?? {}),
    worker_launch_failure: normalizeString(code),
  };
}

export class DaemonRuntime {
  constructor({
    env = process.env,
    bindingRegistry,
    workerProcessManager,
    aibotClient,
    bridgeServer,
    workerControlClientFactory = null,
    claudeSessionExists = defaultClaudeSessionExists,
    messageDeliveryStore = null,
    logger = null,
    workerRuntimeHealthCheckMs = 1000,
    isProcessRunning = defaultIsProcessRunning,
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
    this.claudeSessionExists = typeof claudeSessionExists === "function"
      ? claudeSessionExists
      : defaultClaudeSessionExists;
    this.messageDeliveryStore = messageDeliveryStore instanceof MessageDeliveryStore
      ? messageDeliveryStore
      : new MessageDeliveryStore();
    this.logger = logger;
    this.workerRuntimeHealthCheckMs = Number.isFinite(Number(workerRuntimeHealthCheckMs))
      ? Math.max(0, Math.floor(Number(workerRuntimeHealthCheckMs)))
      : 1000;
    this.isProcessRunning = typeof isProcessRunning === "function"
      ? isProcessRunning
      : defaultIsProcessRunning;
    this.workerRuntimeHealthCheckTimer = null;
    if (this.workerRuntimeHealthCheckMs > 0) {
      this.workerRuntimeHealthCheckTimer = setInterval(() => {
        void this.reconcileWorkerProcesses();
      }, this.workerRuntimeHealthCheckMs);
      this.workerRuntimeHealthCheckTimer.unref?.();
    }
  }

  trace(fields, level = "info") {
    this.logger?.trace?.({
      component: "daemon.runtime",
      ...fields,
    }, { level });
  }

  async close() {
    if (this.workerRuntimeHealthCheckTimer) {
      clearInterval(this.workerRuntimeHealthCheckTimer);
      this.workerRuntimeHealthCheckTimer = null;
    }
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
    this.trace({
      stage: "event_acked",
      event_id: event.event_id,
      session_id: event.session_id,
      msg_id: event.msg_id,
    });
  }

  async shouldResumeClaudeSession(binding) {
    const claudeSessionID = normalizeString(binding?.claude_session_id);
    const cwd = normalizeString(binding?.cwd);
    if (!claudeSessionID || !cwd) {
      return false;
    }
    return this.claudeSessionExists({
      cwd,
      claudeSessionID,
      env: this.env,
    });
  }

  async ensureWorker(binding) {
    if (canDeliverToWorker(binding)) {
      return {
        worker_id: binding.worker_id,
        status: binding.worker_status,
      };
    }

    if (binding.worker_status === "starting" || binding.worker_status === "connected") {
      const current = await this.waitForWorkerBridgeState(binding.aibot_session_id);
      if (canDeliverToWorker(current)) {
        return {
          worker_id: current.worker_id,
          status: current.worker_status,
        };
      }
      const workerID = normalizeString(binding.worker_id);
      if (workerID) {
        const existingRuntime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
        const existingPid = Number(existingRuntime?.pid ?? 0);
        if (existingPid > 0 && this.isProcessRunning(existingPid)) {
          return { worker_id: workerID, status: "starting" };
        }
      }
    }

    await this.bindingRegistry.markWorkerStarting(binding.aibot_session_id, {
      workerID: binding.worker_id || randomUUID(),
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    const resumeSession = await this.shouldResumeClaudeSession(binding);
    return this.workerProcessManager.spawnWorker({
      aibotSessionID: binding.aibot_session_id,
      cwd: binding.cwd,
      pluginDataDir: binding.plugin_data_dir,
      claudeSessionID: binding.claude_session_id,
      workerID: binding.worker_id || randomUUID(),
      bridgeURL: this.bridgeServer.getURL(),
      bridgeToken: this.bridgeServer.token,
      resumeSession,
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
      if (canDeliverToWorker(current)) {
        const hasMissingResumeSessionError = (
          normalizeString(current.worker_status) === "starting" ||
          normalizeString(current.worker_status) === "connected"
        ) && await this.workerProcessManager?.hasMissingResumeSessionError?.(current.worker_id);
        if (hasMissingResumeSessionError) {
          return withWorkerLaunchFailure(current, "resume_session_missing");
        }
        return current;
      }
      if (
        (normalizeString(current.worker_status) === "starting" ||
          normalizeString(current.worker_status) === "connected") &&
        await this.workerProcessManager?.hasMissingResumeSessionError?.(current.worker_id)
      ) {
        return withWorkerLaunchFailure(current, "resume_session_missing");
      }
      if (current.worker_status === "stopped" || current.worker_status === "failed") {
        return current;
      }
      await sleep(intervalMs);
    }
    const current = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    if (
      (normalizeString(current?.worker_status) === "starting" ||
        normalizeString(current?.worker_status) === "connected") &&
      await this.workerProcessManager?.hasMissingResumeSessionError?.(current?.worker_id)
    ) {
      return withWorkerLaunchFailure(current, "resume_session_missing");
    }
    return current;
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
    await this.messageDeliveryStore.clearEventState(eventID);
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
        this.trace({
          stage: "pending_event_flushing",
          event_id: record.eventID,
          session_id: record.sessionID,
          worker_id: binding?.worker_id,
        });
        await this.markPendingEventDispatching(record.eventID, binding);
        await this.deliverEventToWorker(binding, record.rawPayload);
        await this.markPendingEventDelivered(record.eventID, binding);
        this.trace({
          stage: "pending_event_flushed",
          event_id: record.eventID,
          session_id: record.sessionID,
          worker_id: binding?.worker_id,
        });
      } catch (error) {
        await this.markPendingEventPending(record.eventID);
        this.trace({
          stage: "pending_event_flush_failed",
          event_id: record.eventID,
          session_id: record.sessionID,
          worker_id: binding?.worker_id,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
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
    await this.clearPendingEvent(record.eventID);
    this.trace({
      stage: "pending_event_failed",
      event_id: record.eventID,
      session_id: record.sessionID,
      status: "failed",
      code: "worker_interrupted",
    }, "error");
  }

  async reconcileWorkerProcesses() {
    const bindings = this.bindingRegistry?.listBindings?.() ?? [];
    for (const binding of bindings) {
      await this.reconcileWorkerProcess(binding);
    }
  }

  async reconcileWorkerProcess(binding) {
    const sessionID = normalizeString(binding?.aibot_session_id);
    const workerID = normalizeString(binding?.worker_id);
    const workerStatus = normalizeString(binding?.worker_status);
    if (
      !sessionID
      || !workerID
      || !["starting", "connected", "ready"].includes(workerStatus)
    ) {
      return false;
    }

    const runtime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
    if (!runtime) {
      return false;
    }

    const pid = Number(runtime.pid ?? 0);
    if (!Number.isFinite(pid) || pid <= 0 || this.isProcessRunning(pid)) {
      return false;
    }

    this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
      exitCode: Number(runtime.exit_code ?? 0),
      exitSignal: normalizeString(runtime.exit_signal) || "worker_exited",
    });

    const previousBinding = this.bindingRegistry.getByAibotSessionID(sessionID) ?? binding;
    if (
      normalizeString(previousBinding?.worker_id) !== workerID
      || ["stopped", "failed"].includes(normalizeString(previousBinding?.worker_status))
    ) {
      return false;
    }

    this.trace({
      stage: "worker_process_exit_detected",
      session_id: sessionID,
      worker_id: workerID,
      pid,
      previous_status: workerStatus,
    }, "error");

    const nextBinding = await this.bindingRegistry.markWorkerStopped(sessionID, {
      updatedAt: Date.now(),
      lastStoppedAt: Date.now(),
    });
    await this.handleWorkerStatusUpdate(previousBinding, nextBinding);
    return true;
  }

  async handleWorkerStatusUpdate(previousBinding, nextBinding) {
    const sessionID = normalizeString(nextBinding?.aibot_session_id || previousBinding?.aibot_session_id);
    const nextStatus = normalizeString(nextBinding?.worker_status);
    if (!sessionID || !nextStatus) {
      return;
    }

    this.trace({
      stage: "worker_status_updated",
      session_id: sessionID,
      worker_id: nextBinding?.worker_id || previousBinding?.worker_id,
      status: nextStatus,
    });

    if (canDeliverToWorker(nextBinding)) {
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
      await this.markPendingEventInterrupted(record.eventID);
      await this.failPendingEvent(record);
    }
  }

  async handleEventCompleted(eventID) {
    await this.clearPendingEvent(eventID);
    this.trace({
      stage: "event_completed",
      event_id: eventID,
    });
  }

  async recoverPersistedDeliveryState() {
    for (const record of this.listPendingEvents()) {
      this.trace({
        stage: "delivery_state_recovered",
        event_id: record.eventID,
        session_id: record.sessionID,
        delivery_state: record.delivery_state,
      });
      const binding = this.bindingRegistry.getByAibotSessionID(record.sessionID);
      if (!binding) {
        await this.clearPendingEvent(record.eventID);
        this.trace({
          stage: "delivery_state_cleared_missing_binding",
          event_id: record.eventID,
          session_id: record.sessionID,
        }, "error");
        continue;
      }

      if (record.delivery_state === "pending") {
        if (canDeliverToWorker(binding)) {
          await this.flushPendingSessionEvents(record.sessionID, binding);
        }
        continue;
      }

      await this.markPendingEventInterrupted(record.eventID);
      const currentRecord = this.getPendingEvent(record.eventID) ?? record;
      await this.failPendingEvent(currentRecord);
    }
  }

  async deliverWithRecovery(aibotSessionID, rawPayload, deliverFn) {
    const binding = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    if (!binding) {
      return null;
    }

    let readyBinding = binding;
    if (canDeliverToWorker(binding)) {
      try {
        this.trace({
          stage: "event_dispatching",
          event_id: rawPayload?.event_id,
          session_id: aibotSessionID,
          worker_id: binding?.worker_id,
          path: "ready_worker",
        });
        await this.markPendingEventDispatching(rawPayload?.event_id, binding);
        await deliverFn.call(this, binding, rawPayload);
        this.trace({
          stage: "event_dispatched",
          event_id: rawPayload?.event_id,
          session_id: aibotSessionID,
          worker_id: binding?.worker_id,
          path: "ready_worker",
        });
        return binding;
      } catch (error) {
        await this.markPendingEventPending(rawPayload?.event_id);
        this.trace({
          stage: "event_dispatch_retrying",
          event_id: rawPayload?.event_id,
          session_id: aibotSessionID,
          worker_id: binding?.worker_id,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
        readyBinding = await this.bindingRegistry.markWorkerStarting(binding.aibot_session_id, {
          workerID: binding.worker_id || randomUUID(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      }
    }

    readyBinding = await this.ensureReadyBinding(readyBinding.aibot_session_id);
    if (!canDeliverToWorker(readyBinding)) {
      this.trace({
        stage: "event_waiting_worker",
        event_id: rawPayload?.event_id,
        session_id: aibotSessionID,
      });
      return null;
    }

    this.trace({
      stage: "event_dispatching",
      event_id: rawPayload?.event_id,
      session_id: aibotSessionID,
      worker_id: readyBinding?.worker_id,
      path: "recovered_worker",
    });
    await this.markPendingEventDispatching(rawPayload?.event_id, readyBinding);
    await deliverFn.call(this, readyBinding, rawPayload);
    this.trace({
      stage: "event_dispatched",
      event_id: rawPayload?.event_id,
      session_id: aibotSessionID,
      worker_id: readyBinding?.worker_id,
      path: "recovered_worker",
    });
    return readyBinding;
  }

  async ensureReadyBinding(aibotSessionID) {
    const binding = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    if (!binding) {
      return null;
    }

    let readyBinding = binding;
    if (canDeliverToWorker(binding)) {
      return binding;
    }

    const nextRuntime = await this.ensureWorker(binding);
    if (!readyBinding.worker_control_url || !readyBinding.worker_control_token || nextRuntime?.status === "starting") {
      readyBinding = await this.waitForWorkerBridgeState(aibotSessionID, {
        timeoutMs: 15000,
      });
    } else {
      readyBinding = this.bindingRegistry.getByAibotSessionID(aibotSessionID) ?? readyBinding;
    }

    if (
      readyBinding?.worker_launch_failure === "resume_session_missing" &&
      normalizeString(binding.claude_session_id)
    ) {
      await this.bindingRegistry.markWorkerStarting(binding.aibot_session_id, {
        workerID: binding.worker_id || randomUUID(),
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      await this.workerProcessManager.spawnWorker({
        aibotSessionID: binding.aibot_session_id,
        cwd: binding.cwd,
        pluginDataDir: binding.plugin_data_dir,
        claudeSessionID: binding.claude_session_id,
        workerID: binding.worker_id || randomUUID(),
        bridgeURL: this.bridgeServer.getURL(),
        bridgeToken: this.bridgeServer.token,
        resumeSession: false,
      });
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
    this.trace({
      stage: "event_received",
      event_id: event.event_id,
      session_id: event.session_id,
      msg_id: event.msg_id,
      sender_id: event.sender_id,
    });
    this.ack(event);

    const parsed = parseControlCommand(event.content);
    if (parsed.matched) {
      await this.handleControlCommand(event, parsed);
      return;
    }

    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      this.trace({
        stage: "event_binding_missing",
        event_id: event.event_id,
        session_id: event.session_id,
      }, "error");
      await this.reply(
        event,
        "当前会话还没有绑定目录。先发送 open <目录> 来创建会话。",
        { reply_source: "daemon_route_missing" },
      );
      return;
    }

    const pending = await this.trackPendingEvent(rawPayload);
    if (pending) {
      this.trace({
        stage: "event_tracked",
        event_id: pending.eventID,
        session_id: pending.sessionID,
        msg_id: pending.msgID,
      });
    }
    const deliveredBinding = await this.deliverWithRecovery(
      binding.aibot_session_id,
      rawPayload,
      this.deliverEventToWorker,
    );
    if (deliveredBinding) {
      if (pending) {
        await this.markPendingEventDelivered(pending.eventID, deliveredBinding);
      }
      this.trace({
        stage: "event_forwarded",
        event_id: event.event_id,
        session_id: event.session_id,
        worker_id: deliveredBinding?.worker_id,
      });
      return;
    }

    const readyBinding = this.bindingRegistry.getByAibotSessionID(binding.aibot_session_id) ?? binding;
    if (!readyBinding.worker_control_url || !readyBinding.worker_control_token) {
      this.trace({
        stage: "event_worker_not_ready",
        event_id: event.event_id,
        session_id: event.session_id,
        worker_id: readyBinding?.worker_id,
        status: readyBinding?.worker_status,
      }, "error");
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
    this.trace({
      stage: "stop_received",
      event_id: eventID,
      session_id: rawPayload?.session_id,
      stop_id: rawPayload?.stop_id,
    });
    const sessionID = normalizeString(rawPayload?.session_id)
      || this.messageDeliveryStore.getRememberedSessionID(eventID);
    if (!sessionID) {
      this.trace({
        stage: "stop_route_missing",
        event_id: eventID,
        stop_id: rawPayload?.stop_id,
      }, "error");
      return;
    }

    await this.deliverWithRecovery(sessionID, rawPayload, this.deliverStopToWorker);
    this.trace({
      stage: "stop_forwarded",
      event_id: eventID,
      session_id: sessionID,
      stop_id: rawPayload?.stop_id,
    });
  }

  async handleRevokeEvent(rawPayload) {
    const eventID = normalizeString(rawPayload?.event_id);
    if (!eventID) {
      return;
    }
    this.trace({
      stage: "revoke_received",
      event_id: eventID,
      session_id: rawPayload?.session_id,
      msg_id: rawPayload?.msg_id,
    });
    const sessionID = normalizeString(rawPayload?.session_id)
      || this.messageDeliveryStore.getRememberedSessionID(eventID);
    if (!sessionID) {
      this.trace({
        stage: "revoke_route_missing",
        event_id: eventID,
        msg_id: rawPayload?.msg_id,
      }, "error");
      return;
    }

    await this.deliverWithRecovery(sessionID, rawPayload, this.deliverRevokeToWorker);
    this.trace({
      stage: "revoke_forwarded",
      event_id: eventID,
      session_id: sessionID,
      msg_id: rawPayload?.msg_id,
    });
  }
}
