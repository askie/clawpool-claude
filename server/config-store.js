import { ensurePluginDataDir } from "./paths.js";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";

export const DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT = 1200;

const defaultConfig = Object.freeze({
  schema_version: 1,
  ws_url: "",
  agent_id: "",
  api_key: "",
  outbound_text_chunk_limit: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT,
});

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInt(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.floor(numeric);
}

function normalizeConfigShape(input = {}) {
  return {
    schema_version: 1,
    ws_url: normalizeString(input.ws_url),
    agent_id: normalizeString(input.agent_id),
    api_key: normalizeString(input.api_key),
    outbound_text_chunk_limit: normalizePositiveInt(
      input.outbound_text_chunk_limit,
      DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT,
    ),
  };
}

function applyEnvOverrides(config) {
  const next = { ...config };
  const wsURL = normalizeString(process.env.CLAWPOOL_WS_URL);
  const agentID = normalizeString(process.env.CLAWPOOL_AGENT_ID);
  const apiKey = normalizeString(process.env.CLAWPOOL_API_KEY);
  if (wsURL) {
    next.ws_url = wsURL;
  }
  if (agentID) {
    next.agent_id = agentID;
  }
  if (apiKey) {
    next.api_key = apiKey;
  }
  return next;
}

function validateConfig(config) {
  const issues = [];
  if (config.ws_url && !/^wss?:\/\//i.test(config.ws_url)) {
    issues.push("ws_url must start with ws:// or wss://");
  }
  if ((config.agent_id && !config.ws_url) || (config.api_key && !config.ws_url)) {
    issues.push("ws_url is required when agent_id or api_key is set");
  }
  if ((config.ws_url && !config.agent_id) || (config.api_key && !config.agent_id)) {
    issues.push("agent_id is required when ws_url or api_key is set");
  }
  if ((config.ws_url && !config.api_key) || (config.agent_id && !config.api_key)) {
    issues.push("api_key is required when ws_url or agent_id is set");
  }
  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
}

function redactAPIKey(apiKey) {
  const normalized = normalizeString(apiKey);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-2)}`;
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.config = { ...defaultConfig };
  }

  async load() {
    await ensurePluginDataDir();
    const stored = await readJSONFile(this.filePath, defaultConfig);
    this.config = normalizeConfigShape(applyEnvOverrides(stored));
    validateConfig(this.config);
    return this.get();
  }

  get() {
    return { ...this.config };
  }

  isConfigured() {
    return Boolean(this.config.ws_url && this.config.agent_id && this.config.api_key);
  }

  getConnectionConfig() {
    if (!this.isConfigured()) {
      return null;
    }
    return {
      wsURL: this.config.ws_url,
      agentID: this.config.agent_id,
      apiKey: this.config.api_key,
      outboundTextChunkLimit: this.config.outbound_text_chunk_limit,
    };
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      ws_url: this.config.ws_url,
      agent_id: this.config.agent_id,
      api_key_hint: redactAPIKey(this.config.api_key),
      outbound_text_chunk_limit: this.config.outbound_text_chunk_limit,
    };
  }

  async update(input) {
    const next = normalizeConfigShape({
      ...this.config,
      ...input,
    });
    validateConfig(next);
    await ensurePluginDataDir();
    await writeJSONFileAtomic(this.filePath, next);
    this.config = applyEnvOverrides(next);
    validateConfig(this.config);
    return this.getStatus();
  }
}
