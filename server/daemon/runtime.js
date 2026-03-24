import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { parseControlCommand } from "./control-command.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { MessageDeliveryStore } from "./message-delivery-store.js";
import { resolveWorkerPluginDataDir } from "./daemon-paths.js";
import { WorkerControlClient } from "./worker-control-client.js";
import { buildOpenWorkspaceCard } from "./control-card.js";
import { claudeSessionExists as defaultClaudeSessionExists } from "./claude-session-store.js";
import { isProcessRunning as defaultIsProcessRunning } from "../process-control.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

async function ensureDirectoryExists(directoryPath) {
  let info;
  try {
    info = await stat(directoryPath);
  } catch (error) {
    const code = normalizeString(error?.code);
    if (code === "ENOENT") {
      throw new Error("指定路径不存在。");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("指定路径不可访问。");
    }
    throw error;
  }
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

function buildMissingBindingCardOptions() {
  return {
    summaryText: "当前会话还没有绑定目录。",
    detailText: "发送 open <目录> 来创建会话。",
  };
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

function formatRuntimeError(error, fallback = "处理失败。") {
  const message = normalizeString(error?.message || error);
  return message || fallback;
}

const defaultDeliveredInFlightMaxAgeMs = 60 * 1000;
const queuedEventRetryDelayMs = 200;
const defaultWorkerControlProbeFailureThreshold = 3;

function normalizeNonNegativeInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallbackValue;
  }
  return Math.max(0, Math.floor(numeric));
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
    deliveredInFlightMaxAgeMs = null,
    workerControlProbeFailureThreshold = defaultWorkerControlProbeFailureThreshold,
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
    this.deliveredInFlightMaxAgeMs = normalizeNonNegativeInt(
      deliveredInFlightMaxAgeMs ?? env.CLAWPOOL_CLAUDE_DELIVERED_INFLIGHT_MAX_AGE_MS,
      defaultDeliveredInFlightMaxAgeMs,
    );
    this.workerControlProbeFailureThreshold = normalizeNonNegativeInt(
      workerControlProbeFailureThreshold ?? env.CLAWPOOL_CLAUDE_WORKER_CONTROL_PROBE_FAILURE_THRESHOLD,
      defaultWorkerControlProbeFailureThreshold,
    );
    this.isProcessRunning = typeof isProcessRunning === "function"
      ? isProcessRunning
      : defaultIsProcessRunning;
    this.workerControlProbeFailures = new Map();
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
    this.workerControlProbeFailures.clear();
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

  complete(event, { status = "responded", code = "", msg = "" } = {}) {
    const payload = {
      event_id: event.event_id,
      status,
    };
    const normalizedCode = normalizeString(code);
    const normalizedMsg = normalizeString(msg);
    if (normalizedCode) {
      payload.code = normalizedCode;
    }
    if (normalizedMsg) {
      payload.msg = normalizedMsg;
    }
    this.aibotClient.sendEventResult(payload);
    this.trace({
      stage: "event_result_sent",
      event_id: event.event_id,
      session_id: event.session_id,
      status,
      code: normalizedCode,
    });
  }

  async respond(event, text, extra = {}, result = {}) {
    const response = await this.reply(event, text, extra);
    this.complete(event, result);
    return response;
  }

  async respondWithOpenWorkspaceCard(event, {
    summaryText,
    detailText,
    initialCwd = "",
    replySource = "",
  } = {}, result = {}) {
    const fallbackText = normalizeString(summaryText) || "当前会话还没有绑定目录。";
    return this.respond(
      event,
      fallbackText,
      {
        ...(replySource ? { reply_source: replySource } : {}),
        biz_card: buildOpenWorkspaceCard({
          summaryText,
          detailText,
          initialCwd,
        }),
      },
      result,
    );
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

  async rotateClaudeSession(binding) {
    return this.bindingRegistry.updateClaudeSessionID(binding.aibot_session_id, {
      claudeSessionID: randomUUID(),
      updatedAt: Date.now(),
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

    const workerID = binding.worker_id || randomUUID();
    const resumeSession = await this.shouldResumeClaudeSession(binding);
    let launchBinding = binding;
    if (!resumeSession) {
      launchBinding = await this.rotateClaudeSession(binding);
    }

    await this.bindingRegistry.markWorkerStarting(launchBinding.aibot_session_id, {
      workerID,
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    return this.workerProcessManager.spawnWorker({
      aibotSessionID: launchBinding.aibot_session_id,
      cwd: launchBinding.cwd,
      pluginDataDir: launchBinding.plugin_data_dir,
      claudeSessionID: launchBinding.claude_session_id,
      workerID,
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

  clearWorkerControlProbeFailure(workerID) {
    const normalizedWorkerID = normalizeString(workerID);
    if (!normalizedWorkerID) {
      return;
    }
    this.workerControlProbeFailures.delete(normalizedWorkerID);
  }

  markWorkerControlProbeFailure(workerID, error) {
    const normalizedWorkerID = normalizeString(workerID);
    if (!normalizedWorkerID) {
      return 0;
    }
    const nextFailures = Number(this.workerControlProbeFailures.get(normalizedWorkerID) ?? 0) + 1;
    this.workerControlProbeFailures.set(normalizedWorkerID, nextFailures);
    this.trace({
      stage: "worker_control_probe_failed",
      worker_id: normalizedWorkerID,
      failures: nextFailures,
      threshold: this.workerControlProbeFailureThreshold,
      error: error instanceof Error ? error.message : String(error),
    }, nextFailures >= this.workerControlProbeFailureThreshold ? "error" : "info");
    return nextFailures;
  }

  async probeWorkerControl(binding) {
    if (this.workerControlProbeFailureThreshold <= 0) {
      return { ok: true };
    }
    if (normalizeString(binding?.worker_status) !== "ready") {
      return { ok: true };
    }
    const workerID = normalizeString(binding?.worker_id);
    if (!workerID) {
      return { ok: true };
    }
    let client = null;
    try {
      client = this.workerControlClientFactory(binding);
    } catch (error) {
      const failures = this.markWorkerControlProbeFailure(workerID, error);
      return { ok: false, failures };
    }
    if (!client?.isConfigured?.()) {
      return { ok: true };
    }
    if (typeof client.ping !== "function") {
      return { ok: true };
    }
    try {
      await client.ping();
      this.clearWorkerControlProbeFailure(workerID);
      return { ok: true };
    } catch (error) {
      const failures = this.markWorkerControlProbeFailure(workerID, error);
      return { ok: false, failures };
    }
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

  hasInFlightSessionEvent(sessionID, { excludeEventID = "" } = {}) {
    const normalizedSessionID = normalizeString(sessionID);
    const excludedEventID = normalizeString(excludeEventID);
    if (!normalizedSessionID) {
      return false;
    }
    return this.listPendingEventsForSession(normalizedSessionID).some((record) => {
      if (excludedEventID && normalizeString(record.eventID) === excludedEventID) {
        return false;
      }
      const deliveryState = normalizeString(record.delivery_state);
      if (deliveryState === "dispatching") {
        return true;
      }
      if (deliveryState !== "delivered") {
        return false;
      }
      if (this.deliveredInFlightMaxAgeMs <= 0) {
        return false;
      }
      const updatedAt = Number(record.updated_at ?? 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
        return true;
      }
      const ageMs = Date.now() - updatedAt;
      if (ageMs <= this.deliveredInFlightMaxAgeMs) {
        return true;
      }
      this.trace({
        stage: "delivered_inflight_released",
        session_id: normalizedSessionID,
        event_id: record.eventID,
        age_ms: ageMs,
      }, "error");
      return false;
    });
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

    if (this.hasInFlightSessionEvent(normalizedSessionID)) {
      this.trace({
        stage: "pending_event_flush_skipped_inflight",
        session_id: normalizedSessionID,
        worker_id: binding?.worker_id,
      });
      return;
    }

    for (const record of this.listPendingEventsForSession(normalizedSessionID)) {
      const currentRecord = this.getPendingEvent(record.eventID) ?? record;
      if (currentRecord.delivery_state !== "pending") {
        continue;
      }
      try {
        this.trace({
          stage: "pending_event_flushing",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
          attempt: 1,
        });
        await this.markPendingEventDispatching(currentRecord.eventID, binding);
        await this.deliverEventToWorker(binding, currentRecord.rawPayload);
        await this.markPendingEventDelivered(currentRecord.eventID, binding);
        this.trace({
          stage: "pending_event_flushed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
        });
        return;
      } catch (error) {
        await this.markPendingEventPending(currentRecord.eventID);
        this.trace({
          stage: "pending_event_flush_retrying",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: binding?.worker_id,
          attempt: 1,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
      }

      await sleep(queuedEventRetryDelayMs);
      const latestBinding = this.bindingRegistry.getByAibotSessionID(normalizedSessionID);
      if (!canDeliverToWorker(latestBinding)) {
        this.trace({
          stage: "pending_event_flush_retry_aborted",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          status: latestBinding?.worker_status,
        }, "error");
        return;
      }

      try {
        this.trace({
          stage: "pending_event_flushing",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          attempt: 2,
        });
        await this.markPendingEventDispatching(currentRecord.eventID, latestBinding);
        await this.deliverEventToWorker(latestBinding, currentRecord.rawPayload);
        await this.markPendingEventDelivered(currentRecord.eventID, latestBinding);
        this.trace({
          stage: "pending_event_flushed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id,
          attempt: 2,
        });
        return;
      } catch (error) {
        await this.markPendingEventPending(currentRecord.eventID);
        this.trace({
          stage: "pending_event_flush_failed",
          event_id: currentRecord.eventID,
          session_id: currentRecord.sessionID,
          worker_id: latestBinding?.worker_id || binding?.worker_id,
          attempt: 2,
          error: error instanceof Error ? error.message : String(error),
        }, "error");
        return;
      }
    }
  }

  async failPendingEvent(record, { notifyText = true } = {}) {
    if (!record?.eventID || !record?.sessionID) {
      return;
    }
    if (notifyText) {
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

    const previousBinding = this.bindingRegistry.getByAibotSessionID(sessionID) ?? binding;
    if (
      normalizeString(previousBinding?.worker_id) !== workerID
      || ["stopped", "failed"].includes(normalizeString(previousBinding?.worker_status))
    ) {
      return false;
    }

    const pid = Number(runtime.pid ?? 0);
    if (Number.isFinite(pid) && pid > 0 && !this.isProcessRunning(pid)) {
      this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
        exitCode: Number(runtime.exit_code ?? 0),
        exitSignal: normalizeString(runtime.exit_signal) || "worker_exited",
      });

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

    const probe = await this.probeWorkerControl(previousBinding);
    if (!probe.ok && probe.failures >= this.workerControlProbeFailureThreshold) {
      this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
        exitCode: Number(runtime.exit_code ?? 0),
        exitSignal: "worker_control_unreachable",
      });
      this.trace({
        stage: "worker_control_unreachable_detected",
        session_id: sessionID,
        worker_id: workerID,
        pid,
        previous_status: workerStatus,
        failures: probe.failures,
      }, "error");

      const nextBinding = await this.bindingRegistry.markWorkerStopped(sessionID, {
        updatedAt: Date.now(),
        lastStoppedAt: Date.now(),
      });
      await this.handleWorkerStatusUpdate(previousBinding, nextBinding);
      return true;
    }

    return false;
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

    const previousWorkerID = normalizeString(previousBinding?.worker_id);
    const nextWorkerID = normalizeString(nextBinding?.worker_id);
    if (nextStatus === "ready" || nextStatus === "connected") {
      if (nextWorkerID) {
        this.clearWorkerControlProbeFailure(nextWorkerID);
      }
      if (previousWorkerID && previousWorkerID !== nextWorkerID) {
        this.clearWorkerControlProbeFailure(previousWorkerID);
      }
    }

    if (canDeliverToWorker(nextBinding)) {
      await this.flushPendingSessionEvents(sessionID, nextBinding);
    }

    if (nextStatus !== "stopped" && nextStatus !== "failed") {
      return;
    }

    if (nextWorkerID) {
      this.clearWorkerControlProbeFailure(nextWorkerID);
    }
    if (previousWorkerID && previousWorkerID !== nextWorkerID) {
      this.clearWorkerControlProbeFailure(previousWorkerID);
    }

    for (const record of this.listPendingEventsForSession(sessionID)) {
      if (previousWorkerID && normalizeString(record.last_worker_id) !== previousWorkerID) {
        if (normalizeString(record.last_worker_id)) {
          continue;
        }
        if (!["pending", "dispatching", "interrupted"].includes(normalizeString(record.delivery_state))) {
          continue;
        }
      }
      await this.markPendingEventInterrupted(record.eventID);
      await this.failPendingEvent(record);
    }
  }

  async handleEventCompleted(eventID) {
    const record = this.getPendingEvent(eventID);
    const sessionID = normalizeString(record?.sessionID || this.messageDeliveryStore.getRememberedSessionID(eventID));
    await this.clearPendingEvent(eventID);
    this.trace({
      stage: "event_completed",
      event_id: eventID,
    });
    if (!sessionID) {
      return;
    }
    const binding = this.bindingRegistry.getByAibotSessionID(sessionID);
    if (canDeliverToWorker(binding)) {
      await this.flushPendingSessionEvents(sessionID, binding);
    }
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
      await this.failPendingEvent(currentRecord, { notifyText: false });
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
    const currentRecord = this.getPendingEvent(rawPayload?.event_id);
    if (
      currentRecord
      && ["dispatching", "delivered"].includes(normalizeString(currentRecord.delivery_state))
      && normalizeString(currentRecord.last_worker_id) === normalizeString(readyBinding?.worker_id)
    ) {
      this.trace({
        stage: "event_dispatch_skipped",
        event_id: rawPayload?.event_id,
        session_id: aibotSessionID,
        worker_id: readyBinding?.worker_id,
        path: "recovered_worker",
        reason: "already_dispatched",
      });
      return readyBinding;
    }
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
      const fallbackBinding = await this.rotateClaudeSession(binding);
      const workerID = fallbackBinding.worker_id || randomUUID();
      await this.bindingRegistry.markWorkerStarting(fallbackBinding.aibot_session_id, {
        workerID,
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      await this.workerProcessManager.spawnWorker({
        aibotSessionID: fallbackBinding.aibot_session_id,
        cwd: fallbackBinding.cwd,
        pluginDataDir: fallbackBinding.plugin_data_dir,
        claudeSessionID: fallbackBinding.claude_session_id,
        workerID,
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
        await this.respond(
          event,
          `当前会话已经固定绑定目录，不能改成新目录。\n\n${formatBindingSummary(existing)}`,
          { reply_source: "daemon_control_open_reject" },
        );
        return;
      }

      await this.ensureWorker(existing);
      await this.respond(
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

    await this.respond(
      event,
      `已新建目录会话。\n\n${formatBindingSummary(created)}`,
      { reply_source: "daemon_control_open_created" },
    );
  }

  async handleStatusCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...buildMissingBindingCardOptions(),
        replySource: "daemon_control_status_missing",
      });
      return;
    }
    await this.respond(event, formatBindingSummary(binding), {
      reply_source: "daemon_control_status",
    });
  }

  async handleWhereCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...buildMissingBindingCardOptions(),
        replySource: "daemon_control_where_missing",
      });
      return;
    }
    const text = `当前目录: ${binding.cwd}`;
    await this.respond(event, text, {
      reply_source: "daemon_control_where",
    });
  }

  async handleStopCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...buildMissingBindingCardOptions(),
        replySource: "daemon_control_stop_missing",
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
    await this.respond(event, `已停止当前会话对应的 Claude。\n\n${formatBindingSummary({
      ...binding,
      worker_status: "stopped",
    })}`, {
      reply_source: "daemon_control_stop",
    });
  }

  async handleControlCommand(event, parsed) {
    if (!parsed.ok) {
      if (parsed.command === "open") {
        await this.respondWithOpenWorkspaceCard(event, {
          summaryText: parsed.error,
          replySource: "daemon_control_invalid",
        });
        return true;
      }
      await this.respond(event, parsed.error, {
        reply_source: "daemon_control_invalid",
      });
      return true;
    }

    try {
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
    } catch (error) {
      const message = formatRuntimeError(error, "命令执行失败。");
      if (parsed.command === "open") {
        await this.respondWithOpenWorkspaceCard(event, {
          summaryText: message,
          detailText: "发送 open <目录> 来创建会话。",
          replySource: "daemon_control_open_error",
        });
        return true;
      }
      await this.respond(event, message, {
        reply_source: "daemon_control_error",
      });
      return true;
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
    try {
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
        await this.respondWithOpenWorkspaceCard(event, {
          ...buildMissingBindingCardOptions(),
          replySource: "daemon_route_missing",
        });
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
        if (this.hasInFlightSessionEvent(binding.aibot_session_id, {
          excludeEventID: pending.eventID,
        })) {
          this.trace({
            stage: "event_queued_behind_inflight",
            event_id: pending.eventID,
            session_id: pending.sessionID,
            worker_id: binding?.worker_id,
          });
          return;
        }
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
      }
    } catch (error) {
      const message = formatRuntimeError(error);
      this.trace({
        stage: "event_handle_failed",
        event_id: event.event_id,
        session_id: event.session_id,
        error: message,
      }, "error");
      try {
        await this.respond(event, `处理失败：${message}`, {
          reply_source: "daemon_event_error",
        }, {
          status: "failed",
          code: "daemon_event_handle_failed",
          msg: message,
        });
      } catch {
        this.complete(event, {
          status: "failed",
          code: "daemon_event_handle_failed",
          msg: message,
        });
      }
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
