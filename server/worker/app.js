import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccessStore } from "../access-store.js";
import { ApprovalStore } from "../approval-store.js";
import { ChannelContextStore } from "../channel-context-store.js";
import { ConfigStore } from "../config-store.js";
import { EventState } from "../event-state.js";
import { QuestionStore } from "../question-store.js";
import {
  resolveAccessPath,
  resolveApprovalNotificationsDir,
  resolveApprovalRequestsDir,
  resolveConfigPath,
  resolveEventStatesDir,
  resolveQuestionRequestsDir,
  resolveSessionContextsDir,
} from "../paths.js";
import { saveEventEntry } from "../event-state-persistence.js";
import { createProcessLogger } from "../logging.js";
import { DaemonBridgeRuntime } from "./bridge-runtime.js";
import { WorkerHumanLoopService } from "./human-loop-service.js";
import { WorkerInteractionService } from "./interaction-service.js";
import { WorkerToolService } from "./tool-service.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function buildInstructions() {
  return [
    'Messages arrive as <channel source="clawpool-claude" chat_id="..." event_id="..." message_id="..." user_id="...">text</channel>.',
    "When present, channel metadata includes msg_type plus JSON strings in attachments_json, biz_card_json, channel_data_json, and extra_json. Use those structured fields directly instead of guessing attachment or card semantics from text.",
    "If you want to send a visible reply back to the same chat, call the reply tool with chat_id, event_id, and text. You may also pass reply_to when you want to quote a specific message_id.",
    "The reply tool also accepts files as absolute local paths. Files are uploaded through the Agent API media presign endpoint before they are sent back to the chat.",
    "If you need to remove a previously sent message, call delete_message with chat_id and message_id.",
    "If you intentionally do not want to send a visible reply, you must call the complete tool with event_id and a final status.",
    "Always preserve event_id when using reply or complete. The plugin uses it to enforce stop fences and finish the Aibot event lifecycle.",
  ].join(" ");
}

export function createWorkerApp({ env = process.env } = {}) {
  const logger = createProcessLogger({ env });
  const eventStatesDir = resolveEventStatesDir();
  const configStore = new ConfigStore(resolveConfigPath());
  const accessStore = new AccessStore(resolveAccessPath());
  const approvalStore = new ApprovalStore({
    requestsDir: resolveApprovalRequestsDir(),
    notificationsDir: resolveApprovalNotificationsDir(),
  });
  const questionStore = new QuestionStore({
    requestsDir: resolveQuestionRequestsDir(),
  });
  const sessionContextStore = new ChannelContextStore(resolveSessionContextsDir());
  const eventState = new EventState({
    onChange(entry) {
      void saveEventEntry(eventStatesDir, entry).catch((error) => {
        logger.error(`event state persist failed event=${entry.event_id}: ${String(error)}`);
      });
    },
  });
  const mcp = new Server(
    {
      name: "clawpool-claude",
      version: "0.1.0",
    },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
        },
        tools: {},
      },
      instructions: buildInstructions(),
    },
  );

  let interactionService = null;
  const bridge = new DaemonBridgeRuntime({
    env,
    logger,
    onDeliverEvent: async (payload) => {
      await interactionService?.handleInboundEvent(payload);
    },
    onDeliverStop: async (payload) => {
      await interactionService?.handleStopEvent(payload);
    },
    onDeliverRevoke: async (payload) => {
      await interactionService?.handleRevokeEvent(payload);
    },
  });
  const humanLoopService = new WorkerHumanLoopService({
    accessStore,
    approvalStore,
    questionStore,
    bridge,
    finalizeEvent: async (eventID, result, context) => (
      interactionService?.finalizeEventSafely?.(eventID, result, context) ?? false
    ),
    logger,
  });

  interactionService = new WorkerInteractionService({
    eventState,
    sessionContextStore,
    accessStore,
    eventStatesDir,
    mcp,
    bridge,
    humanLoopService,
    logger,
  });

  const toolService = new WorkerToolService({
    mcp,
    bridge,
    configStore,
    accessStore,
    approvalStore,
    questionStore,
    eventState,
    messageRuntime: interactionService,
    logger,
  });
  toolService.registerHandlers();

  return {
    logger,
    async bootstrap() {
      bridge.requireDaemonBridge();
      await configStore.load();
      await accessStore.load();
      await approvalStore.init();
      await questionStore.init();
      await interactionService.restoreEventState();
      await bridge.startControlServer();
      await bridge.registerWorker({
        cwd: process.cwd(),
        pluginDataDir: normalizeOptionalString(env.CLAUDE_PLUGIN_DATA),
        pid: process.pid,
      });
      await mcp.connect(new StdioServerTransport());
      await bridge.sendConnectedStatus();
      interactionService.startDispatchPumps();
      logger.info("worker connected in daemon bridge mode");
    },
    async shutdown() {
      await interactionService.shutdown();
      await bridge.shutdown();
    },
  };
}
