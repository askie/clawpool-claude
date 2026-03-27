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
import { summarizeHookSignalEvent } from "../hook-signal-store.js";
import {
  canDeliverToWorker,
  formatWorkerResponseAssessment,
  hasReadyWorkerBridge,
  needsWorkerProbe,
  normalizeWorkerResponseState,
} from "./worker-state.js";
import {
  buildWorkerPingProbePayload,
  defaultWorkerPingProbeTimeoutMs,
  isExpectedWorkerProbeReply,
} from "../worker-probe.js";

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
  const lines = [
    `Aibot 会话: ${binding.aibot_session_id}`,
    `Claude 会话: ${binding.claude_session_id}`,
    `目录: ${binding.cwd}`,
    `Worker 状态: ${binding.worker_status}`,
    `可用性评估: ${formatWorkerResponseAssessment(binding)}`,
  ];
  const responseReason = normalizeString(binding?.worker_response_reason);
  if (responseReason) {
    lines.push(`评估原因: ${responseReason}`);
  }
  const lastReplyAt = formatStatusTimestamp(binding?.worker_last_reply_at);
  if (lastReplyAt) {
    lines.push(`最近成功: ${lastReplyAt}`);
  }
  const lastFailureAt = formatStatusTimestamp(binding?.worker_last_failure_at);
  if (lastFailureAt) {
    const failureCode = normalizeString(binding?.worker_last_failure_code);
    lines.push(`最近失败: ${lastFailureAt}${failureCode ? ` (${failureCode})` : ""}`);
  }
  const lastHookAt = formatStatusTimestamp(binding?.worker_last_hook_event_at);
  if (lastHookAt) {
    const lastHookSummary = summarizeHookSignalEvent({
      event_id: binding?.worker_last_hook_event_id,
      hook_event_name: binding?.worker_last_hook_event_name,
      event_at: binding?.worker_last_hook_event_at,
      detail: binding?.worker_last_hook_event_detail,
    });
    if (lastHookSummary) {
      lines.push(`最近 Hook: ${lastHookSummary} @ ${lastHookAt}`);
    }
  }
  return lines.join("\n");
}

function buildInterruptedEventNotice() {
  return "Claude 刚刚中断了，这条消息没有处理完成。请再发一次。";
}

function buildAuthLoginRequiredEventNotice() {
  return "Claude 登录已失效，请在电脑上执行 claude auth login 后重试。";
}

function buildWorkerStartupFailedNotice() {
  return "Claude 启动未完成，消息未发送。请执行 clawpool-claude restart 后重试。";
}

function buildMissingBindingCardOptions() {
  return {
    summaryText: "当前会话还没有绑定目录。",
    detailText: "发送 open <目录> 来创建会话。",
  };
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

function formatStatusTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return new Date(numeric).toISOString();
}

function normalizeHookSignalRecord(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const eventID = normalizeString(input.event_id);
  const eventName = normalizeString(input.hook_event_name);
  const eventAt = Number(input.event_at ?? 0);
  if (!eventID || !eventName || !Number.isFinite(eventAt) || eventAt <= 0) {
    return null;
  }
  return {
    event_id: eventID,
    hook_event_name: eventName,
    event_at: Math.floor(eventAt),
    detail: normalizeString(input.detail),
  };
}

function listHookSignalRecords(pingPayload) {
  const recentEvents = Array.isArray(pingPayload?.hook_recent_events)
    ? pingPayload.hook_recent_events
    : [];
  const latestEvent = pingPayload?.hook_latest_event;
  const deduped = new Map();
  for (const event of [...recentEvents, latestEvent]) {
    const normalized = normalizeHookSignalRecord(event);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.event_id, normalized);
  }
  return Array.from(deduped.values()).sort((left, right) => {
    if (left.event_at !== right.event_at) {
      return left.event_at - right.event_at;
    }
    return left.event_id.localeCompare(right.event_id);
  });
}

const defaultDeliveredInFlightMaxAgeMs = 60 * 1000;
const defaultWorkerControlProbeFailureThreshold = 3;
const defaultMcpInteractionIdleMs = 5 * 60 * 1000;
const defaultMcpResultTimeoutMs = 12 * 60 * 1000;
const defaultRecentRevokeRetentionMs = 24 * 60 * 60 * 1000;
const defaultAuthFailureCooldownMs = 60 * 1000;
const defaultWorkerPingProbeRetentionMs = 60 * 1000;
const workerResponseFailureCodes = new Set([
  "claude_result_timeout",
  "channel_notification_failed",
]);

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

