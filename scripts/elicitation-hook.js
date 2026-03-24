import { randomUUID } from "node:crypto";
import process from "node:process";
import { resolveHookChannelContext } from "../server/channel-context-resolution.js";
import { ChannelContextStore } from "../server/channel-context-store.js";
import { ElicitationStore } from "../server/elicitation-store.js";
import {
  buildQuestionPromptsFromFields,
  deriveSupportedElicitationFields,
} from "../server/elicitation-schema.js";
import {
  resolveElicitationRequestsDir,
  resolveSessionContextsDir,
} from "../server/paths.js";
import { writeTraceStderr } from "../server/logging.js";

const remoteElicitationTimeoutMs = 10 * 60 * 1000;
const pollIntervalMs = 1000;
const recentChannelContextMaxAgeMs = 30 * 60 * 1000;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function logDebug(message) {
  if (process.env.CLAWPOOL_E2E_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[elicitation-hook] ${message}\n`);
}

function trace(fields) {
  writeTraceStderr({
    component: "hook.elicitation",
    ...fields,
  }, {
    env: process.env,
  });
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function buildHookResult(action, content = undefined) {
  return {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action,
      ...(action === "accept" ? { content } : {}),
    },
  };
}

async function main() {
  const input = await readStdinJSON();
  if (input?.hook_event_name !== "Elicitation") {
    writeResult({});
    return;
  }

  if (normalizeString(input.mode || "form") !== "form") {
    trace({
      stage: "elicitation_passthrough",
      session_id: input.session_id,
      reason: "unsupported_mode",
      mode: normalizeString(input.mode),
    });
    writeResult({});
    return;
  }

  const fieldsResult = deriveSupportedElicitationFields(input.requested_schema);
  if (!fieldsResult.supported) {
    trace({
      stage: "elicitation_passthrough",
      session_id: input.session_id,
      reason: fieldsResult.reason,
    });
    writeResult({});
    return;
  }

  const sessionContextStore = new ChannelContextStore(resolveSessionContextsDir());
  const contextResolution = await resolveHookChannelContext({
    sessionContextStore,
    sessionID: input.session_id,
    transcriptPath: input.transcript_path,
    workingDir: input.cwd,
    maxAgeMs: recentChannelContextMaxAgeMs,
  });
  logDebug(
    `context session=${String(input.session_id ?? "")} cwd=${String(input.cwd ?? "")} transcript=${String(input.transcript_path ?? "")} status=${contextResolution.status} reason=${contextResolution.reason || ""} source=${contextResolution.source || ""}`,
  );
  if (contextResolution.status !== "resolved" || !contextResolution.context?.chat_id) {
    trace({
      stage: "channel_context_missing",
      session_id: input.session_id,
      reason: contextResolution.reason || "no_channel_context",
    });
    process.stderr.write(
      `elicitation-hook bridge skipped: ${contextResolution.reason || "no_channel_context"}\n`,
    );
    writeResult({});
    return;
  }

  const requestID = normalizeString(input.elicitation_id) || randomUUID();
  const elicitationStore = new ElicitationStore({
    requestsDir: resolveElicitationRequestsDir(),
  });
  await elicitationStore.init();

  const request = await elicitationStore.createRequest({
    request_id: requestID,
    created_at: Date.now(),
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    mcp_server_name: input.mcp_server_name,
    elicitation_id: input.elicitation_id,
    message: input.message,
    mode: input.mode || "form",
    url: input.url,
    requested_schema: input.requested_schema ?? null,
    fields: fieldsResult.fields,
    questions: buildQuestionPromptsFromFields(fieldsResult.fields),
    channel_context: contextResolution.context,
  });
  trace({
    stage: "elicitation_request_created",
    request_id: request.request_id,
    event_id: request.channel_context.event_id,
    chat_id: request.channel_context.chat_id,
    session_id: request.session_id,
    mcp_server_name: request.mcp_server_name,
  });
  logDebug(
    `created request_id=${request.request_id} chat_id=${request.channel_context.chat_id} field_count=${request.fields.length}`,
  );

  const deadlineAt = Date.now() + remoteElicitationTimeoutMs;
  while (Date.now() < deadlineAt) {
    const current = await elicitationStore.getRequest(request.request_id);
    if (current?.status === "resolved" && normalizeString(current.response_action)) {
      trace({
        stage: "elicitation_request_resolved",
        request_id: current.request_id,
        event_id: current.channel_context.event_id,
        chat_id: current.channel_context.chat_id,
        session_id: current.session_id,
        action: current.response_action,
      });
      logDebug(`resolved request_id=${request.request_id}`);
      writeResult(buildHookResult(current.response_action, current.response_content ?? undefined));
      return;
    }
    if (current?.status === "expired") {
      break;
    }
    await sleep(pollIntervalMs);
  }

  await elicitationStore.markExpired(request.request_id);
  trace({
    stage: "elicitation_request_expired",
    request_id: request.request_id,
    event_id: request.channel_context.event_id,
    chat_id: request.channel_context.chat_id,
    session_id: request.session_id,
  });
  logDebug(`expired request_id=${request.request_id}`);
  writeResult(buildHookResult("cancel"));
}

main().catch((error) => {
  process.stderr.write(`elicitation-hook failed: ${String(error)}\n`);
  writeResult({});
});
