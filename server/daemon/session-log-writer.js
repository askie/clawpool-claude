import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { formatTraceLine } from "../logging.js";
import { resolveWorkerLogsDir } from "./daemon-paths.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeSessionID(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveSessionID(fields = {}) {
  const explicitSessionID = normalizeString(fields.session_id);
  if (explicitSessionID) {
    return explicitSessionID;
  }
  return normalizeString(fields.aibot_session_id);
}

export class SessionLogWriter {
  constructor({
    env = process.env,
    logFileName = "daemon-session.log",
    mkdirImpl = mkdir,
    appendFileImpl = appendFile,
  } = {}) {
    this.env = env;
    this.logFileName = normalizeString(logFileName) || "daemon-session.log";
    this.mkdirImpl = typeof mkdirImpl === "function" ? mkdirImpl : mkdir;
    this.appendFileImpl = typeof appendFileImpl === "function" ? appendFileImpl : appendFile;
    this.writeQueues = new Map();
  }

  resolveLogPath(aibotSessionID) {
    const normalizedSessionID = normalizeSessionID(aibotSessionID);
    if (!normalizedSessionID) {
      return "";
    }
    return path.join(resolveWorkerLogsDir(normalizedSessionID, this.env), this.logFileName);
  }

  enqueueWrite(aibotSessionID, task) {
    const normalizedSessionID = normalizeSessionID(aibotSessionID);
    if (!normalizedSessionID) {
      return Promise.resolve(false);
    }
    const previous = this.writeQueues.get(normalizedSessionID) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch(() => false);
    this.writeQueues.set(normalizedSessionID, next);
    void next.finally(() => {
      if (this.writeQueues.get(normalizedSessionID) === next) {
        this.writeQueues.delete(normalizedSessionID);
      }
    });
    return next;
  }

  async writeTrace(fields = {}, { level = "info" } = {}) {
    const sessionID = resolveSessionID(fields);
    if (!sessionID) {
      return false;
    }
    const line = formatTraceLine({
      level: normalizeString(level) || "info",
      ...fields,
    });
    return this.enqueueWrite(sessionID, async () => {
      const logPath = this.resolveLogPath(sessionID);
      if (!logPath) {
        return false;
      }
      await this.mkdirImpl(path.dirname(logPath), { recursive: true });
      await this.appendFileImpl(logPath, `${line}\n`, "utf8");
      return true;
    });
  }
}
