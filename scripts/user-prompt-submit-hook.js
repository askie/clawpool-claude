import process from "node:process";
import { ChannelContextStore } from "../server/channel-context-store.js";
import { HookSignalStore } from "../server/hook-signal-store.js";
import { resolveSessionContextsDir } from "../server/paths.js";
import { extractLatestClawpoolChannelTag } from "../server/transcript-channel-context.js";

function logDebug(message) {
  if (process.env.CLAWPOOL_CLAUDE_E2E_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[user-prompt-submit-hook] ${message}\n`);
}

async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function main() {
  const input = await readStdinJSON();
  const hookSignalStore = new HookSignalStore();
  if (input?.hook_event_name !== "UserPromptSubmit") {
    return;
  }

  await hookSignalStore.recordHookEvent(input);

  const context = extractLatestClawpoolChannelTag(input.prompt);
  if (!context?.chat_id) {
    logDebug(`no channel tag session=${String(input.session_id ?? "")}`);
    return;
  }

  const store = new ChannelContextStore(resolveSessionContextsDir());
  await store.put({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    updated_at: Date.now(),
    context,
  });
  logDebug(
    `stored session=${String(input.session_id ?? "")} cwd=${String(input.cwd ?? "")} chat_id=${context.chat_id}`,
  );
}

main().catch((error) => {
  process.stderr.write(`user-prompt-submit-hook failed: ${String(error)}\n`);
});