function classifyWorkerEventResult(payload) {
  const code = normalizeString(payload?.code);
  if (workerResponseFailureCodes.has(code)) {
    return {
      state: "failed",
      reason: code,
      failureCode: code,
    };
  }
  return {
    state: "healthy",
    reason: code || normalizeString(payload?.status) || "worker_event_result_observed",
    failureCode: "",
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
    deliveredInFlightMaxAgeMs = null,
    workerControlProbeFailureThreshold = defaultWorkerControlProbeFailureThreshold,
    mcpInteractionIdleMs = defaultMcpInteractionIdleMs,
    mcpResultTimeoutMs = defaultMcpResultTimeoutMs,
    recentRevokeRetentionMs = defaultRecentRevokeRetentionMs,
    authFailureCooldownMs = defaultAuthFailureCooldownMs,
    workerPingProbeTimeoutMs = defaultWorkerPingProbeTimeoutMs,
    workerPingProbeRetentionMs = defaultWorkerPingProbeRetentionMs,
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
    this.authFailureCooldownMs = normalizeNonNegativeInt(
      authFailureCooldownMs ?? env.CLAWPOOL_CLAUDE_AUTH_FAILURE_COOLDOWN_MS,
      defaultAuthFailureCooldownMs,
    );
    this.workerPingProbeTimeoutMs = normalizeNonNegativeInt(
      workerPingProbeTimeoutMs ?? env.CLAWPOOL_CLAUDE_WORKER_PING_PROBE_TIMEOUT_MS,
      defaultWorkerPingProbeTimeoutMs,
    );
    this.workerPingProbeRetentionMs = normalizeNonNegativeInt(
      workerPingProbeRetentionMs ?? env.CLAWPOOL_CLAUDE_WORKER_PING_PROBE_RETENTION_MS,
      defaultWorkerPingProbeRetentionMs,
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
    this.workerPingProbeRecords = new Map();
    this.workerPingProbeInFlight = new Map();
    this.ensureWorkerInFlight = new Map();
    this.resumeAuthRecoveryInFlight = new Map();
    this.lastAuthRecoverySpawnAt = new Map();
    this.controlCommandHandler = new DaemonControlCommandHandler({
      env: this.env,
      bindingRegistry: this.bindingRegistry,
      workerProcessManager: this.workerProcessManager,
      bridgeServer: this.bridgeServer,
      ensureWorker: async (...args) => this.ensureWorker(...args),
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

  getWorkerPingProbeRecord(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return null;
    }
    return this.workerPingProbeRecords.get(normalizedEventID) ?? null;
  }

  clearWorkerPingProbeRecord(eventID) {
    const normalizedEventID = normalizeString(eventID);
    if (!normalizedEventID) {
      return;
    }
    const record = this.workerPingProbeRecords.get(normalizedEventID);
    if (!record) {
      return;
    }
    if (record.timeoutTimer) {
      clearTimeout(record.timeoutTimer);
    }
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
    }
    this.workerPingProbeRecords.delete(normalizedEventID);
  }

  scheduleWorkerPingProbeRecordCleanup(eventID, retentionMs = this.workerPingProbeRetentionMs) {
    const record = this.getWorkerPingProbeRecord(eventID);
    if (!record) {
      return;
    }
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
    }
    if (retentionMs <= 0) {
      this.clearWorkerPingProbeRecord(eventID);
      return;
    }
    record.cleanupTimer = setTimeout(() => {
      this.clearWorkerPingProbeRecord(eventID);
    }, retentionMs);
    record.cleanupTimer.unref?.();
  }

  async updateWorkerPingProbeOutcome(record, {
    state,
    reason,
    failureCode = "",
    payload = {},
    level = "info",
  } = {}) {
    if (!record || record.settled) {
      return this.bindingRegistry.getByAibotSessionID(record?.sessionID);
    }
    record.settled = true;
    if (record.timeoutTimer) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = null;
    }

    const observedAt = Date.now();
    const nextBinding = state === "healthy"
      ? await this.bindingRegistry.markWorkerHealthy(record.sessionID, {
          observedAt,
          reason,
          lastReplyAt: observedAt,
        })
      : await this.bindingRegistry.markWorkerResponseFailed(record.sessionID, {
          observedAt,
          reason,
          failureCode,
        });

    record.state = state;
    record.binding = nextBinding;
    record.completedAt = observedAt;

    this.trace({
      stage: state === "healthy" ? "worker_ping_probe_succeeded" : "worker_ping_probe_failed",
      session_id: record.sessionID,
      worker_id: record.workerID,
      claude_session_id: record.claudeSessionID,
      event_id: record.eventID,
      response_state: nextBinding?.worker_response_state,
      response_reason: nextBinding?.worker_response_reason,
      terminal_status: normalizeString(payload?.status),
      terminal_code: normalizeString(payload?.code),
      probe_text: normalizeString(payload?.text),
    }, level);

    this.scheduleWorkerPingProbeRecordCleanup(record.eventID);
    record.resolve?.(nextBinding);
    record.resolve = null;
    return nextBinding;
  }

  async ensureWorkerPingProbe(binding) {
    const sessionID = normalizeString(binding?.aibot_session_id);
    if (!sessionID) {
      return binding;
    }
    if (canDeliverToWorker(binding) || !needsWorkerProbe(binding)) {
      return binding;
    }
    const inFlight = this.workerPingProbeInFlight.get(sessionID);
    if (inFlight) {
      return inFlight;
    }

    const probePromise = this.runWorkerPingProbe(binding);
    this.workerPingProbeInFlight.set(sessionID, probePromise);
    try {
      return await probePromise;
    } finally {
      if (this.workerPingProbeInFlight.get(sessionID) === probePromise) {
        this.workerPingProbeInFlight.delete(sessionID);
      }
    }
  }

  async runWorkerPingProbe(binding) {
    const sessionID = normalizeString(binding?.aibot_session_id);
    if (!sessionID || !hasReadyWorkerBridge(binding)) {
      return binding;
    }

    let client = null;
    try {
      client = this.workerControlClientFactory(binding);
    } catch (error) {
      this.trace({
        stage: "worker_ping_probe_client_failed",
        session_id: sessionID,
        worker_id: binding?.worker_id,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      return this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: "worker_ping_probe_client_failed",
        failureCode: "worker_ping_probe_client_failed",
      });
    }

    if (!client?.isConfigured?.() || typeof client.deliverEvent !== "function") {
      return this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: "worker_ping_probe_unavailable",
        failureCode: "worker_ping_probe_unavailable",
      });
    }

    const probingBinding = await this.bindingRegistry.markWorkerProbing(sessionID, {
      observedAt: Date.now(),
      reason: "worker_ping_probe_requested",
    });
    const probePayload = buildWorkerPingProbePayload({
      sessionID,
      workerID: probingBinding?.worker_id,
      claudeSessionID: probingBinding?.claude_session_id,
    });

    const record = {
      eventID: probePayload.event_id,
      sessionID,
      workerID: normalizeString(probingBinding?.worker_id),
      claudeSessionID: normalizeString(probingBinding?.claude_session_id),
      expectedReply: "pong",
      state: "probing",
      settled: false,
      resolve: null,
      timeoutTimer: null,
      cleanupTimer: null,
      timeoutRecovering: false,
      binding: probingBinding,
    };
    const probeResult = new Promise((resolve) => {
      record.resolve = resolve;
    });
    record.timeoutTimer = setTimeout(() => {
      void this.handleWorkerPingProbeTimeout(record, client);
    }, this.workerPingProbeTimeoutMs);
    record.timeoutTimer.unref?.();
    this.workerPingProbeRecords.set(record.eventID, record);

    this.trace({
      stage: "worker_ping_probe_requested",
      session_id: sessionID,
      worker_id: record.workerID,
      claude_session_id: record.claudeSessionID,
      event_id: record.eventID,
      timeout_ms: this.workerPingProbeTimeoutMs,
    });

    try {
      await client.deliverEvent(probePayload);
    } catch (error) {
      return this.updateWorkerPingProbeOutcome(record, {
        state: "failed",
        reason: "worker_ping_probe_delivery_failed",
        failureCode: "worker_ping_probe_delivery_failed",
        level: "error",
      });
    }

    return probeResult;
  }

  async recoverWorkerPingProbeTimeout(record, client) {
    if (record?.settled) {
      return null;
    }
    if (!client?.isConfigured?.() || typeof client.ping !== "function") {
      return null;
    }

    const currentBinding = this.bindingRegistry.getByAibotSessionID(record?.sessionID);
    if (!currentBinding || !hasReadyWorkerBridge(currentBinding)) {
      return null;
    }

    const expectedWorkerID = normalizeString(record?.workerID);
    const expectedClaudeSessionID = normalizeString(record?.claudeSessionID);
    const currentWorkerID = normalizeString(currentBinding?.worker_id);
    const currentClaudeSessionID = normalizeString(currentBinding?.claude_session_id);
    if (expectedWorkerID && currentWorkerID && expectedWorkerID !== currentWorkerID) {
      return null;
    }
    if (
      expectedClaudeSessionID
      && currentClaudeSessionID
      && expectedClaudeSessionID !== currentClaudeSessionID
    ) {
      return null;
    }

    let pingPayload = null;
    try {
      pingPayload = await client.ping();
    } catch (error) {
      this.trace({
        stage: "worker_ping_probe_timeout_control_ping_failed",
        session_id: record?.sessionID,
        worker_id: currentWorkerID || expectedWorkerID,
        claude_session_id: currentClaudeSessionID || expectedClaudeSessionID,
        event_id: record?.eventID,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      return null;
    }
    if (record?.settled) {
      return this.bindingRegistry.getByAibotSessionID(record?.sessionID);
    }

    const runtime = this.workerProcessManager?.getWorkerRuntime?.(currentWorkerID);
    const identityHealth = this.inspectWorkerIdentityHealth(currentBinding, runtime, pingPayload);
    if (!identityHealth.ok) {
      this.trace({
        stage: "worker_ping_probe_timeout_control_ping_identity_mismatch",
        session_id: record?.sessionID,
        worker_id: currentWorkerID || expectedWorkerID,
        claude_session_id: currentClaudeSessionID || expectedClaudeSessionID,
        event_id: record?.eventID,
        reason: identityHealth.reason,
      }, "error");
      return null;
    }

    await this.recordWorkerHookSignalsObserved(currentBinding, pingPayload);
    this.trace({
      stage: "worker_ping_probe_timeout_recovered",
      session_id: record?.sessionID,
      worker_id: currentWorkerID || expectedWorkerID,
      claude_session_id: currentClaudeSessionID || expectedClaudeSessionID,
      event_id: record?.eventID,
    });
    return this.updateWorkerPingProbeOutcome(record, {
      state: "healthy",
      reason: "worker_ping_probe_timeout_control_ping_ok",
      payload: {
        status: "responded",
        code: "worker_ping_probe_timeout_control_ping_ok",
      },
    });
  }

  async handleWorkerPingProbeTimeout(record, client) {
    if (record?.settled) {
      return null;
    }
    record.timeoutRecovering = true;
    const recoveredBinding = await this.recoverWorkerPingProbeTimeout(record, client)
      .finally(() => {
        record.timeoutRecovering = false;
      });
    if (canDeliverToWorker(recoveredBinding)) {
      return recoveredBinding;
    }

    return this.updateWorkerPingProbeOutcome(record, {
      state: "failed",
      reason: "worker_ping_probe_timeout",
      failureCode: "worker_ping_probe_timeout",
      level: "error",
    });
  }

  async observeWorkerPingProbeReply(payload) {
    const record = this.getWorkerPingProbeRecord(payload?.event_id);
    if (!record) {
      return { handled: false, ack: null };
    }
    if (record.settled) {
      return { handled: true, ack: { msg_id: `probe_${record.eventID}` } };
    }

    const replyText = normalizeString(payload?.text);
    if (isExpectedWorkerProbeReply(replyText, record.expectedReply)) {
      await this.updateWorkerPingProbeOutcome(record, {
        state: "healthy",
        reason: "worker_ping_pong_observed",
        payload,
      });
    } else {
      await this.updateWorkerPingProbeOutcome(record, {
        state: "failed",
        reason: "worker_ping_probe_wrong_reply",
        failureCode: "worker_ping_probe_wrong_reply",
        payload,
        level: "error",
      });
    }

    return { handled: true, ack: { msg_id: `probe_${record.eventID}` } };
  }

  async observeWorkerPingProbeEventResult(payload) {
    const record = this.getWorkerPingProbeRecord(payload?.event_id);
    if (!record) {
      return { handled: false };
    }

    if (!record.settled) {
      const status = normalizeString(payload?.status);
      const code = normalizeString(payload?.code);
      if (record.timeoutRecovering && status !== "responded" && code === "claude_result_timeout") {
        this.trace({
          stage: "worker_ping_probe_event_result_ignored_timeout_during_recovery",
          session_id: record.sessionID,
          worker_id: record.workerID,
          claude_session_id: record.claudeSessionID,
          event_id: record.eventID,
          terminal_status: status,
          terminal_code: code,
        });
        return { handled: true };
      }
      await this.updateWorkerPingProbeOutcome(record, {
        state: "failed",
        reason: status === "responded"
          ? "worker_ping_probe_missing_pong"
          : code || "worker_ping_probe_failed",
        failureCode: code || (
          status === "responded"
            ? "worker_ping_probe_missing_pong"
            : "worker_ping_probe_failed"
        ),
        payload,
        level: "error",
      });
    } else {
      this.scheduleWorkerPingProbeRecordCleanup(record.eventID);
    }

    return { handled: true };
  }

  async close() {
    if (this.workerRuntimeHealthCheckTimer) {
      clearInterval(this.workerRuntimeHealthCheckTimer);
      this.workerRuntimeHealthCheckTimer = null;
    }
    this.workerControlProbeFailures.clear();
    for (const eventID of this.workerPingProbeRecords.keys()) {
      this.clearWorkerPingProbeRecord(eventID);
    }
    this.workerPingProbeInFlight.clear();
    this.ensureWorkerInFlight.clear();
    this.resumeAuthRecoveryInFlight.clear();
    this.lastAuthRecoverySpawnAt.clear();
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

  resolveAuthFailureRetryBlock(binding, { now = Date.now() } = {}) {
    if (this.authFailureCooldownMs <= 0) {
      return null;
    }

    const normalizedStatus = normalizeString(binding?.worker_status);
    if (normalizedStatus !== "stopped" && normalizedStatus !== "failed") {
      return null;
    }

    const workerID = normalizeString(binding?.worker_id);
    if (!workerID) {
      return null;
    }

    const runtime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
    if (normalizeString(runtime?.status) !== "stopped") {
      return null;
    }
    if (normalizeString(runtime?.exit_signal) !== "auth_login_required") {
      return null;
    }

    const runtimeStoppedAt = Number(runtime?.stopped_at ?? 0);
    const bindingStoppedAt = Number(binding?.last_stopped_at ?? 0);
    const lastStoppedAt = Math.max(
      Number.isFinite(runtimeStoppedAt) ? runtimeStoppedAt : 0,
      Number.isFinite(bindingStoppedAt) ? bindingStoppedAt : 0,
    );
    if (lastStoppedAt <= 0) {
      return null;
    }

    const remainingMs = (lastStoppedAt + this.authFailureCooldownMs) - now;
    if (remainingMs <= 0) {
      return null;
    }

    return {
      workerID,
      remainingMs,
      lastStoppedAt,
    };
  }

  async ensureWorker(binding, { ignoreAuthCooldown = false } = {}) {
    const sessionID = normalizeString(binding?.aibot_session_id);
    if (!sessionID) {
      return null;
    }
    const inFlight = this.ensureWorkerInFlight.get(sessionID);
    if (inFlight) {
      this.trace({
        stage: "worker_ensure_coalesced",
        session_id: sessionID,
        worker_id: binding?.worker_id,
      });
      return inFlight;
    }

    const ensurePromise = this.ensureWorkerInternal(binding, { ignoreAuthCooldown });
    this.ensureWorkerInFlight.set(sessionID, ensurePromise);
    try {
      return await ensurePromise;
    } finally {
      if (this.ensureWorkerInFlight.get(sessionID) === ensurePromise) {
        this.ensureWorkerInFlight.delete(sessionID);
      }
    }
  }

  async ensureWorkerInternal(binding, { ignoreAuthCooldown = false } = {}) {
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

    if (
      hasReadyWorkerBridge(binding)
      && normalizeWorkerResponseState(binding?.worker_response_state) !== "failed"
    ) {
      this.trace({
        stage: "worker_reused_pending_probe",
        session_id: binding.aibot_session_id,
        worker_id: binding.worker_id,
        worker_pid: binding.worker_pid,
        status: binding.worker_status,
        response_state: binding.worker_response_state,
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
      if (
        hasReadyWorkerBridge(current)
        && normalizeWorkerResponseState(current?.worker_response_state) !== "failed"
      ) {
        this.trace({
          stage: "worker_reused_after_wait_pending_probe",
          session_id: binding.aibot_session_id,
          worker_id: current.worker_id,
          worker_pid: current.worker_pid,
          status: current.worker_status,
          response_state: current.worker_response_state,
        });
        return {
          worker_id: current.worker_id,
          status: current.worker_status,
        };
      }
      const currentReadyFailed = (
        hasReadyWorkerBridge(current)
        && normalizeWorkerResponseState(current?.worker_response_state) === "failed"
      );
      const workerID = normalizeString(binding.worker_id);
      if (!currentReadyFailed && workerID) {
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

    const authRetryBlock = ignoreAuthCooldown
      ? null
      : this.resolveAuthFailureRetryBlock(binding);
    if (authRetryBlock) {
      this.trace({
        stage: "worker_spawn_blocked_auth_cooldown",
        session_id: binding.aibot_session_id,
        worker_id: authRetryBlock.workerID,
        remaining_ms: authRetryBlock.remainingMs,
        cooldown_ms: this.authFailureCooldownMs,
        last_stopped_at: authRetryBlock.lastStoppedAt,
      }, "error");
      return {
        worker_id: authRetryBlock.workerID,
        status: "stopped",
      };
    }

    const workerID = normalizeWorkerResponseState(binding?.worker_response_state) === "failed"
      ? randomUUID()
      : (binding.worker_id || randomUUID());
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

  async resolveWorkerLaunchFailure(binding) {
    const workerID = normalizeString(binding?.worker_id);
    const workerStatus = normalizeString(binding?.worker_status);
    if (!workerID || !["starting", "connected"].includes(workerStatus)) {
      return "";
    }
    if (await this.workerProcessManager?.hasMissingResumeSessionError?.(workerID)) {
      return "resume_session_missing";
    }
    const hasBlockingMcpStartupFailure = typeof this.workerProcessManager?.hasStartupBlockingMcpServerFailure === "function"
      ? await this.workerProcessManager.hasStartupBlockingMcpServerFailure(workerID)
      : await this.workerProcessManager?.hasStartupMcpServerFailed?.(workerID);
    if (hasBlockingMcpStartupFailure) {
      return "startup_mcp_server_failed";
    }
    return "";
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
      if (hasReadyWorkerBridge(current)) {
        const launchFailure = await this.resolveWorkerLaunchFailure(current);
        if (launchFailure) {
          return withWorkerLaunchFailure(current, launchFailure);
        }
        return current;
      }
      const launchFailure = await this.resolveWorkerLaunchFailure(current);
      if (launchFailure) {
        return withWorkerLaunchFailure(current, launchFailure);
      }
      if (current.worker_status === "stopped" || current.worker_status === "failed") {
        return current;
      }
      await sleep(intervalMs);
    }
    const current = this.bindingRegistry.getByAibotSessionID(aibotSessionID);
    const launchFailure = await this.resolveWorkerLaunchFailure(current);
    if (launchFailure) {
      return withWorkerLaunchFailure(current, launchFailure);
    }
    if (["starting", "connected"].includes(normalizeString(current?.worker_status))) {
      return withWorkerLaunchFailure(current, "startup_wait_timeout");
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

  resolveObservedSessionID(payload = {}) {
    const explicitSessionID = normalizeString(payload?.session_id);
    if (explicitSessionID) {
      return explicitSessionID;
    }
    return normalizeString(this.messageDeliveryStore.getRememberedSessionID(payload?.event_id));
  }

  shouldIgnoreObservedWorker(binding, payload = {}) {
    if (!binding) {
      return false;
    }
    const observedWorkerID = normalizeString(payload?.worker_id);
    if (
      observedWorkerID
      && normalizeString(binding?.worker_id)
      && observedWorkerID !== normalizeString(binding.worker_id)
    ) {
      return true;
    }
    const observedClaudeSessionID = normalizeString(payload?.claude_session_id);
    if (
      observedClaudeSessionID
      && normalizeString(binding?.claude_session_id)
      && observedClaudeSessionID !== normalizeString(binding.claude_session_id)
    ) {
      return true;
    }
    return false;
  }

  traceWorkerObservationIgnored(stage, binding, payload = {}) {
    this.trace({
      stage,
      event_id: payload?.event_id,
      session_id: this.resolveObservedSessionID(payload),
      worker_id: normalizeString(payload?.worker_id),
      expected_worker_id: normalizeString(binding?.worker_id),
      claude_session_id: normalizeString(payload?.claude_session_id),
      expected_claude_session_id: normalizeString(binding?.claude_session_id),
    }, "error");
  }

  async recordWorkerReplyObserved(payload, { kind = "text" } = {}) {
    const sessionID = this.resolveObservedSessionID(payload);
    if (!sessionID) {
      return null;
    }
    const binding = this.bindingRegistry.getByAibotSessionID(sessionID);
    if (!binding) {
      return null;
    }
    if (this.shouldIgnoreObservedWorker(binding, payload)) {
      this.traceWorkerObservationIgnored("worker_reply_observation_ignored_stale", binding, payload);
      return binding;
    }
    const observedAt = Date.now();
    const nextBinding = await this.bindingRegistry.markWorkerHealthy(sessionID, {
      observedAt,
      reason: kind === "media" ? "worker_media_reply_observed" : "worker_text_reply_observed",
      lastReplyAt: observedAt,
    });
    this.trace({
      stage: "worker_response_state_updated",
      session_id: sessionID,
      worker_id: nextBinding?.worker_id,
      response_state: nextBinding?.worker_response_state,
      response_reason: nextBinding?.worker_response_reason,
      event_id: payload?.event_id,
      response_kind: kind,
    });
    return nextBinding;
  }

  async recordWorkerEventResultObserved(payload) {
    const sessionID = this.resolveObservedSessionID(payload);
    if (!sessionID) {
      return null;
    }
    const binding = this.bindingRegistry.getByAibotSessionID(sessionID);
    if (!binding) {
      return null;
    }
    if (this.shouldIgnoreObservedWorker(binding, payload)) {
      this.traceWorkerObservationIgnored("worker_event_result_ignored_stale", binding, payload);
      return binding;
    }
    const observedAt = Date.now();
    const classification = classifyWorkerEventResult(payload);
    const nextBinding = classification.state === "failed"
      ? await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
          observedAt,
          reason: classification.reason,
          failureCode: classification.failureCode,
        })
      : await this.bindingRegistry.markWorkerHealthy(sessionID, {
          observedAt,
          reason: classification.reason,
        });
    this.trace({
      stage: "worker_response_state_updated",
      session_id: sessionID,
      worker_id: nextBinding?.worker_id,
      response_state: nextBinding?.worker_response_state,
      response_reason: nextBinding?.worker_response_reason,
      event_id: payload?.event_id,
      terminal_status: normalizeString(payload?.status),
      terminal_code: normalizeString(payload?.code),
    }, classification.state === "failed" ? "error" : "info");
    return nextBinding;
  }

  async recordWorkerHookSignalsObserved(binding, pingPayload) {
    const sessionID = normalizeString(binding?.aibot_session_id);
    if (!sessionID) {
      return binding;
    }

    let nextBinding = binding;
    let lastEventAt = Number(binding?.worker_last_hook_event_at ?? 0);
    let lastEventID = normalizeString(binding?.worker_last_hook_event_id);
    for (const event of listHookSignalRecords(pingPayload)) {
      const isNewer = event.event_at > lastEventAt
        || (event.event_at === lastEventAt && event.event_id !== lastEventID);
      if (!isNewer) {
        continue;
      }
      nextBinding = await this.bindingRegistry.markWorkerHookObserved(sessionID, {
        eventID: event.event_id,
        eventName: event.hook_event_name,
        eventDetail: event.detail,
        eventAt: event.event_at,
      });
      lastEventAt = event.event_at;
      lastEventID = event.event_id;
      this.trace({
        stage: "worker_hook_signal_observed",
        session_id: sessionID,
        worker_id: nextBinding?.worker_id,
        hook_event_id: event.event_id,
        hook_event_name: event.hook_event_name,
        hook_detail: event.detail,
        hook_event_at: event.event_at,
      });
    }

    return nextBinding;
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
      await this.recordWorkerHookSignalsObserved(binding, pingPayload);
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
    return this.pendingEventOrchestrator.clearPendingEvent(eventID);
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

  async touchPendingEventComposingActivity(eventID) {
    return this.pendingEventOrchestrator.touchPendingEventComposing(eventID);
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

    const active = Boolean(payload.active);
    const nextRecord = active
      ? (await this.touchPendingEventComposingActivity(record.eventID)) ?? record
      : record;

    this.trace({
      stage: "pending_event_activity_observed",
      event_id: nextRecord.eventID,
      session_id: nextRecord.sessionID,
      worker_id: workerID,
      worker_pid: reportedPid,
      worker_session_id: workerSessionID,
      claude_session_id: claudeSessionID,
      active,
    }, "debug");
    return nextRecord;
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
    const cleared = await this.clearPendingEvent(record.eventID);
    if (!cleared) {
      return; // Already cleared by a concurrent handler execution
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

  async requeuePendingEventsForWorker(sessionID, workerID) {
    const normalizedSessionID = normalizeString(sessionID);
    const normalizedWorkerID = normalizeString(workerID);
    if (!normalizedSessionID || !normalizedWorkerID) {
      return 0;
    }

    let requeuedCount = 0;
    const requeuedEventIDs = [];
    for (const record of this.listPendingEventsForSession(normalizedSessionID)) {
      if (normalizeString(record.last_worker_id) !== normalizedWorkerID) {
        continue;
      }
      const deliveryState = normalizeString(record.delivery_state);
      if (!["dispatching", "delivered", "interrupted"].includes(deliveryState)) {
        continue;
      }
      const nextRecord = await this.markPendingEventPending(record.eventID);
      if (!nextRecord) {
        continue;
      }
      requeuedCount += 1;
      requeuedEventIDs.push(record.eventID);
    }
    if (requeuedCount > 0) {
      this.trace({
        stage: "pending_events_requeued",
        session_id: normalizedSessionID,
        worker_id: normalizedWorkerID,
        count: requeuedCount,
        event_ids: requeuedEventIDs.slice(0, 5),
      }, "error");
    }
    return requeuedCount;
  }

  async tryRecoverResumeAuthFailure(previousBinding, nextBinding) {
    const sessionID = normalizeString(nextBinding?.aibot_session_id || previousBinding?.aibot_session_id);
    const workerID = normalizeString(previousBinding?.worker_id || nextBinding?.worker_id);
    if (!sessionID || !workerID) {
      return false;
    }
    const inFlightRecovery = this.resumeAuthRecoveryInFlight.get(sessionID);
    if (inFlightRecovery) {
      this.trace({
        stage: "worker_resume_auth_recovery_coalesced",
        session_id: sessionID,
        worker_id: workerID,
      }, "error");
      return inFlightRecovery;
    }

    const recoveryPromise = (async () => {
      const runtime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
      if (!runtime) {
        return false;
      }
      const hasAuthLoginRequiredError = await this.workerProcessManager?.hasAuthLoginRequiredError?.(workerID);
      if (!hasAuthLoginRequiredError) {
        return false;
      }

      // For fresh workers (resume_session=false), only attempt recovery if
      // the worker is very young (< 5s). Older fresh workers that hit auth
      // errors are expected to be handled by the normal fail path.
      // Workers without a known started_at timestamp are treated as old.
      const isResumeWorker = Boolean(runtime?.resume_session);
      const runtimeStartedAt = Number(runtime?.started_at ?? 0);
      const workerAgeMs = runtimeStartedAt > 0 ? Date.now() - runtimeStartedAt : Infinity;
      if (!isResumeWorker && workerAgeMs > 5000) {
        return false;
      }

      // Guard: limit repeated recovery spawns for the same session.
      const lastSpawnAt = this.lastAuthRecoverySpawnAt.get(sessionID) ?? 0;
      const authCooldownMs = this.authFailureCooldownMs || defaultAuthFailureCooldownMs;
      if (lastSpawnAt > 0 && (Date.now() - lastSpawnAt) < authCooldownMs) {
        this.trace({
          stage: "worker_resume_auth_recovery_cooldown",
          session_id: sessionID,
          worker_id: workerID,
          elapsed_ms: Date.now() - lastSpawnAt,
          cooldown_ms: authCooldownMs,
        }, "error");
        return false;
      }

      this.trace({
        stage: "worker_resume_auth_recovering",
        session_id: sessionID,
        worker_id: workerID,
        claude_session_id: previousBinding?.claude_session_id || nextBinding?.claude_session_id,
      }, "error");
      await this.requeuePendingEventsForWorker(sessionID, workerID);

      const latestBinding = this.bindingRegistry.getByAibotSessionID(sessionID) ?? nextBinding ?? previousBinding;
      if (!latestBinding) {
        return false;
      }
      const fallbackBinding = await this.rotateClaudeSession(latestBinding);
      const nextWorkerID = normalizeString(nextBinding?.worker_id) || workerID || randomUUID();
      await this.bindingRegistry.markWorkerStarting(sessionID, {
        workerID: nextWorkerID,
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      this.lastAuthRecoverySpawnAt.set(sessionID, Date.now());
      await this.workerProcessManager.spawnWorker({
        aibotSessionID: sessionID,
        cwd: fallbackBinding.cwd,
        pluginDataDir: fallbackBinding.plugin_data_dir,
        claudeSessionID: fallbackBinding.claude_session_id,
        workerID: nextWorkerID,
        bridgeURL: this.bridgeServer.getURL(),
        bridgeToken: this.bridgeServer.token,
        resumeSession: false,
      });
      this.trace({
        stage: "worker_resume_auth_spawned_fresh",
        session_id: sessionID,
        worker_id: nextWorkerID,
        claude_session_id: fallbackBinding.claude_session_id,
      }, "error");
      return true;
    })();

    this.resumeAuthRecoveryInFlight.set(sessionID, recoveryPromise);
    try {
      return await recoveryPromise;
    } finally {
      if (this.resumeAuthRecoveryInFlight.get(sessionID) === recoveryPromise) {
        this.resumeAuthRecoveryInFlight.delete(sessionID);
      }
    }
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

    const hasAuthError = await this.workerProcessManager?.hasAuthLoginRequiredError?.(workerID);
    if (hasAuthError) {
      // Skip auth error handling if this worker was recently spawned by a
      // recovery to avoid killing the fresh process before it stabilises.
      const lastSpawnAt = this.lastAuthRecoverySpawnAt.get(sessionID) ?? 0;
      const runtime = this.workerProcessManager?.getWorkerRuntime?.(workerID);
      const runtimeStartedAt = Number(runtime?.started_at ?? 0);
      const workerAgeMs = runtimeStartedAt > 0 ? Date.now() - runtimeStartedAt : 0;
      if (lastSpawnAt > 0 && workerAgeMs < 5000) {
        this.trace({
          stage: "worker_auth_error_skipped_recent_spawn",
          session_id: sessionID,
          worker_id: workerID,
          worker_age_ms: workerAgeMs,
        }, "error");
        return false;
      }

      const authRuntime = runtime;
      const authExitSignal = authRuntime?.resume_session
        ? "auth_login_required_resume"
        : "auth_login_required";
      this.trace({
        stage: "worker_auth_error_detected",
        session_id: sessionID,
        worker_id: workerID,
        worker_status: workerStatus,
        resume_session: Boolean(authRuntime?.resume_session),
      }, "error");

      // Attempt automatic re-login before stopping the worker.
      if (typeof this.workerProcessManager?.runClaudeAuthLogin === "function") {
        this.trace({
          stage: "worker_auth_auto_login_started",
          session_id: sessionID,
          worker_id: workerID,
        }, "error");
        const loginResult = await this.workerProcessManager.runClaudeAuthLogin();
        if (loginResult.ok) {
          this.trace({
            stage: "worker_auth_auto_login_succeeded",
            session_id: sessionID,
            worker_id: workerID,
          }, "error");
          // Login refreshed — stop the stale worker and let the next
          // reconcile / event cycle spawn a fresh one that will pick up
          // the new credentials.
          await this.workerProcessManager?.stopWorker?.(workerID);
          await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
            observedAt: Date.now(),
            reason: "auth_auto_login_refreshed",
            failureCode: "auth_auto_login_refreshed",
          });
          const nextBinding = await this.bindingRegistry.markWorkerStopped(sessionID, {
            updatedAt: Date.now(),
            lastStoppedAt: Date.now(),
          });
          this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
            exitCode: 0,
            exitSignal: "auth_auto_login_refreshed",
          });
          // Re-queue any pending events so they are delivered once the
          // fresh worker is ready.
          await this.requeuePendingEventsForWorker(sessionID, workerID);
          await this.handleWorkerStatusUpdate(binding, nextBinding);
          return true;
        }
        this.trace({
          stage: "worker_auth_auto_login_failed",
          session_id: sessionID,
          worker_id: workerID,
          reason: loginResult.reason,
        }, "error");
      }

      await this.workerProcessManager?.stopWorker?.(workerID);
      await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: authExitSignal,
        failureCode: authExitSignal,
      });

      const nextBinding = await this.bindingRegistry.markWorkerStopped(sessionID, {
        updatedAt: Date.now(),
        lastStoppedAt: Date.now(),
      });
      this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
        exitCode: 0,
        exitSignal: authExitSignal,
      });
      await this.handleWorkerStatusUpdate(binding, nextBinding);
      return true;
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
      const exitSignal = normalizeString(runtime.exit_signal) || "worker_exited";
      this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
        exitCode: Number(runtime.exit_code ?? 0),
        exitSignal,
      });

      this.trace({
        stage: "worker_process_exit_detected",
        session_id: sessionID,
        worker_id: workerID,
        pid,
        previous_status: workerStatus,
      }, "error");
      await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: exitSignal,
        failureCode: exitSignal,
      });

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
      await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: normalizeString(probe.reason) || "worker_control_unreachable",
        failureCode: "worker_control_unreachable",
      });

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

    const latestMcpActivityAt = Math.max(
      Number(probe?.pingPayload?.mcp_last_activity_at ?? 0),
      Number(probe?.pingPayload?.hook_last_activity_at ?? 0),
    );
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
      await this.bindingRegistry.markWorkerResponseFailed(sessionID, {
        observedAt: Date.now(),
        reason: "mcp_result_timeout",
        failureCode: "mcp_result_timeout",
      });
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

    let effectiveBinding = nextBinding;
    if (needsWorkerProbe(nextBinding)) {
      effectiveBinding = await this.ensureWorkerPingProbe(nextBinding);
    }

    if (canDeliverToWorker(effectiveBinding)) {
      await this.flushPendingSessionEvents(sessionID, effectiveBinding);
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

    try {
      const recovered = await this.tryRecoverResumeAuthFailure(previousBinding, nextBinding);
      if (recovered) {
        return;
      }
    } catch (error) {
      this.trace({
        stage: "worker_resume_auth_recovery_failed",
        session_id: sessionID,
        worker_id: previousWorkerID || nextWorkerID,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    }

    const failureEventOptions = await this.resolveWorkerFailureEventOptions(
      previousWorkerID || nextWorkerID,
    );

    // If a recovery spawn is still within cooldown, preserve pending events
    // instead of failing them so they can be delivered once the fresh worker
    // stabilises.
    const lastSpawnAt = this.lastAuthRecoverySpawnAt.get(sessionID) ?? 0;
    const authCooldownMs = this.authFailureCooldownMs || defaultAuthFailureCooldownMs;
    if (lastSpawnAt > 0 && (Date.now() - lastSpawnAt) < authCooldownMs) {
      this.trace({
        stage: "pending_events_preserved_auth_cooldown",
        session_id: sessionID,
        worker_id: previousWorkerID || nextWorkerID,
        remaining_cooldown_ms: authCooldownMs - (Date.now() - lastSpawnAt),
      }, "error");
      return;
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
      try {
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
          let recoveredBinding = binding;
          if (!canDeliverToWorker(recoveredBinding)) {
            recoveredBinding = await this.ensureReadyBinding(record.sessionID);
          }
          if (canDeliverToWorker(recoveredBinding)) {
            await this.flushPendingSessionEvents(record.sessionID, recoveredBinding);
          } else {
            this.trace({
              stage: "delivery_state_pending_worker_unavailable",
              event_id: record.eventID,
              session_id: record.sessionID,
              worker_id: recoveredBinding?.worker_id,
              status: recoveredBinding?.worker_status,
            }, "error");
          }
          continue;
        }

        await this.markPendingEventInterrupted(record.eventID);
        const currentRecord = this.getPendingEvent(record.eventID) ?? record;
        await this.failPendingEvent(currentRecord, { notifyText: false });
      } catch (error) {
        const message = formatRuntimeError(error, "delivery state recovery failed");
        this.trace({
          stage: "delivery_state_recover_failed",
          event_id: record.eventID,
          session_id: record.sessionID,
          delivery_state: record.delivery_state,
          error: message,
        }, "error");
        await this.markPendingEventInterrupted(record.eventID);
        const currentRecord = this.getPendingEvent(record.eventID) ?? record;
        await this.failPendingEvent(currentRecord, {
          notifyText: false,
          replySource: "daemon_recover_failed",
          resultCode: "worker_recover_failed",
          resultMessage: message,
        });
      }
    }
  }

  async deliverWithRecovery(
    aibotSessionID,
    rawPayload,
    deliverFn,
    { requireTrackedPendingEvent = false, includeUnreadyBinding = false } = {},
  ) {
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
      return includeUnreadyBinding ? readyBinding : null;
    }

    this.trace({
      stage: "event_dispatching",
      event_id: rawPayload?.event_id,
      session_id: aibotSessionID,
      worker_id: readyBinding?.worker_id,
      path: "recovered_worker",
    });
    const currentRecord = this.getPendingEvent(rawPayload?.event_id);
    if (requireTrackedPendingEvent && !currentRecord) {
      this.trace({
        stage: "event_dispatch_skipped",
        event_id: rawPayload?.event_id,
        session_id: aibotSessionID,
        worker_id: readyBinding?.worker_id,
        path: "recovered_worker",
        reason: "pending_event_cleared",
      });
      return null;
    }
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
    const dispatchingRecord = requireTrackedPendingEvent
      ? await this.markPendingEventDispatching(rawPayload?.event_id, readyBinding)
      : currentRecord;
    if (requireTrackedPendingEvent && !dispatchingRecord) {
      this.trace({
        stage: "event_dispatch_skipped",
        event_id: rawPayload?.event_id,
        session_id: aibotSessionID,
        worker_id: readyBinding?.worker_id,
        path: "recovered_worker",
        reason: "pending_event_cleared",
      });
      return null;
    }
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (canDeliverToWorker(readyBinding)) {
        return readyBinding;
      }

      const nextRuntime = await this.ensureWorker(readyBinding);
      if (
        !readyBinding.worker_control_url
        || !readyBinding.worker_control_token
        || nextRuntime?.status === "starting"
      ) {
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

      if (needsWorkerProbe(readyBinding)) {
        readyBinding = await this.ensureWorkerPingProbe(readyBinding);
      }

      if (canDeliverToWorker(readyBinding)) {
        return readyBinding;
      }

      if (
        attempt === 0
        && hasReadyWorkerBridge(readyBinding)
        && normalizeWorkerResponseState(readyBinding?.worker_response_state) === "failed"
      ) {
        this.trace({
          stage: "worker_ready_probe_retrying",
          session_id: aibotSessionID,
          worker_id: readyBinding?.worker_id,
          claude_session_id: readyBinding?.claude_session_id,
          response_reason: readyBinding?.worker_response_reason,
        }, "error");
        continue;
      }

      break;
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

      const authRetryBlock = this.resolveAuthFailureRetryBlock(binding);
      if (authRetryBlock) {
        this.trace({
          stage: "event_worker_auth_blocked",
          event_id: event.event_id,
          session_id: event.session_id,
          worker_id: authRetryBlock.workerID,
          remaining_ms: authRetryBlock.remainingMs,
          cooldown_ms: this.authFailureCooldownMs,
          last_stopped_at: authRetryBlock.lastStoppedAt,
        }, "error");
        await this.respond(
          event,
          buildAuthLoginRequiredEventNotice(),
          {
            reply_source: "daemon_worker_auth_login_required",
          },
          {
            status: "failed",
            code: "claude_auth_login_required",
            msg: "claude authentication expired; run claude auth login",
          },
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
      const routedBinding = await this.deliverWithRecovery(
        binding.aibot_session_id,
        rawPayload,
        this.deliverEventToWorker,
        {
          requireTrackedPendingEvent: true,
          includeUnreadyBinding: true,
        },
      );
      if (routedBinding && canDeliverToWorker(routedBinding)) {
        if (pending) {
          await this.markPendingEventDelivered(pending.eventID, routedBinding);
        }
        this.trace({
          stage: "event_forwarded",
          event_id: event.event_id,
          session_id: event.session_id,
          worker_id: routedBinding?.worker_id,
        });
        return;
      }

      const readyBinding = routedBinding ?? this.bindingRegistry.getByAibotSessionID(binding.aibot_session_id) ?? binding;
      if (!readyBinding.worker_control_url || !readyBinding.worker_control_token) {
        const launchFailure = normalizeString(readyBinding?.worker_launch_failure);
        this.trace({
          stage: "event_worker_not_ready",
          event_id: event.event_id,
          session_id: event.session_id,
          worker_id: readyBinding?.worker_id,
          status: readyBinding?.worker_status,
          worker_launch_failure: launchFailure,
        }, "error");
        if (pending && (launchFailure === "startup_mcp_server_failed" || launchFailure === "startup_wait_timeout")) {
          const workerID = normalizeString(readyBinding?.worker_id);
          if (workerID) {
            try {
              await this.workerProcessManager?.stopWorker?.(workerID);
            } catch {
              // best effort
            }
            try {
              await this.bindingRegistry.markWorkerResponseFailed(event.session_id, {
                observedAt: Date.now(),
                reason: launchFailure,
                failureCode: launchFailure,
              });
              await this.bindingRegistry.markWorkerStopped(event.session_id, {
                updatedAt: Date.now(),
                lastStoppedAt: Date.now(),
              });
            } catch {
              // best effort
            }
            this.workerProcessManager?.markWorkerRuntimeStopped?.(workerID, {
              exitCode: 0,
              exitSignal: launchFailure,
            });
          }
          await this.markPendingEventInterrupted(pending.eventID);
          await this.failPendingEvent(pending, {
            noticeText: buildWorkerStartupFailedNotice(),
            replySource: "daemon_worker_startup_failed",
            resultCode: launchFailure === "startup_mcp_server_failed"
              ? "claude_startup_mcp_failed"
              : "claude_startup_timeout",
            resultMessage: launchFailure === "startup_mcp_server_failed"
              ? "claude worker startup failed: mcp server not ready"
              : "claude worker startup timed out",
          });
          return;
        }
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
