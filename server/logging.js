import { appendFileSync } from "node:fs";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function formatTraceValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = normalizeString(value);
  if (!text) {
    return "";
  }
  if (/^[a-zA-Z0-9._:/@-]+$/u.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function listTraceEntries(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && normalizeString(value) !== "")
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
}

export function isTraceLoggingEnabled(env = process.env) {
  return env.CLAWPOOL_CLAUDE_TRACE_LOG === "1" || env.CLAWPOOL_CLAUDE_E2E_DEBUG === "1";
}

export function formatTraceLine(fields = {}) {
  const parts = [
    "trace",
    `ts=${formatTraceValue(new Date().toISOString())}`,
  ];

  for (const [key, value] of listTraceEntries(fields)) {
    parts.push(`${key}=${formatTraceValue(value)}`);
  }

  return parts.join(" ");
}

export function writeTraceStderr(fields = {}, { env = process.env } = {}) {
  if (!isTraceLoggingEnabled(env)) {
    return;
  }
  process.stderr.write(`${formatTraceLine(fields)}\n`);
}

export function createProcessLogger({
  env = process.env,
  name = "clawpool-claude",
  onTrace = null,
} = {}) {
  const verboseDebugEnabled = env.CLAWPOOL_CLAUDE_E2E_DEBUG === "1";
  const verboseDebugLogPath = normalizeString(env.CLAWPOOL_CLAUDE_E2E_DEBUG_LOG);
  const traceCallback = typeof onTrace === "function" ? onTrace : null;

  function write(prefix, message) {
    if (verboseDebugLogPath) {
      appendFileSync(verboseDebugLogPath, `${prefix} ${message}\n`);
    }
    console.error(`${prefix} ${message}`);
  }

  function trace(fields, { level = "info" } = {}) {
    if (traceCallback) {
      try {
        traceCallback(fields, { level });
      } catch {
        // trace sink failure must not affect daemon runtime
      }
    }
    if (!isTraceLoggingEnabled(env)) {
      return;
    }
    const line = formatTraceLine(fields);
    if (level === "error") {
      write(`[${name}:trace:error]`, line);
      return;
    }
    if (level === "debug") {
      write(`[${name}:trace:debug]`, line);
      return;
    }
    write(`[${name}:trace]`, line);
  }

  return {
    info(message) {
      write(`[${name}]`, message);
    },
    error(message) {
      write(`[${name}:error]`, message);
    },
    debug(message) {
      if (!verboseDebugEnabled) {
        return;
      }
      write(`[${name}:debug]`, message);
    },
    trace,
  };
}
