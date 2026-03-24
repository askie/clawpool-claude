import path from "node:path";
import { SessionBindingStore } from "./session-binding-store.js";
import { WorkerRuntimeStore } from "./worker-runtime-store.js";

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

function resolveWorkerRuntimeStorePath(bindingFilePath) {
  const parsed = path.parse(bindingFilePath);
  return path.join(parsed.dir, `${parsed.name}.worker-runtimes${parsed.ext || ".json"}`);
}

function mergeBindingWithRuntime(binding, runtime) {
  if (!binding) {
    return null;
  }

  return {
    ...binding,
    worker_id: normalizeString(runtime?.worker_id),
    worker_status: normalizeString(runtime?.worker_status) || "stopped",
    worker_control_url: normalizeString(runtime?.worker_control_url),
    worker_control_token: normalizeString(runtime?.worker_control_token),
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
      worker_status: input.worker_status || "starting",
      worker_control_url: input.worker_control_url,
      worker_control_token: input.worker_control_token,
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
      worker_status: "starting",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerConnected(aibotSessionID, {
    workerID = "",
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
      worker_status: "connected",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
      updated_at: updatedAt,
      last_started_at: lastStartedAt,
    });
    return mergeBindingWithRuntime(binding, runtime);
  }

  async markWorkerReady(aibotSessionID, {
    workerID = "",
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
      worker_status: "ready",
      worker_control_url: workerControlURL,
      worker_control_token: workerControlToken,
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
      worker_status: "failed",
      worker_control_url: "",
      worker_control_token: "",
      updated_at: updatedAt,
      last_stopped_at: lastStoppedAt,
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
