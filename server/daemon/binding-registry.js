import path from "node:path";
import { SessionBindingStore } from "./session-binding-store.js";
import { WorkerRuntimeStore } from "./worker-runtime-store.js";
import { normalizeWorkerResponseState } from "./worker-state.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeTimestamp(value, fallbackValue = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.floor(fallbackValue);
  }
  return Math.floor(numeric);
}

function normalizePid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function resolveWorkerRuntimeStorePath(bindingFilePath) {
  const parsed = path.parse(bindingFilePath);
  return path.join(parsed.dir, `${parsed.name}.worker-runtimes${parsed.ext || ".json"}`);
}

function buildWorkerResponsePatch(workerStatus, { observedAt = Date.now() } = {}) {
  const normalizedStatus = normalizeString(workerStatus);
  if (normalizedStatus === "starting") {
    return {
      worker_response_state: "unknown",
      worker_response_reason: "worker_starting",
      worker_response_updated_at: observedAt,
      worker_last_reply_at: 0,
      worker_last_failure_at: 0,
      worker_last_failure_code: "",
      worker_last_hook_event_id: "",
      worker_last_hook_event_name: "",
      worker_last_hook_event_detail: "",
      worker_last_hook_event_at: 0,
    };
  }
  if (normalizedStatus === "connected") {
    return {
      worker_response_state: "unverified",
      worker_response_reason: "worker_connected",
      worker_response_updated_at: observedAt,
      worker_last_reply_at: 0,
      worker_last_failure_at: 0,
      worker_last_failure_code: "",
      worker_last_hook_event_id: "",
      worker_last_hook_event_name: "",
      worker_last_hook_event_detail: "",
      worker_last_hook_event_at: 0,
    };
  }
  if (normalizedStatus === "ready") {
    return {
      worker_response_state: "unverified",
      worker_response_reason: "worker_ready",
      worker_response_updated_at: observedAt,
      worker_last_reply_at: 0,
      worker_last_failure_at: 0,
      worker_last_failure_code: "",
      worker_last_hook_event_id: "",
      worker_last_hook_event_name: "",
      worker_last_hook_event_detail: "",
      worker_last_hook_event_at: 0,
    };
  }
  return {};
}

function mergeBindingWithRuntime(binding, runtime) {
  if (!binding) {
    return null;
  }

  return {
    ...binding,
    worker_id: normalizeString(runtime?.worker_id),
    worker_pid: normalizePid(runtime?.worker_pid),
    worker_status: normalizeString(runtime?.worker_status) || "stopped",
    worker_control_url: normalizeString(runtime?.worker_control_url),
    worker_control_token: normalizeString(runtime?.worker_control_token),
    worker_response_state: normalizeWorkerResponseState(runtime?.worker_response_state),
    worker_response_reason: normalizeString(runtime?.worker_response_reason),
    worker_response_updated_at: normalizeTimestamp(runtime?.worker_response_updated_at, 0),
    worker_last_reply_at: normalizeTimestamp(runtime?.worker_last_reply_at, 0),
    worker_last_failure_at: normalizeTimestamp(runtime?.worker_last_failure_at, 0),
    worker_last_failure_code: normalizeString(runtime?.worker_last_failure_code),
    worker_last_hook_event_id: normalizeString(runtime?.worker_last_hook_event_id),
    worker_last_hook_event_name: normalizeString(runtime?.worker_last_hook_event_name),
    worker_last_hook_event_detail: normalizeString(runtime?.worker_last_hook_event_detail),
    worker_last_hook_event_at: normalizeTimestamp(runtime?.worker_last_hook_event_at, 0),
    updated_at: Math.max(
      normalizeTimestamp(binding.updated_at),
      normalizeTimestamp(runtime?.updated_at),
    ),
    last_started_at: normalizeTimestamp(runtime?.last_started_at),
    last_stopped_at: normalizeTimestamp(runtime?.last_stopped_at),
  };
}

export class BindingRegistry {
  constructor(filePathOrOptions) {
    const options = typeof filePathOrOptions === "string"
      ? {
          bindingFilePath: filePathOrOptions,
          workerRuntimeFilePath: resolveWorkerRuntimeStorePath(filePathOrOptions),
        }
      : (filePathOrOptions ?? {});
    this.bindingStore = new SessionBindingStore(options.bindingFilePath);
    this.workerRuntimeStore = new WorkerRuntimeStore(
      options.workerRuntimeFilePath || resolveWorkerRuntimeStorePath(options.bindingFilePath),
    );
  }

  async load() {
    await Promise.all([
      this.bindingStore.load(),
      this.workerRuntimeStore.load(),
    ]);
    return this.listBindings();
  }

