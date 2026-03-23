import { randomUUID } from "node:crypto";
import process from "node:process";
import { AccessStore } from "../server/access-store.js";
import { resolveHookChannelContext } from "../server/channel-context-resolution.js";
import { ChannelContextStore } from "../server/channel-context-store.js";
import { ApprovalStore } from "../server/approval-store.js";
import { writeTraceStderr } from "../server/logging.js";
import {
  resolveAccessPath,
  resolveApprovalNotificationsDir,
  resolveApprovalRequestsDir,
  resolveSessionContextsDir,
} from "../server/paths.js";

const remoteApprovalTimeoutMs = 10 * 60 * 1000;
const pollIntervalMs = 1000;
const recentChannelContextMaxAgeMs = 30 * 60 * 1000;

function logDebug(message) {
  if (process.env.CLAWPOOL_E2E_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[permission-request-hook] ${message}\n`);
}

function trace(fields) {
  writeTraceStderr({
    component: "hook.permission_request",
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

function buildPermissionResult(decision) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };
}

async function main() {
  const input = await readStdinJSON();
  if (input?.hook_event_name !== "PermissionRequest") {
    writeResult({});
    return;
  }

  if (
    input?.tool_name === "AskUserQuestion" &&
    input?.tool_input &&
    typeof input.tool_input === "object" &&
    input.tool_input.answers &&
    typeof input.tool_input.answers === "object" &&
    Object.keys(input.tool_input.answers).length > 0
  ) {
    trace({
      stage: "ask_user_question_allowed",
      session_id: input.session_id,
    });
    logDebug("allowing AskUserQuestion because remote answers are already present");
    writeResult(buildPermissionResult({ behavior: "allow" }));
    return;
  }

  const accessStore = new AccessStore(resolveAccessPath());
  await accessStore.load();
  if (!accessStore.hasApprovers()) {
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
      tool_name: input.tool_name,
      reason: contextResolution.reason || "no_channel_context",
    });
    process.stderr.write(
      `permission-request-hook bridge skipped: ${contextResolution.reason || "no_channel_context"}\n`,
    );
    writeResult({});
    return;
  }

  const approvalStore = new ApprovalStore({
    requestsDir: resolveApprovalRequestsDir(),
    notificationsDir: resolveApprovalNotificationsDir(),
  });
  await approvalStore.init();

  const request = await approvalStore.createPermissionRequest({
    request_id: randomUUID(),
    created_at: Date.now(),
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    permission_suggestions: input.permission_suggestions ?? [],
    channel_context: contextResolution.context,
  });
  trace({
    stage: "approval_request_created",
    request_id: request.request_id,
    event_id: request.channel_context.event_id,
    chat_id: request.channel_context.chat_id,
    session_id: request.session_id,
    tool_name: request.tool_name,
  });
  logDebug(
    `created request_id=${request.request_id} chat_id=${request.channel_context.chat_id} tool=${String(input.tool_name ?? "")}`,
  );

  const deadlineAt = Date.now() + remoteApprovalTimeoutMs;
  while (Date.now() < deadlineAt) {
    const current = await approvalStore.getRequest(request.request_id);
    if (current?.status === "resolved" && current.decision) {
      trace({
        stage: "approval_request_resolved",
        request_id: current.request_id,
        event_id: current.channel_context.event_id,
        chat_id: current.channel_context.chat_id,
        session_id: current.session_id,
        decision: current.decision.behavior,
      });
      logDebug(`resolved request_id=${request.request_id}`);
      writeResult(buildPermissionResult(current.decision));
      return;
    }
    if (current?.status === "expired") {
      break;
    }
    await sleep(pollIntervalMs);
  }

  await approvalStore.markExpired(request.request_id);
  trace({
    stage: "approval_request_expired",
    request_id: request.request_id,
    event_id: request.channel_context.event_id,
    chat_id: request.channel_context.chat_id,
    session_id: request.session_id,
  });
  logDebug(`expired request_id=${request.request_id}`);
  writeResult(buildPermissionResult({
    behavior: "deny",
    message: "Remote approval timed out.",
    interrupt: true,
  }));
}

main().catch((error) => {
  process.stderr.write(`permission-request-hook failed: ${String(error)}\n`);
  writeResult({});
});
