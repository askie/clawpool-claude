import os from "node:os";
import path from "node:path";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function sanitizeSegment(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function resolveDaemonDataDir(env = process.env) {
  const explicit = normalizeString(env.CLAWPOOL_DAEMON_DATA_DIR);
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".claude", "clawpool-claude-daemon");
}

export function resolveDaemonConfigPath(env = process.env) {
  return path.join(resolveDaemonDataDir(env), "daemon-config.json");
}

export function resolveBindingRegistryPath(env = process.env) {
  return path.join(resolveDaemonDataDir(env), "binding-registry.json");
}

export function resolveRuntimeWorkersDir(env = process.env) {
  return path.join(resolveDaemonDataDir(env), "runtime", "workers");
}

export function resolveWorkerRuntimePath(workerID, env = process.env) {
  return path.join(resolveRuntimeWorkersDir(env), `${sanitizeSegment(workerID)}.json`);
}

export function resolveSessionsDir(env = process.env) {
  return path.join(resolveDaemonDataDir(env), "sessions");
}

export function resolveBindingSessionDir(aibotSessionID, env = process.env) {
  return path.join(resolveSessionsDir(env), sanitizeSegment(aibotSessionID));
}

export function resolveWorkerPluginDataDir(aibotSessionID, env = process.env) {
  return path.join(resolveBindingSessionDir(aibotSessionID, env), "claude-plugin-data");
}

export function resolveWorkerLogsDir(aibotSessionID, env = process.env) {
  return path.join(resolveBindingSessionDir(aibotSessionID, env), "logs");
}
