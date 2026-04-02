import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function buildServiceHash(dataDir) {
  return createHash("sha1")
    .update(normalizeString(dataDir) || "default")
    .digest("hex")
    .slice(0, 12);
}

export function buildServiceID(dataDir, platform = process.platform) {
  const suffix = buildServiceHash(dataDir);
  if (platform === "win32") {
    return `GrixClaudeDaemon-${suffix}`;
  }
  return `com.dhfpub.grix-claude.daemon.${suffix}`;
}

export function resolveServiceInstallRecordPath(dataDir) {
  return path.join(dataDir, "daemon-service.json");
}

export function resolveServiceLogsDir(dataDir) {
  return path.join(dataDir, "service");
}

export function resolveServiceStdoutPath(dataDir) {
  return path.join(resolveServiceLogsDir(dataDir), "daemon-service.out.log");
}

export function resolveServiceStderrPath(dataDir) {
  return path.join(resolveServiceLogsDir(dataDir), "daemon-service.err.log");
}

export function resolveMacOSLaunchAgentPath(serviceID, homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${serviceID}.plist`);
}

export function resolveLinuxUserUnitPath(serviceID, homeDir = os.homedir()) {
  return path.join(homeDir, ".config", "systemd", "user", `${serviceID}.service`);
}
