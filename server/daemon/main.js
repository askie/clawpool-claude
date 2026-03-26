import process from "node:process";
import { resolveDaemonConfigPath, resolveDaemonDataDir } from "./daemon-paths.js";
import { ConfigStore } from "../config-store.js";
import {
  resolveBindingRegistryPath,
  resolveMessageDeliveryStatePath,
  resolveWorkerRuntimeRegistryPath,
} from "./daemon-paths.js";
import { BindingRegistry } from "./binding-registry.js";
import { MessageDeliveryStore } from "./message-delivery-store.js";
import { WorkerBridgeServer } from "./worker-bridge-server.js";
import { WorkerProcessManager } from "./worker-process.js";
import { AibotClient } from "../aibot-client.js";
import { DaemonRuntime } from "./runtime.js";
import { createSessionActivityDispatcher } from "../session-activity-dispatcher.js";
import { createProcessLogger } from "../logging.js";
import { DaemonProcessState } from "./process-state.js";
import { SessionLogWriter } from "./session-log-writer.js";

const workerReadySettleDelayMs = 3000;

function usage() {
  return `用法:
  clawpool-claude daemon [options]

说明:
  常驻 daemon。负责对接 aibot、维护固定绑定，并调度 Claude worker。

  选项:
  --ws-url <value>      Aibot WebSocket 地址
  --agent-id <value>    Agent ID
  --api-key <value>     API Key
  --chunk-limit <n>     单段文本长度上限
  --data-dir <path>     daemon 数据目录
  --show-claude         开发调试时把 Claude 拉到可见的 Terminal 窗口
  --exit-after-ready    启动后立刻退出，用于检查配置
`;
}

function print(message) {
  process.stdout.write(`${message}\n`);
}

function parseArgs(argv) {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    exitAfterReady: argv.includes("--exit-after-ready"),
    showClaude: argv.includes("--show-claude"),
    wsUrl: readOption(argv, "--ws-url"),
    agentId: readOption(argv, "--agent-id"),
    apiKey: readOption(argv, "--api-key"),
    chunkLimit: readOption(argv, "--chunk-limit"),
    dataDir: readOption(argv, "--data-dir"),
  };
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return "";
  }
  const value = String(argv[index + 1] ?? "").trim();
  if (!value) {
    throw new Error(`${name} 缺少值`);
  }
  return value;
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

export function shouldNotifyWorkerReady(previousBinding, nextBinding, { pendingEventCount = 0 } = {}) {
  if (!nextBinding || normalizeString(nextBinding.worker_status) !== "ready") {
    return false;
  }
  if (Number(pendingEventCount) > 0) {
    return false;
  }
  return normalizeString(previousBinding?.worker_status) !== "ready";
}

export function shouldIgnoreWorkerStatusUpdate(previousBinding, payload) {
  if (!previousBinding) {
    return false;
  }

  const expectedWorkerID = normalizeString(previousBinding.worker_id);
  const incomingWorkerID = normalizeString(payload?.worker_id);
  if (expectedWorkerID && incomingWorkerID && expectedWorkerID !== incomingWorkerID) {
    return true;
  }

  const expectedClaudeSessionID = normalizeString(previousBinding.claude_session_id);
  const incomingClaudeSessionID = normalizeString(payload?.claude_session_id);
  if (
    expectedClaudeSessionID
    && incomingClaudeSessionID
    && expectedClaudeSessionID !== incomingClaudeSessionID
  ) {
    return true;
  }

  return false;
}

export function buildWorkerReadyNoticeText(binding) {
  return "claude ready! please retry again.";
}

export async function notifyWorkerReady(aibotClient, binding) {
  if (!aibotClient || !binding) {
    return null;
  }
  return aibotClient.sendText({
    sessionID: binding.aibot_session_id,
    text: buildWorkerReadyNoticeText(binding),
    extra: {
      reply_source: "daemon_worker_ready",
    },
  });
}

