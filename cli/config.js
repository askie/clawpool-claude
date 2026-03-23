import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT } from "../server/config-store.js";

const serverName = "clawpool-claude";
const configFileName = "clawpool-claude-config.json";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInteger(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

function resolveDefaultDataDir() {
  return path.join(os.homedir(), ".claude", serverName);
}

export function resolvePackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveServerEntryPath() {
  return path.join(resolvePackageRoot(), "dist", "index.js");
}

export function resolveDataDir(input) {
  const explicitDir = normalizeString(input.dataDir);
  if (explicitDir) {
    return explicitDir;
  }
  const envDir = normalizeString(input.env?.CLAUDE_PLUGIN_DATA || input.env?.CLAWPOOL_DATA_DIR);
  if (envDir) {
    return envDir;
  }
  return resolveDefaultDataDir();
}

export function resolveConfigPath(dataDir) {
  return path.join(dataDir, configFileName);
}

async function readStoredConfig(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    if (error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export async function loadConfig({ dataDir, env = process.env, args = {} }) {
  const configPath = resolveConfigPath(dataDir);
  const stored = await readStoredConfig(configPath);
  return {
    schema_version: 1,
    ws_url: normalizeString(args.wsUrl || env.CLAWPOOL_WS_URL || stored.ws_url),
    agent_id: normalizeString(args.agentId || env.CLAWPOOL_AGENT_ID || stored.agent_id),
    api_key: normalizeString(args.apiKey || env.CLAWPOOL_API_KEY || stored.api_key),
    outbound_text_chunk_limit: normalizePositiveInteger(
      args.chunkLimit || env.CLAWPOOL_TEXT_CHUNK_LIMIT || stored.outbound_text_chunk_limit,
      DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT,
    ),
  };
}

export function validateConfig(config) {
  if (!config.ws_url) {
    throw new Error("缺少 ws 地址，请传 --ws-url。");
  }
  if (!/^wss?:\/\//i.test(config.ws_url)) {
    throw new Error("ws 地址必须以 ws:// 或 wss:// 开头。");
  }
  if (!config.agent_id) {
    throw new Error("缺少 agent ID，请传 --agent-id。");
  }
  if (!config.api_key) {
    throw new Error("缺少 API Key，请传 --api-key。");
  }
}

export async function writeConfig({ dataDir, config }) {
  await mkdir(dataDir, { recursive: true });
  const configPath = resolveConfigPath(dataDir);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function maskApiKey(apiKey) {
  const normalized = normalizeString(apiKey);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-2)}`;
}
