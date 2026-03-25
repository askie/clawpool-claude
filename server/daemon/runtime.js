import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { parseControlCommand } from "./control-command.js";
import { normalizeInboundEventPayload } from "../inbound-event-meta.js";
import { MessageDeliveryStore } from "./message-delivery-store.js";
import { WorkerControlClient } from "./worker-control-client.js";
import { buildOpenWorkspaceCard } from "./control-card.js";
import { claudeSessionExists as defaultClaudeSessionExists } from "./claude-session-store.js";
import { DaemonControlCommandHandler } from "./control-command-handler.js";
import { WorkerHealthInspector } from "./worker-health-inspector.js";
import { PendingEventOrchestrator } from "./pending-event-orchestrator.js";
import { isProcessRunning as defaultIsProcessRunning } from "../process-control.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildAuthLoginRequiredEventNotice() {
  return "Claude 登录已失效，请在电脑上执行 claude auth login 后重试。";
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
const defaultWorkerControlProbeFailureThreshold = 3;
const defaultMcpInteractionIdleMs = 5 * 60 * 1000;
const defaultMcpResultTimeoutMs = 12 * 60 * 1000;
const defaultRecentRevokeRetentionMs = 24 * 60 * 60 * 1000;

function normalizeNonNegativeInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallbackValue;
  }
  return Math.max(0, Math.floor(numeric));
}

function resolveExpectedWorkerPid(binding, runtime) {
  const bindingPid = Number(binding?.worker_pid ?? 0);
  if (Number.isFinite(bindingPid) && bindingPid > 0) {
    return Math.floor(bindingPid);
  }
  const runtimePid = Number(runtime?.pid ?? 0);
  if (Number.isFinite(runtimePid) && runtimePid > 0) {
    return Math.floor(runtimePid);
  }
  return 0;
}

function resolveExpectedIdentityWorkerPid(binding) {
  const bindingPid = Number(binding?.worker_pid ?? 0);
  if (Number.isFinite(bindingPid) && bindingPid > 0) {
    return Math.floor(bindingPid);
  }
  return 0;
}

