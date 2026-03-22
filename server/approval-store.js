import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";

const schemaVersion = 1;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDecision(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const behavior = normalizeString(input.behavior);
  if (behavior !== "allow" && behavior !== "deny") {
    return null;
  }

  const next = {
    behavior,
  };

  if (Array.isArray(input.updatedPermissions) && input.updatedPermissions.length > 0) {
    next.updatedPermissions = cloneJSON(input.updatedPermissions);
  }

  const message = normalizeString(input.message);
  if (message) {
    next.message = message;
  }

  if (input.interrupt === true) {
    next.interrupt = true;
  }

  return next;
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Number(input.schema_version) !== schemaVersion) {
    return null;
  }

  const status = normalizeString(input.status) || "pending";
  const channelContext = input.channel_context ?? {};
  return {
    schema_version: schemaVersion,
    request_id: normalizeString(input.request_id),
    status,
    created_at: Number(input.created_at ?? 0),
    updated_at: Number(input.updated_at ?? 0),
    dispatched_at: Number(input.dispatched_at ?? 0),
    dispatch_error: normalizeString(input.dispatch_error),
    approval_message_id: normalizeString(input.approval_message_id),
    session_id: normalizeString(input.session_id),
    transcript_path: normalizeString(input.transcript_path),
    tool_name: normalizeString(input.tool_name),
    tool_input: cloneJSON(input.tool_input ?? {}),
    permission_suggestions: cloneJSON(input.permission_suggestions ?? []),
    channel_context: {
      chat_id: normalizeString(channelContext.chat_id),
      event_id: normalizeString(channelContext.event_id),
      message_id: normalizeString(channelContext.message_id),
      sender_id: normalizeString(channelContext.sender_id),
      user_id: normalizeString(channelContext.user_id),
      msg_id: normalizeString(channelContext.msg_id),
    },
    decision: normalizeDecision(input.decision),
    resolved_by: input.resolved_by && typeof input.resolved_by === "object"
      ? {
          sender_id: normalizeString(input.resolved_by.sender_id),
          session_id: normalizeString(input.resolved_by.session_id),
          event_id: normalizeString(input.resolved_by.event_id),
          msg_id: normalizeString(input.resolved_by.msg_id),
        }
      : null,
  };
}

async function listJSONFiles(dirPath) {
  let names = [];
  try {
    names = await readdir(dirPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names.filter((name) => name.endsWith(".json"));
}

export class ApprovalStore {
  constructor({ requestsDir, notificationsDir }) {
    this.requestsDir = requestsDir;
    this.notificationsDir = notificationsDir;
  }

  async init() {
    await mkdir(this.requestsDir, { recursive: true });
    await mkdir(this.notificationsDir, { recursive: true });
  }

  resolveRequestPath(requestID) {
    return path.join(this.requestsDir, `${normalizeString(requestID)}.json`);
  }

  async createPermissionRequest(input) {
    const requestID = normalizeString(input.request_id);
    const now = Math.floor(input.created_at ?? Date.now());
    if (!requestID) {
      throw new Error("request_id is required");
    }

    const request = normalizeRequest({
      schema_version: schemaVersion,
      request_id: requestID,
      status: "pending",
      created_at: now,
      updated_at: now,
      dispatched_at: 0,
      dispatch_error: "",
      approval_message_id: "",
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      permission_suggestions: input.permission_suggestions ?? [],
      channel_context: input.channel_context ?? {},
      decision: null,
      resolved_by: null,
    });
    await writeJSONFileAtomic(this.resolveRequestPath(requestID), request);
    return request;
  }

  async getRequest(requestID) {
    const stored = await readJSONFile(this.resolveRequestPath(requestID), null);
    return normalizeRequest(stored);
  }

  async saveRequest(request) {
    const normalized = normalizeRequest(request);
    if (!normalized?.request_id) {
      throw new Error("request_id is required");
    }
    normalized.updated_at = Math.floor(Date.now());
    await writeJSONFileAtomic(this.resolveRequestPath(normalized.request_id), normalized);
    return normalized;
  }

  async listPendingDispatches() {
    const names = await listJSONFiles(this.requestsDir);
    const requests = [];
    for (const name of names) {
      const request = await this.getRequest(name.replace(/\.json$/u, ""));
      if (!request) {
        continue;
      }
      if (request.status !== "pending") {
        continue;
      }
      if (!request.channel_context.chat_id) {
        continue;
      }
      if (request.dispatched_at > 0) {
        continue;
      }
      requests.push(request);
    }
    requests.sort((left, right) => left.created_at - right.created_at);
    return requests;
  }

  async markDispatched(requestID, { dispatchedAt = Date.now(), approvalMessageID = "" } = {}) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("approval request not found");
    }
    request.dispatched_at = Math.floor(dispatchedAt);
    request.dispatch_error = "";
    request.approval_message_id = normalizeString(approvalMessageID);
    return this.saveRequest(request);
  }

  async markDispatchFailed(requestID, errorText) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("approval request not found");
    }
    request.dispatch_error = normalizeString(errorText);
    return this.saveRequest(request);
  }

  async resolveRequest(requestID, { decision, resolvedBy }) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("approval request not found");
    }
    if (request.status !== "pending") {
      throw new Error(`approval request is ${request.status}`);
    }

    const normalizedDecision = normalizeDecision(decision);
    if (!normalizedDecision) {
      throw new Error("invalid approval decision");
    }

    request.status = "resolved";
    request.decision = normalizedDecision;
    request.resolved_by = {
      sender_id: normalizeString(resolvedBy?.sender_id),
      session_id: normalizeString(resolvedBy?.session_id),
      event_id: normalizeString(resolvedBy?.event_id),
      msg_id: normalizeString(resolvedBy?.msg_id),
    };
    return this.saveRequest(request);
  }

  async markExpired(requestID) {
    const request = await this.getRequest(requestID);
    if (!request || request.status !== "pending") {
      return request;
    }
    request.status = "expired";
    return this.saveRequest(request);
  }

  async recordNotification(event) {
    const now = Date.now();
    const filePath = path.join(this.notificationsDir, `${now}.json`);
    await writeJSONFileAtomic(filePath, {
      schema_version: schemaVersion,
      created_at: now,
      payload: cloneJSON(event ?? {}),
    });
  }

  async getStatus() {
    const names = await listJSONFiles(this.requestsDir);
    let pendingCount = 0;
    let resolvedCount = 0;
    let expiredCount = 0;

    for (const name of names) {
      const request = await this.getRequest(name.replace(/\.json$/u, ""));
      if (!request) {
        continue;
      }
      if (request.status === "pending") {
        pendingCount += 1;
      } else if (request.status === "resolved") {
        resolvedCount += 1;
      } else if (request.status === "expired") {
        expiredCount += 1;
      }
    }

    return {
      pending_count: pendingCount,
      resolved_count: resolvedCount,
      expired_count: expiredCount,
    };
  }
}
