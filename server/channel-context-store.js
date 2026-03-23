import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";

const schemaVersion = 1;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function sanitizeFileName(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function normalizeContext(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const context = input.context ?? {};
  const sessionID = normalizeString(input.session_id);
  const transcriptPath = normalizeString(input.transcript_path);
  const cwd = normalizeString(input.cwd);
  const chatID = normalizeString(context.chat_id);
  if (!sessionID || !transcriptPath || !chatID) {
    return null;
  }

  return {
    schema_version: schemaVersion,
    session_id: sessionID,
    transcript_path: transcriptPath,
    cwd,
    updated_at: Number(input.updated_at ?? Date.now()),
    context: {
      raw_tag: normalizeString(context.raw_tag),
      chat_id: chatID,
      event_id: normalizeString(context.event_id),
      message_id: normalizeString(context.message_id),
      sender_id: normalizeString(context.sender_id),
      user_id: normalizeString(context.user_id),
      msg_id: normalizeString(context.msg_id),
    },
  };
}

export class ChannelContextStore {
  constructor(contextsDir) {
    this.contextsDir = contextsDir;
  }

  async init() {
    await mkdir(this.contextsDir, { recursive: true });
  }

  resolveSessionPath(sessionID) {
    const name = sanitizeFileName(sessionID);
    if (!name) {
      throw new Error("session_id is required");
    }
    return path.join(this.contextsDir, `${name}.json`);
  }

  async put(input) {
    const normalized = normalizeContext(input);
    if (!normalized) {
      throw new Error("valid session context is required");
    }
    await this.init();
    await writeJSONFileAtomic(this.resolveSessionPath(normalized.session_id), normalized);
    return normalized;
  }

  async get(sessionID) {
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return null;
    }
    const stored = await readJSONFile(this.resolveSessionPath(normalizedSessionID), null);
    return normalizeContext(stored);
  }

  async getMatchingContext({ sessionID, transcriptPath, workingDir, maxAgeMs }) {
    const inspection = await this.inspectMatchingContext({
      sessionID,
      transcriptPath,
      workingDir,
      maxAgeMs,
    });
    if (inspection.status !== "matched") {
      return null;
    }
    return inspection.context;
  }

  async inspectMatchingContext({ sessionID, transcriptPath, workingDir, maxAgeMs }) {
    const stored = await this.get(sessionID);
    if (!stored) {
      return {
        status: "missing",
        context: null,
      };
    }
    if (normalizeString(transcriptPath) && stored.transcript_path !== normalizeString(transcriptPath)) {
      return {
        status: "transcript_mismatch",
        context: null,
      };
    }
    if (normalizeString(workingDir) && stored.cwd !== normalizeString(workingDir)) {
      return {
        status: "cwd_mismatch",
        context: null,
      };
    }
    if (Number(maxAgeMs ?? 0) > 0 && Date.now() - stored.updated_at > Number(maxAgeMs)) {
      return {
        status: "stale",
        context: null,
      };
    }
    return {
      status: "matched",
      context: stored.context,
    };
  }
}