function buildRevokeDedupKey({ eventID = "", sessionID = "", msgID = "" } = {}) {
  const normalizedSessionID = normalizeString(sessionID);
  const normalizedMsgID = normalizeString(msgID);
  if (normalizedSessionID && normalizedMsgID) {
    return `${normalizedSessionID}:${normalizedMsgID}`;
  }
  return normalizeString(eventID);
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
    mcpInteractionIdleMs = defaultMcpInteractionIdleMs,
    mcpResultTimeoutMs = defaultMcpResultTimeoutMs,
    recentRevokeRetentionMs = defaultRecentRevokeRetentionMs,
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
    this.mcpInteractionIdleMs = normalizeNonNegativeInt(
      mcpInteractionIdleMs ?? env.CLAWPOOL_CLAUDE_MCP_INTERACTION_IDLE_MS,
      defaultMcpInteractionIdleMs,
    );
    this.mcpResultTimeoutMs = normalizeNonNegativeInt(
      mcpResultTimeoutMs ?? env.CLAWPOOL_CLAUDE_MCP_RESULT_TIMEOUT_MS,
      defaultMcpResultTimeoutMs,
    );
    this.recentRevokeRetentionMs = normalizeNonNegativeInt(
      recentRevokeRetentionMs ?? env.CLAWPOOL_CLAUDE_RECENT_REVOKE_RETENTION_MS,
      defaultRecentRevokeRetentionMs,
    );
    this.workerHealthInspector = new WorkerHealthInspector({
      getPendingEventsForSession: (sessionID) => this.messageDeliveryStore.listPendingEventsForSession(sessionID),
      mcpInteractionIdleMs: this.mcpInteractionIdleMs,
      mcpResultTimeoutMs: this.mcpResultTimeoutMs,
    });
    this.isProcessRunning = typeof isProcessRunning === "function"
      ? isProcessRunning
      : defaultIsProcessRunning;
    this.workerControlProbeFailures = new Map();
    this.controlCommandHandler = new DaemonControlCommandHandler({
      env: this.env,
      bindingRegistry: this.bindingRegistry,
      workerProcessManager: this.workerProcessManager,
      bridgeServer: this.bridgeServer,
      ensureWorker: async (binding) => this.ensureWorker(binding),
      respond: async (event, text, extra = {}, result = {}) => this.respond(event, text, extra, result),
      respondWithOpenWorkspaceCard: async (event, options = {}, result = {}) => (
        this.respondWithOpenWorkspaceCard(event, options, result)
      ),
      ensureDirectoryExists,
      formatBindingSummary,
      buildMissingBindingCardOptions,
      formatRuntimeError,
    });
    this.pendingEventOrchestrator = new PendingEventOrchestrator({
      messageDeliveryStore: this.messageDeliveryStore,
      bindingRegistry: this.bindingRegistry,
      deliverEventToWorker: async (binding, payload) => this.deliverEventToWorker(binding, payload),
      trace: (fields, level = "info") => this.trace(fields, level),
      deliveredInFlightMaxAgeMs: this.deliveredInFlightMaxAgeMs,
    });
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

  purgeExpiredRecentRevokes(now = Date.now()) {
    return this.messageDeliveryStore.purgeExpiredRecentRevokes({
      retentionMs: this.recentRevokeRetentionMs,
      now,
    });
  }

  hasRecentRevoke(revokeKey, now = Date.now()) {
    return this.messageDeliveryStore.hasRecentRevoke(revokeKey, {
      retentionMs: this.recentRevokeRetentionMs,
      now,
    });
  }

  async rememberRecentRevoke(revokeKey, now = Date.now()) {
    return this.messageDeliveryStore.rememberRecentRevoke(revokeKey, {
      retentionMs: this.recentRevokeRetentionMs,
      now,
    });
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
      this.trace({
        stage: "worker_reused_ready",
        session_id: binding.aibot_session_id,
        worker_id: binding.worker_id,
        worker_pid: binding.worker_pid,
        status: binding.worker_status,
      });
      return {
        worker_id: binding.worker_id,
        status: binding.worker_status,
      };
    }

    if (binding.worker_status === "starting" || binding.worker_status === "connected") {
      const current = await this.waitForWorkerBridgeState(binding.aibot_session_id);
      if (canDeliverToWorker(current)) {
        this.trace({
          stage: "worker_reused_after_wait",
          session_id: binding.aibot_session_id,
          worker_id: current.worker_id,
          worker_pid: current.worker_pid,
          status: current.worker_status,
        });
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
          this.trace({
            stage: "worker_runtime_alive_starting",
            session_id: binding.aibot_session_id,
            worker_id: workerID,
            worker_pid: existingPid,
            status: binding.worker_status,
          });
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

    this.trace({
      stage: "worker_spawn_requested",
      session_id: launchBinding.aibot_session_id,
      worker_id: workerID,
      cwd: launchBinding.cwd,
      claude_session_id: launchBinding.claude_session_id,
      resume_session: resumeSession,
      previous_worker_status: binding.worker_status,
    });
    await this.bindingRegistry.markWorkerStarting(launchBinding.aibot_session_id, {
      workerID,
      updatedAt: Date.now(),
      lastStartedAt: Date.now(),
    });
    const spawnedRuntime = await this.workerProcessManager.spawnWorker({
      aibotSessionID: launchBinding.aibot_session_id,
      cwd: launchBinding.cwd,
      pluginDataDir: launchBinding.plugin_data_dir,
      claudeSessionID: launchBinding.claude_session_id,
      workerID,
      bridgeURL: this.bridgeServer.getURL(),
      bridgeToken: this.bridgeServer.token,
      resumeSession,
    });
    this.trace({
      stage: "worker_spawned",
      session_id: launchBinding.aibot_session_id,
      worker_id: spawnedRuntime.worker_id,
      worker_pid: spawnedRuntime.pid,
      claude_session_id: spawnedRuntime.claude_session_id,
      resume_session: spawnedRuntime.resume_session,
      visible_terminal: spawnedRuntime.visible_terminal,
    });
    return spawnedRuntime;
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

  listInFlightSessionEvents(sessionID) {
    return this.workerHealthInspector.listInFlightSessionEvents(sessionID);
  }

  hasPendingDeliveredOrDispatchingEvent(sessionID) {
    return this.listInFlightSessionEvents(sessionID).length > 0;
  }

  inspectWorkerIdentityHealth(binding, runtime, pingPayload) {
    return this.workerHealthInspector.inspectWorkerIdentityHealth(binding, runtime, pingPayload);
  }

  inspectMcpInteractionHealth(binding, pingPayload, { now = Date.now() } = {}) {
    return this.workerHealthInspector.inspectMcpInteractionHealth(binding, pingPayload, { now });
  }

  listTimedOutMcpResultRecords(
    sessionID,
    now = Date.now(),
    { latestMcpActivityAt = 0 } = {},
  ) {
    return this.workerHealthInspector.listTimedOutMcpResultRecords(sessionID, now, {
      latestMcpActivityAt,
    });
  }

  async probeWorkerControl(binding, runtime) {
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
      const pingPayload = await client.ping();
      const identityHealth = this.inspectWorkerIdentityHealth(binding, runtime, pingPayload);
      if (!identityHealth.ok) {
        const details = [
          `reason=${identityHealth.reason}`,
          Number.isFinite(identityHealth.expectedPid) ? `expected_pid=${identityHealth.expectedPid}` : "",
          Number.isFinite(identityHealth.reportedPid) ? `reported_pid=${identityHealth.reportedPid}` : "",
          identityHealth.expectedWorkerID ? `expected_worker_id=${identityHealth.expectedWorkerID}` : "",
          identityHealth.reportedWorkerID ? `reported_worker_id=${identityHealth.reportedWorkerID}` : "",
          identityHealth.expectedSessionID ? `expected_session_id=${identityHealth.expectedSessionID}` : "",
          identityHealth.reportedSessionID ? `reported_session_id=${identityHealth.reportedSessionID}` : "",
          identityHealth.expectedClaudeSessionID ? `expected_claude_session_id=${identityHealth.expectedClaudeSessionID}` : "",
          identityHealth.reportedClaudeSessionID ? `reported_claude_session_id=${identityHealth.reportedClaudeSessionID}` : "",
        ]
          .filter((part) => part)
          .join(" ");
        const failures = this.markWorkerControlProbeFailure(
          workerID,
          new Error(details || "worker identity mismatch"),
        );
        return {
          ok: false,
          failures,
          reason: identityHealth.reason,
          expectedPid: identityHealth.expectedPid,
          reportedPid: identityHealth.reportedPid,
          pingPayload,
        };
      }

      const mcpHealth = this.inspectMcpInteractionHealth(binding, pingPayload);
      if (!mcpHealth.ok) {
        const details = [
          `reason=${mcpHealth.reason}`,
          Number.isFinite(mcpHealth.idleMs) ? `idle_ms=${mcpHealth.idleMs}` : "",
        ]
          .filter((part) => part)
          .join(" ");
        const failures = this.markWorkerControlProbeFailure(
          workerID,
          new Error(details || "mcp interaction unhealthy"),
        );
        return {
          ok: false,
          failures,
          reason: mcpHealth.reason,
          idleMs: mcpHealth.idleMs,
          pingPayload,
        };
      }
      this.clearWorkerControlProbeFailure(workerID);
      return { ok: true, pingPayload };
    } catch (error) {
      const failures = this.markWorkerControlProbeFailure(workerID, error);
      return { ok: false, failures, reason: "worker_control_probe_failed" };
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
    return this.pendingEventOrchestrator.trackPendingEvent(rawPayload);
  }

  async markPendingEventDelivered(eventID, binding) {
    return this.pendingEventOrchestrator.markPendingEventDelivered(eventID, binding);
  }

  async markPendingEventDispatching(eventID, binding) {
    return this.pendingEventOrchestrator.markPendingEventDispatching(eventID, binding);
  }

  async markPendingEventPending(eventID) {
    return this.pendingEventOrchestrator.markPendingEventPending(eventID);
  }

  async markPendingEventInterrupted(eventID) {
    return this.pendingEventOrchestrator.markPendingEventInterrupted(eventID);
  }

  async clearPendingEvent(eventID) {
    await this.pendingEventOrchestrator.clearPendingEvent(eventID);
  }

  listPendingEventsForSession(sessionID) {
    return this.pendingEventOrchestrator.listPendingEventsForSession(sessionID);
  }

  listPendingEvents() {
    return this.pendingEventOrchestrator.listPendingEvents();
  }

  getPendingEvent(eventID) {
    return this.pendingEventOrchestrator.getPendingEvent(eventID);
  }

  async touchPendingEventActivity(eventID) {
    return this.pendingEventOrchestrator.touchPendingEvent(eventID);
  }

  async handleWorkerSessionComposing(payload = {}) {
    const eventID = normalizeString(payload.ref_event_id);
    if (!eventID) {
      return null;
    }

    const workerID = normalizeString(payload.worker_id);
    const workerSessionID = normalizeString(payload.session_id || payload.aibot_session_id);
    const claudeSessionID = normalizeString(payload.claude_session_id);
    const reportedPid = Number(payload.pid ?? 0);

    const record = this.getPendingEvent(eventID);
    if (!record) {
      return null;
    }

    const deliveryState = normalizeString(record.delivery_state);
    if (deliveryState !== "dispatching" && deliveryState !== "delivered") {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "delivery_state_not_inflight",
        event_id: eventID,
        session_id: record.sessionID,
        delivery_state: deliveryState,
      }, "error");
      return null;
    }

    const sessionID = normalizeString(record.sessionID);
    if (workerSessionID && workerSessionID !== sessionID) {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "session_mismatch",
        event_id: eventID,
        expected_session_id: sessionID,
        reported_session_id: workerSessionID,
      }, "error");
      return null;
    }

    const binding = this.bindingRegistry.getByAibotSessionID(sessionID);
    if (!binding) {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "binding_not_found",
        event_id: eventID,
        session_id: sessionID,
      }, "error");
      return null;
    }

    const expectedWorkerID = normalizeString(binding.worker_id);
    if (!workerID || !expectedWorkerID || workerID !== expectedWorkerID) {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "worker_id_mismatch",
        event_id: eventID,
        session_id: sessionID,
        expected_worker_id: expectedWorkerID,
        reported_worker_id: workerID,
      }, "error");
      return null;
    }

    const expectedPid = resolveExpectedIdentityWorkerPid(binding);
    if (Number.isFinite(expectedPid) && expectedPid > 0) {
      if (!Number.isFinite(reportedPid) || reportedPid <= 0 || reportedPid !== expectedPid) {
        this.trace({
          stage: "pending_event_activity_rejected",
          reason: "worker_pid_mismatch",
          event_id: eventID,
          session_id: sessionID,
          expected_pid: expectedPid,
          reported_pid: reportedPid,
        }, "error");
        return null;
      }
    }

    const dispatchedWorkerID = normalizeString(record.last_worker_id);
    if (dispatchedWorkerID && workerID !== dispatchedWorkerID) {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "event_worker_mismatch",
        event_id: eventID,
        session_id: sessionID,
        expected_worker_id: dispatchedWorkerID,
        reported_worker_id: workerID,
      }, "error");
      return null;
    }

    const expectedClaudeSessionID = normalizeString(binding.claude_session_id);
    if (!claudeSessionID || !expectedClaudeSessionID || claudeSessionID !== expectedClaudeSessionID) {
      this.trace({
        stage: "pending_event_activity_rejected",
        reason: "claude_session_mismatch",
        event_id: eventID,
        session_id: sessionID,
        expected_claude_session_id: expectedClaudeSessionID,
        reported_claude_session_id: claudeSessionID,
      }, "error");
      return null;
    }

    const touched = await this.touchPendingEventActivity(eventID);
    if (!touched) {
      return null;
    }
    this.trace({
      stage: "pending_event_activity_touched",
      event_id: touched.eventID,
      session_id: touched.sessionID,
      worker_id: workerID,
      worker_pid: reportedPid,
      worker_session_id: workerSessionID,
      claude_session_id: claudeSessionID,
      active: Boolean(payload.active),
    }, "debug");
    return touched;
  }

  hasInFlightSessionEvent(sessionID, { excludeEventID = "" } = {}) {
    return this.pendingEventOrchestrator.hasInFlightSessionEvent(sessionID, {
      excludeEventID,
    });
  }

  async flushPendingSessionEvents(sessionID, binding) {
    return this.pendingEventOrchestrator.flushPendingSessionEvents(sessionID, binding);
  }

  async failPendingEvent(record, {
    notifyText = true,
    noticeText = buildInterruptedEventNotice(),
    replySource = "daemon_worker_interrupted",
    resultCode = "worker_interrupted",
    resultMessage = "worker interrupted while processing event",
  } = {}) {
    if (!record?.eventID || !record?.sessionID) {
      return;
    }
    if (notifyText) {
      try {
        await this.aibotClient.sendText({
          eventID: record.eventID,
          sessionID: record.sessionID,
          text: noticeText,
          quotedMessageID: record.msgID,
          extra: {
            reply_source: replySource,
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
        code: resultCode,
        msg: resultMessage,
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
      code: resultCode,
    }, "error");
  }

  async resolveWorkerFailureEventOptions(workerID) {
    const normalizedWorkerID = normalizeString(workerID);
    if (!normalizedWorkerID) {
      return null;
    }
    const hasAuthLoginRequiredError = await this.workerProcessManager?.hasAuthLoginRequiredError?.(
      normalizedWorkerID,
    );
    if (!hasAuthLoginRequiredError) {
      return null;
    }
    return {
      noticeText: buildAuthLoginRequiredEventNotice(),
      replySource: "daemon_worker_auth_login_required",
      resultCode: "claude_auth_login_required",
      resultMessage: "claude authentication expired; run claude auth login",
    };
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

    const previousBinding = this.bindingRegistry.getByAibotSessionID(sessionID) ?? binding;
    if (
      normalizeString(previousBinding?.worker_id) !== workerID
      || ["stopped", "failed"].includes(normalizeString(previousBinding?.worker_status))
    ) {
      return false;
    }

    const runtime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
    if (!runtime) {
      return false;
    }

    const pid = resolveExpectedWorkerPid(previousBinding, runtime);
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

    const probe = await this.probeWorkerControl(previousBinding, runtime);
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
        reason: probe.reason,
        idle_ms: probe.idleMs,
        expected_pid: probe.expectedPid,
        reported_pid: probe.reportedPid,
      }, "error");

      const nextBinding = await this.bindingRegistry.markWorkerStopped(sessionID, {
        updatedAt: Date.now(),
        lastStoppedAt: Date.now(),
      });
      await this.handleWorkerStatusUpdate(previousBinding, nextBinding);
      return true;
    }

    if (!probe.ok && probe.reason === "worker_control_probe_failed") {
      return false;
    }

    const latestMcpActivityAt = Number(probe?.pingPayload?.mcp_last_activity_at ?? 0);
    const timedOutMcpResults = this.listTimedOutMcpResultRecords(sessionID, Date.now(), {
      latestMcpActivityAt,
    });
    if (timedOutMcpResults.length > 0) {
      this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
        exitCode: Number(runtime?.exit_code ?? 0),
        exitSignal: "mcp_result_timeout",
      });
      this.trace({
        stage: "worker_mcp_result_timeout_detected",
        session_id: sessionID,
        worker_id: workerID,
        pid,
        previous_status: workerStatus,
        timeout_ms: this.mcpResultTimeoutMs,
        latest_mcp_activity_at: Number.isFinite(latestMcpActivityAt) ? latestMcpActivityAt : 0,
        timed_out_count: timedOutMcpResults.length,
        event_ids: timedOutMcpResults.map((record) => record.eventID).slice(0, 5),
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
      worker_pid: Number(nextBinding?.worker_pid ?? previousBinding?.worker_pid ?? 0),
      claude_session_id: nextBinding?.claude_session_id || previousBinding?.claude_session_id,
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

    const failureEventOptions = await this.resolveWorkerFailureEventOptions(
      previousWorkerID || nextWorkerID,
    );
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
      await this.failPendingEvent(record, failureEventOptions ?? undefined);
    }
  }

  async handleEventCompleted(eventID) {
    const record = this.getPendingEvent(eventID);
    const sessionID = normalizeString(record?.sessionID || this.messageDeliveryStore.getRememberedSessionID(eventID));
    await this.clearPendingEvent(eventID);
    this.trace({
      stage: "event_completed",
      event_id: eventID,
      session_id: sessionID,
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
      this.trace({
        stage: "worker_resume_missing_recovering",
        session_id: binding.aibot_session_id,
        worker_id: binding.worker_id,
        claude_session_id: binding.claude_session_id,
      }, "error");
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
      this.trace({
        stage: "worker_resume_missing_spawned_fresh",
        session_id: fallbackBinding.aibot_session_id,
        worker_id: workerID,
        claude_session_id: fallbackBinding.claude_session_id,
      }, "error");
      readyBinding = await this.waitForWorkerBridgeState(aibotSessionID, {
        timeoutMs: 15000,
      });
    }

    return readyBinding ?? binding;
  }

  async handleControlCommand(event, parsed) {
    return this.controlCommandHandler.handleControlCommand(event, parsed);
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
    const receivedAt = Date.now();
    const resolvedSessionID = normalizeString(rawPayload?.session_id)
      || this.messageDeliveryStore.getRememberedSessionID(eventID);
    this.aibotClient.ackEvent(eventID, {
      sessionID: resolvedSessionID,
      msgID: rawPayload?.msg_id,
      receivedAt,
    });
    this.trace({
      stage: "revoke_received",
      event_id: eventID,
      session_id: rawPayload?.session_id,
      msg_id: rawPayload?.msg_id,
    });
    const sessionID = resolvedSessionID;
    if (!sessionID) {
      this.trace({
        stage: "revoke_route_missing",
        event_id: eventID,
        msg_id: rawPayload?.msg_id,
      }, "error");
      return;
    }

    const revokeKey = buildRevokeDedupKey({
      eventID,
      sessionID,
      msgID: rawPayload?.msg_id,
    });
    if (this.hasRecentRevoke(eventID, receivedAt) || this.hasRecentRevoke(revokeKey, receivedAt)) {
      this.trace({
        stage: "revoke_duplicate_skipped",
        event_id: eventID,
        session_id: sessionID,
        msg_id: rawPayload?.msg_id,
      });
      return;
    }
    await this.rememberRecentRevoke(revokeKey, receivedAt);
    await this.rememberRecentRevoke(eventID, receivedAt);

    await this.deliverWithRecovery(sessionID, rawPayload, this.deliverRevokeToWorker);
    this.trace({
      stage: "revoke_forwarded",
      event_id: eventID,
      session_id: sessionID,
      msg_id: rawPayload?.msg_id,
    });
  }
}
