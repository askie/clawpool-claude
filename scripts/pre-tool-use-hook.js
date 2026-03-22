import { randomUUID } from "node:crypto";
import process from "node:process";
import { resolveHookChannelContext } from "../server/channel-context-resolution.js";
import { ChannelContextStore } from "../server/channel-context-store.js";
import {
  resolveQuestionRequestsDir,
  resolveSessionContextsDir,
} from "../server/paths.js";
import { QuestionStore } from "../server/question-store.js";

const remoteQuestionTimeoutMs = 10 * 60 * 1000;
const pollIntervalMs = 1000;
const recentChannelContextMaxAgeMs = 30 * 60 * 1000;

function logDebug(message) {
  if (process.env.CLAWPOOL_E2E_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[pre-tool-use-hook] ${message}\n`);
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

function buildAllowResult(updatedInput) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

function buildDenyResult(reason) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function main() {
  const input = await readStdinJSON();
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "AskUserQuestion") {
    writeResult({});
    return;
  }

  const questions = Array.isArray(input?.tool_input?.questions) ? input.tool_input.questions : [];
  if (questions.length === 0) {
    writeResult({});
    return;
  }

  const sessionContextStore = new ChannelContextStore(resolveSessionContextsDir());
  const contextResolution = await resolveHookChannelContext({
    sessionContextStore,
    sessionID: input.session_id,
    transcriptPath: input.transcript_path,
    maxAgeMs: recentChannelContextMaxAgeMs,
  });
  logDebug(
    `context session=${String(input.session_id ?? "")} transcript=${String(input.transcript_path ?? "")} status=${contextResolution.status} reason=${contextResolution.reason || ""} source=${contextResolution.source || ""}`,
  );
  if (contextResolution.status !== "resolved" || !contextResolution.context?.chat_id) {
    process.stderr.write(
      `pre-tool-use-hook bridge skipped: ${contextResolution.reason || "no_channel_context"}\n`,
    );
    writeResult({});
    return;
  }

  const questionStore = new QuestionStore({
    requestsDir: resolveQuestionRequestsDir(),
  });
  await questionStore.init();

  const request = await questionStore.createQuestionRequest({
    request_id: randomUUID(),
    created_at: Date.now(),
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    questions,
    channel_context: contextResolution.context,
  });
  logDebug(
    `created request_id=${request.request_id} chat_id=${request.channel_context.chat_id} question_count=${request.questions.length}`,
  );

  const deadlineAt = Date.now() + remoteQuestionTimeoutMs;
  while (Date.now() < deadlineAt) {
    const current = await questionStore.getRequest(request.request_id);
    if (current?.status === "resolved" && current.answers) {
      logDebug(`resolved request_id=${request.request_id}`);
      writeResult(buildAllowResult({
        questions: current.questions,
        answers: current.answers,
      }));
      return;
    }
    if (current?.status === "expired") {
      break;
    }
    await sleep(pollIntervalMs);
  }

  await questionStore.markExpired(request.request_id);
  logDebug(`expired request_id=${request.request_id}`);
  writeResult(buildDenyResult("Remote question timed out."));
}

main().catch((error) => {
  process.stderr.write(`pre-tool-use-hook failed: ${String(error)}\n`);
  writeResult({});
});