  listBindings() {
    return this.bindingStore.list()
      .map((binding) => mergeBindingWithRuntime(
        binding,
        this.workerRuntimeStore.get(binding.aibot_session_id),
      ))
      .sort((left, right) => left.aibot_session_id.localeCompare(right.aibot_session_id));
  }

  getByAibotSessionID(aibotSessionID) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      return null;
    }
    return mergeBindingWithRuntime(
      binding,
      this.workerRuntimeStore.get(binding.aibot_session_id),
    );
  }

  async createBinding(input) {
    const binding = await this.bindingStore.create(input);
    const runtime = await this.workerRuntimeStore.createOrUpdate(binding.aibot_session_id, {
      worker_id: input.worker_id,
      worker_pid: input.worker_pid,
      worker_status: input.worker_status || "starting",
      worker_control_url: input.worker_control_url,
      worker_control_token: input.worker_control_token,
      ...buildWorkerResponsePatch(input.worker_status || "starting", {
        observedAt: input.updated_at ?? Date.now(),
      }),
      updated_at: input.updated_at ?? Date.now(),
      last_started_at: input.last_started_at ?? 0,
      last_stopped_at: input.last_stopped_at ?? 0,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async updateClaudeSessionID(aibotSessionID, {
    claudeSessionID,
    updatedAt = Date.now(),
  } = {}) {
    const binding = await this.bindingStore.updateClaudeSessionID(
      aibotSessionID,
      claudeSessionID,
      { updatedAt },
    );
    return mergeBindingWithRuntime(
      binding,
      this.workerRuntimeStore.get(binding.aibot_session_id),
    );
  }

  async markWorkerStarting(aibotSessionID, {
    workerID = "",
    workerPid = 0,
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_id: workerID,
      worker_pid: workerPid,
      worker_status: "starting",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      ...buildWorkerResponsePatch("starting", { observedAt: updatedAt }),
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerConnected(aibotSessionID, {
    workerID = "",
    workerPid = 0,
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_id: workerID,
      worker_pid: workerPid,
      worker_status: "connected",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      ...buildWorkerResponsePatch("connected", { observedAt: updatedAt }),
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerReady(aibotSessionID, {
    workerID = "",
    workerPid = 0,
    workerControlURL = "",
    workerControlToken = "",
    updatedAt = Date.now(),
    lastStartedAt = Date.now(),
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_id: workerID,
      worker_pid: workerPid,
      worker_status: "ready",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      ...buildWorkerResponsePatch("ready", { observedAt: updatedAt }),
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerStopped(aibotSessionID, { updatedAt = Date.now(), lastStoppedAt = Date.now() } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_pid: 0,
      worker_status: "stopped",
      worker_control_url: "",
      worker_control_token: "",
      updated_at: updatedAt,
      last_stopped_at: lastStoppedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerFailed(aibotSessionID, { updatedAt = Date.now(), lastStoppedAt = Date.now() } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_pid: 0,
      worker_status: "failed",
      worker_control_url: "",
      worker_control_token: "",
      updated_at: updatedAt,
      last_stopped_at: lastStoppedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerHealthy(aibotSessionID, {
    observedAt = Date.now(),
    reason = "worker_reply_observed",
    lastReplyAt = 0,
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_response_state: "healthy",
      worker_response_reason: reason,
      worker_response_updated_at: observedAt,
      worker_last_reply_at: lastReplyAt || observedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerProbing(aibotSessionID, {
    observedAt = Date.now(),
    reason = "worker_ping_probe_requested",
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_response_state: "probing",
      worker_response_reason: reason,
      worker_response_updated_at: observedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerResponseFailed(aibotSessionID, {
    observedAt = Date.now(),
    reason = "worker_response_failed",
    failureCode = "",
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_response_state: "failed",
      worker_response_reason: reason,
      worker_response_updated_at: observedAt,
      worker_last_failure_at: observedAt,
      worker_last_failure_code: failureCode,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerHookObserved(aibotSessionID, {
    eventID = "",
    eventName = "",
    eventDetail = "",
    eventAt = Date.now(),
  } = {}) {
    const binding = this.bindingStore.get(aibotSessionID);
    if (!binding) {
      throw new Error("binding not found");
    }
    const runtime = await this.workerRuntimeStore.createOrUpdate(aibotSessionID, {
      worker_last_hook_event_id: eventID,
      worker_last_hook_event_name: eventName,
      worker_last_hook_event_detail: eventDetail,
      worker_last_hook_event_at: eventAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async resetTransientWorkerStates({
    updatedAt = Date.now(),
    lastStoppedAt = Date.now(),
  } = {}) {
    const changed = await this.workerRuntimeStore.resetTransientStates({
      updatedAt,
      lastStoppedAt,
    });
    if (!changed) {
      return [];
    }
    return this.listBindings();
  }
}
