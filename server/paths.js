import { mkdir, readFileSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pluginRootFallback = process.cwd();
const defaultPluginID = "clawpool-claude";
const runtimeDataPointerFile = ".clawpool-claude-plugin-data-dir";

function sanitizePluginID(pluginID) {
  return String(pluginID ?? defaultPluginID)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || defaultPluginID;
}

export function resolvePluginRoot() {
  const value = String(process.env.CLAUDE_PLUGIN_ROOT ?? "").trim();
  if (value) {
    return value;
  }
  return pluginRootFallback;
}

export function resolvePluginDataDir(pluginID = defaultPluginID) {
  const value = String(process.env.CLAUDE_PLUGIN_DATA ?? "").trim();
  if (value) {
    try {
      writeFileSync(path.join(resolvePluginRoot(), runtimeDataPointerFile), `${value}\n`, "utf8");
    } catch {
      // Best effort only. Hooks can still fall back to CLAUDE_PLUGIN_DATA or tmpdir.
    }
    return value;
  }

  try {
    const pointerPath = path.join(resolvePluginRoot(), runtimeDataPointerFile);
    const pointerValue = readFileSync(pointerPath, "utf8").trim();
    if (pointerValue) {
      return pointerValue;
    }
  } catch {
    // Ignore missing or unreadable pointer files and fall back to tmpdir.
  }
  return path.join(os.tmpdir(), `claude-plugin-data-${sanitizePluginID(pluginID)}`);
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

export function resolveQuestionRequestsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "question-requests");
}

export function resolveSessionContextsDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "session-contexts");
}

export function resolveEventStatesDir(pluginID = defaultPluginID) {
  return path.join(resolvePluginDataDir(pluginID), "event-states");
}
