import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";
import {
  buildQuestionPromptsFromFields,
  cloneRequestedSchema,
  normalizeElicitationFields,
} from "./elicitation-schema.js";

const schemaVersion = 1;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeChannelContext(input) {
  const context = input ?? {};
  return {
    chat_id: normalizeString(context.chat_id),
    event_id: normalizeString(context.event_id),
    message_id: normalizeString(context.message_id),
    sender_id: normalizeString(context.sender_id),
    user_id: normalizeString(context.user_id),
    msg_id: normalizeString(context.msg_id),
  };
}

function normalizeResolvedBy(input) {
  if (!isRecord(input)) {
    return null;
  }
  return {
    sender_id: normalizeString(input.sender_id),
    session_id: normalizeString(input.session_id),
    event_id: normalizeString(input.event_id),
    msg_id: normalizeString(input.msg_id),
  };
}

function normalizeResponseContent(input) {
  if (!isRecord(input)) {
    return null;
  }
  return cloneJSON(input);
}

function normalizeQuestions(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((question) => {
      const prompt = normalizeString(question?.question);
      if (!prompt) {
        return null;
      }
      return {
        question: prompt,
        header: normalizeString(question?.header),
        options: Array.isArray(question?.options) ? cloneJSON(question.options) : [],
        multiSelect: question?.multiSelect === true,
      };
    })
    .filter(Boolean);
}

function normalizeRequest(input) {
  if (!isRecord(input) || Number(input.schema_version) !== schemaVersion) {
    return null;
  }

  const fields = normalizeElicitationFields(input.fields);
  const storedQuestions = normalizeQuestions(input.questions);
  return {
    schema_version: schemaVersion,
    request_id: normalizeString(input.request_id),
    status: normalizeString(input.status) || "pending",
    created_at: Number(input.created_at ?? 0),
    updated_at: Number(input.updated_at ?? 0),
    dispatched_at: Number(input.dispatched_at ?? 0),
    dispatch_error: normalizeString(input.dispatch_error),
    prompt_message_id: normalizeString(input.prompt_message_id),
    session_id: normalizeString(input.session_id),
    transcript_path: normalizeString(input.transcript_path),
    mcp_server_name: normalizeString(input.mcp_server_name),
    elicitation_id: normalizeString(input.elicitation_id),
    message: normalizeString(input.message),
    mode: normalizeString(input.mode) || "form",
    url: normalizeString(input.url),
    requested_schema: input.requested_schema === null ? null : cloneRequestedSchema(input.requested_schema),
    fields,
    questions: storedQuestions.length > 0 ? storedQuestions : buildQuestionPromptsFromFields(fields),
    channel_context: normalizeChannelContext(input.channel_context),
    response_action: normalizeString(input.response_action),
    response_content: input.response_content === null ? null : normalizeResponseContent(input.response_content),
    resolved_by: normalizeResolvedBy(input.resolved_by),
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

export class ElicitationStore {
  constructor({ requestsDir }) {
    this.requestsDir = requestsDir;
  }

  async init() {
    await mkdir(this.requestsDir, { recursive: true });
  }

  resolveRequestPath(requestID) {
    return path.join(this.requestsDir, `${normalizeString(requestID)}.json`);
  }

  async createRequest(input) {
    const requestID = normalizeString(input.request_id);
    const now = Math.floor(input.created_at ?? Date.now());
    if (!requestID) {
      throw new Error("request_id is required");
    }

    const fields = normalizeElicitationFields(input.fields);
    if (fields.length === 0) {
      throw new Error("elicitation request fields are required");
    }

    const request = normalizeRequest({
      schema_version: schemaVersion,
      request_id: requestID,
      status: "pending",
      created_at: now,
      updated_at: now,
      dispatched_at: 0,
      dispatch_error: "",
      prompt_message_id: "",
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      mcp_server_name: input.mcp_server_name,
      elicitation_id: input.elicitation_id,
      message: input.message,
      mode: input.mode,
      url: input.url,
      requested_schema: input.requested_schema ?? null,
      fields,
      questions: buildQuestionPromptsFromFields(fields),
      channel_context: input.channel_context ?? {},
      response_action: "",
      response_content: null,
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

  async markDispatched(requestID, { dispatchedAt = Date.now(), promptMessageID = "" } = {}) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("elicitation request not found");
    }
    request.dispatched_at = Math.floor(dispatchedAt);
    request.dispatch_error = "";
    request.prompt_message_id = normalizeString(promptMessageID);
    return this.saveRequest(request);
  }

  async markDispatchFailed(requestID, errorText) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("elicitation request not found");
    }
    request.dispatch_error = normalizeString(errorText);
    return this.saveRequest(request);
  }

  async resolveRequest(requestID, { action, content, resolvedBy }) {
    const request = await this.getRequest(requestID);
    if (!request) {
      throw new Error("elicitation request not found");
    }
    if (request.status !== "pending") {
      throw new Error(`elicitation request is ${request.status}`);
    }

    const normalizedAction = normalizeString(action);
    if (!["accept", "decline", "cancel"].includes(normalizedAction)) {
      throw new Error("invalid elicitation action");
    }
    const normalizedContent = normalizedAction === "accept"
      ? normalizeResponseContent(content)
      : null;
    if (normalizedAction === "accept" && !normalizedContent) {
      throw new Error("invalid elicitation response content");
    }

    request.status = "resolved";
    request.response_action = normalizedAction;
    request.response_content = normalizedContent;
    request.resolved_by = normalizeResolvedBy(resolvedBy);
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
