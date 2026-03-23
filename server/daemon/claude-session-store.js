import path from "node:path";
import { access } from "node:fs/promises";

function normalizeString(value) {
  return String(value ?? "").trim();
}

export function encodeClaudeProjectPath(cwd) {
  const normalized = normalizeString(cwd);
  if (!normalized) {
    return "";
  }
  return path.resolve(normalized).replace(/[\\/]/g, "-");
}

export function resolveClaudeSessionPath({ cwd, claudeSessionID, env = process.env } = {}) {
  const projectKey = encodeClaudeProjectPath(cwd);
  const sessionID = normalizeString(claudeSessionID);
  const homeDir = normalizeString(env?.HOME);
  if (!projectKey || !sessionID || !homeDir) {
    return "";
  }
  return path.join(homeDir, ".claude", "projects", projectKey, `${sessionID}.jsonl`);
}

export async function claudeSessionExists(input = {}) {
  const filePath = resolveClaudeSessionPath(input);
  if (!filePath) {
    return false;
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
