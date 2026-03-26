import process from "node:process";
import { HookSignalStore } from "../server/hook-signal-store.js";

const supportedHookEvents = new Set([
  "SessionStart",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

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
  const hookEventName = String(input?.hook_event_name ?? "").trim();
  if (!supportedHookEvents.has(hookEventName)) {
    return;
  }

  const hookSignalStore = new HookSignalStore();
  await hookSignalStore.recordHookEvent(input);
}

main().catch((error) => {
  process.stderr.write(`lifecycle-hook failed: ${String(error)}\n`);
});