export async function run(argv = [], env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    print(usage());
    return 0;
  }

  const runtimeEnv = {
    ...env,
    ...(options.dataDir ? { CLAWPOOL_CLAUDE_DAEMON_DATA_DIR: options.dataDir } : {}),
    ...(options.showClaude ? { CLAWPOOL_CLAUDE_SHOW_CLAUDE_WINDOW: "1" } : {}),
  };
  const sessionLogWriter = new SessionLogWriter({ env: runtimeEnv });
  const logger = createProcessLogger({
    env: runtimeEnv,
    onTrace(fields, { level }) {
      void sessionLogWriter.writeTrace(fields, { level });
    },
  });

  const dataDir = resolveDaemonDataDir(runtimeEnv);
  const processState = new DaemonProcessState({
    env: runtimeEnv,
    dataDir,
  });
  await processState.acquire();
  const configStore = new ConfigStore(resolveDaemonConfigPath(runtimeEnv), {
    env: runtimeEnv,
  });
  const bindingRegistry = new BindingRegistry({
    bindingFilePath: resolveBindingRegistryPath(runtimeEnv),
    workerRuntimeFilePath: resolveWorkerRuntimeRegistryPath(runtimeEnv),
  });
  const messageDeliveryStore = new MessageDeliveryStore(
    resolveMessageDeliveryStatePath(runtimeEnv),
  );
  await configStore.load();
  if (options.wsUrl || options.agentId || options.apiKey || options.chunkLimit) {
    await configStore.update({
      ...(options.wsUrl ? { ws_url: options.wsUrl } : {}),
      ...(options.agentId ? { agent_id: options.agentId } : {}),
      ...(options.apiKey ? { api_key: options.apiKey } : {}),
      ...(options.chunkLimit ? { outbound_text_chunk_limit: Number(options.chunkLimit) } : {}),
    });
  }
  await bindingRegistry.load();
  await messageDeliveryStore.load();
  await bindingRegistry.resetTransientWorkerStates();
  const workerProcessManager = new WorkerProcessManager({
    env: runtimeEnv,
    connectionConfig: configStore.getConnectionConfig(),
  });
  await workerProcessManager.cleanupStaleManagedProcesses(
    bindingRegistry.listBindings().map((binding) => binding.aibot_session_id),
  );
  let aibotClient = null;
  let runtime = null;
  const dispatchSessionActivity = createSessionActivityDispatcher(async ({
    sessionID,
    kind = "composing",
    active,
    ttlMs = 0,
    refMsgID = "",
    refEventID = "",
  }) => {
    aibotClient.setSessionComposing({
      sessionID,
      kind,
      active,
      ttlMs,
      refMsgID,
      refEventID,
    });
  });

  const bridgeServer = new WorkerBridgeServer({
    logger,
    onRegisterWorker: async (payload) => {
      const aibotSessionID = String(payload?.aibot_session_id ?? "").trim();
      const workerID = String(payload?.worker_id ?? "").trim();
      const workerPid = normalizePid(payload?.pid);
      if (!aibotSessionID || !workerID) {
        throw new Error("aibot_session_id and worker_id are required");
      }
      const existing = bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (!existing) {
        return { ok: false, reason: "binding_not_found" };
      }
      await bindingRegistry.markWorkerStarting(aibotSessionID, {
        workerID,
        workerPid,
        workerControlURL: String(payload?.worker_control_url ?? "").trim(),
        workerControlToken: String(payload?.worker_control_token ?? "").trim(),
        updatedAt: Date.now(),
        lastStartedAt: Date.now(),
      });
      return { ok: true };
    },
    onStatusUpdate: async (payload) => {
      const aibotSessionID = String(payload?.aibot_session_id ?? "").trim();
      const status = String(payload?.status ?? "").trim();
      const workerPid = normalizePid(payload?.pid);
      if (!aibotSessionID || !status) {
        throw new Error("aibot_session_id and status are required");
      }
      const previousBinding = bindingRegistry.getByAibotSessionID(aibotSessionID);
      if (shouldIgnoreWorkerStatusUpdate(previousBinding, payload)) {
        logger.trace({
          stage: "worker_status_ignored_stale",
          aibot_session_id: aibotSessionID,
          status,
          worker_id: payload?.worker_id,
          claude_session_id: payload?.claude_session_id,
          expected_worker_id: previousBinding?.worker_id,
          expected_claude_session_id: previousBinding?.claude_session_id,
        }, { level: "error" });
        return { ok: true };
      }
      let nextBinding = null;
      if (status === "failed") {
        nextBinding = await bindingRegistry.markWorkerFailed(aibotSessionID, {
          updatedAt: Date.now(),
          lastStoppedAt: Date.now(),
        });
      } else if (status === "stopped") {
        nextBinding = await bindingRegistry.markWorkerStopped(aibotSessionID, {
          updatedAt: Date.now(),
          lastStoppedAt: Date.now(),
        });
      } else if (status === "connected") {
        nextBinding = await bindingRegistry.markWorkerConnected(aibotSessionID, {
          workerID: String(payload?.worker_id ?? "").trim(),
          workerPid,
          workerControlURL: String(payload?.worker_control_url ?? "").trim(),
          workerControlToken: String(payload?.worker_control_token ?? "").trim(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      } else {
        nextBinding = await bindingRegistry.markWorkerReady(aibotSessionID, {
          workerID: String(payload?.worker_id ?? "").trim(),
          workerPid,
          workerControlURL: String(payload?.worker_control_url ?? "").trim(),
          workerControlToken: String(payload?.worker_control_token ?? "").trim(),
          updatedAt: Date.now(),
          lastStartedAt: Date.now(),
        });
      }
      if (status === "ready") {
        const timer = setTimeout(() => {
          void (async () => {
            const currentBinding = bindingRegistry.getByAibotSessionID(aibotSessionID);
            if (
              !currentBinding ||
              currentBinding.worker_id !== nextBinding.worker_id ||
              currentBinding.worker_status !== "ready"
            ) {
              return;
            }
            await runtime?.handleWorkerStatusUpdate?.(previousBinding, currentBinding);
            const pendingEventCount = runtime?.listPendingEventsForSession?.(aibotSessionID)?.length ?? 0;
            if (shouldNotifyWorkerReady(previousBinding, currentBinding, { pendingEventCount })) {
              await notifyWorkerReady(aibotClient, currentBinding);
            }
          })().catch((error) => {
            logger.error(`ready status follow-up failed session=${aibotSessionID}: ${String(error)}`);
          });
        }, workerReadySettleDelayMs);
        timer.unref?.();
      } else {
        await runtime?.handleWorkerStatusUpdate?.(previousBinding, nextBinding);
      }
      return { ok: true };
    },
    onSendText: async (payload) => {
      const ack = await aibotClient.sendText({
        eventID: payload.event_id,
        sessionID: payload.session_id,
        text: payload.text,
        quotedMessageID: payload.quoted_message_id,
        clientMsgID: payload.client_msg_id,
        extra: payload.extra,
      });
      await runtime?.recordWorkerReplyObserved?.(payload, { kind: "text" });
      return ack;
    },
    onSendMedia: async (payload) => {
      const ack = await aibotClient.sendMedia({
        eventID: payload.event_id,
        sessionID: payload.session_id,
        mediaURL: payload.media_url,
        caption: payload.caption,
        quotedMessageID: payload.quoted_message_id,
        clientMsgID: payload.client_msg_id,
        extra: payload.extra,
      });
      await runtime?.recordWorkerReplyObserved?.(payload, { kind: "media" });
      return ack;
    },
    onDeleteMessage: async (payload) => aibotClient.deleteMessage(
      payload.session_id,
      payload.msg_id,
    ),
    onAckEvent: async (payload) => {
      aibotClient.ackEvent(payload.event_id, {
        sessionID: payload.session_id,
        msgID: payload.msg_id,
        receivedAt: payload.received_at,
      });
      return { ok: true };
    },
    onSendEventResult: async (payload) => {
      await runtime?.recordWorkerEventResultObserved?.(payload);
      aibotClient.sendEventResult(payload);
      await runtime?.handleEventCompleted?.(payload?.event_id);
      return { ok: true };
    },
    onSendEventStopAck: async (payload) => {
      aibotClient.sendEventStopAck(payload);
      return { ok: true };
    },
    onSendEventStopResult: async (payload) => {
      aibotClient.sendEventStopResult(payload);
      return { ok: true };
    },
    onSetSessionComposing: async (payload) => {
      try {
        await runtime?.handleWorkerSessionComposing?.(payload);
      } catch (error) {
        logger.error(
          `session composing activity refresh failed event=${String(payload?.ref_event_id ?? "")}: ${String(error)}`,
        );
      }
      await dispatchSessionActivity({
        sessionID: payload.session_id,
        kind: payload.kind,
        active: payload.active,
        ttlMs: payload.ttl_ms,
        refMsgID: payload.ref_msg_id,
        refEventID: payload.ref_event_id,
      });
      return { ok: true };
    },
  });
  try {
    await bridgeServer.start();

    aibotClient = new AibotClient();
    runtime = new DaemonRuntime({
      env: runtimeEnv,
      bindingRegistry,
      workerProcessManager,
      aibotClient,
      bridgeServer,
      messageDeliveryStore,
      logger,
    });
    aibotClient.onEventMessage = async (payload) => {
      await runtime.handleEvent(payload);
    };
    aibotClient.onEventStop = async (payload) => {
      await runtime.handleStopEvent(payload);
    };
    aibotClient.onEventRevoke = async (payload) => {
      await runtime.handleRevokeEvent(payload);
    };

    print("clawpool-claude daemon 已启动。");
    print(`数据目录: ${dataDir}`);
    print(`Bridge: ${bridgeServer.getURL()}`);
    print(`已配置: ${configStore.isConfigured() ? "yes" : "no"}`);

    const connectionConfig = configStore.getConnectionConfig();
    await processState.markRunning({
      bridgeURL: bridgeServer.getURL(),
      configured: configStore.isConfigured(),
      connectionState: connectionConfig ? "connecting" : "not_configured",
    });

    if (options.exitAfterReady) {
      await bridgeServer.stop();
      await processState.release({
        exitCode: 0,
        reason: "exit_after_ready",
      });
      return 0;
    }

    await workerProcessManager.ensureUserMcpServerConfigured();

    if (connectionConfig) {
      await aibotClient.start(connectionConfig);
      await runtime.recoverPersistedDeliveryState();
      await processState.markRunning({
        bridgeURL: bridgeServer.getURL(),
        configured: true,
        connectionState: "connected",
      });
      print("Aibot: connected");
    } else {
      await runtime.recoverPersistedDeliveryState();
      await processState.markRunning({
        bridgeURL: bridgeServer.getURL(),
        configured: false,
        connectionState: "not_configured",
      });
      print("Aibot: not configured");
    }

    await new Promise((resolve) => {
      const stop = async () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await processState.markStopping("signal");
        await aibotClient.stop();
        await bridgeServer.stop();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await processState.release({
      exitCode: 0,
      reason: "signal",
    });
    return 0;
  } catch (error) {
    await processState.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  process.exitCode = await run(argv, env);
}
