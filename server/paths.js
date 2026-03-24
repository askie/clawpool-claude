import { mkdir } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const defaultPluginID = "clawpool-claude";

function sanitizePluginID(pluginID) {
  return String(pluginID ?? defaultPluginID)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || defaultPluginID;
}

export function resolvePluginDataDir(pluginID = defaultPluginID) {
  const value = String(process.env.CLAUDE_PLUGIN_DATA ?? "").trim();
  if (value) {
    return value;
  }
  return path.join(os.homedir(), ".claude", sanitizePluginID(pluginID));
}

export async function ensurePluginDataDir(pluginID = defaultPluginID) {
  const dir = resolvePluginDataDir(pluginID);
  await mkdirAsync(dir, { recursive: true });
  return dir;
}

export function resolveConfigPath(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "clawpool-claude-config.json");
}

export function resolveAccessPath(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "clawpool-claude-access.json");
}

export function resolveApprovalRequestsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "approval-requests");
}

export function resolveApprovalNotificationsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "approval-notifications");
}

export function resolveElicitationRequestsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "elicitation-requests");
}

export function resolveSessionContextsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "session-contexts");
}

export function resolveEventStatesDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "event-states");
}
