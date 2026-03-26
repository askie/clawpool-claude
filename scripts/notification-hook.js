import process from "node:process";
import { ApprovalStore } from "../server/approval-store.js";
import { HookSignalStore } from "../server/hook-signal-store.js";
import { resolveApprovalNotificationsDir, resolveApprovalRequestsDir } from "../server/paths.js";

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
  const approvalStore = new ApprovalStore({
    requestsDir: resolveApprovalRequestsDir(),
    notificationsDir: resolveApprovalNotificationsDir(),
  });
  await approvalStore.init();
  await approvalStore.recordNotification(input);
  await hookSignalStore.recordHookEvent(input);
  process.stdout.write("{}\n");
}

main().catch((error) => {
  process.stderr.write(`notification-hook failed: ${String(error)}\n`);
  process.stdout.write("{}\n");
});
