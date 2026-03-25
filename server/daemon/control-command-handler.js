import { randomUUID } from "node:crypto";
import { resolveWorkerPluginDataDir } from "./daemon-paths.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function defaultFormatBindingSummary(binding) {
  if (!binding) {
    return "当前会话还没有绑定目录。";
  }
  return [
    `Aibot 会话: ${binding.aibot_session_id}`,
    `Claude 会话: ${binding.claude_session_id}`,
    `目录: ${binding.cwd}`,
    `Worker 状态: ${binding.worker_status}`,
  ].join("\n");
}

function defaultBuildMissingBindingCardOptions() {
  return {
    summaryText: "当前会话还没有绑定目录。",
    detailText: "发送 open <目录> 来创建会话。",
  };
}

function defaultFormatRuntimeError(error, fallback = "处理失败。") {
  const message = normalizeString(error?.message || error);
  return message || fallback;
}

export class DaemonControlCommandHandler {
  constructor({
    env = process.env,
    bindingRegistry,
    workerProcessManager,
    bridgeServer,
    ensureWorker,
    respond,
    respondWithOpenWorkspaceCard,
    ensureDirectoryExists,
    formatBindingSummary = defaultFormatBindingSummary,
    buildMissingBindingCardOptions = defaultBuildMissingBindingCardOptions,
    formatRuntimeError = defaultFormatRuntimeError,
  } = {}) {
    this.env = env;
    this.bindingRegistry = bindingRegistry;
    this.workerProcessManager = workerProcessManager;
    this.bridgeServer = bridgeServer;
    this.ensureWorker = ensureWorker;
    this.respond = respond;
    this.respondWithOpenWorkspaceCard = respondWithOpenWorkspaceCard;
    this.ensureDirectoryExists = ensureDirectoryExists;
    this.formatBindingSummary = formatBindingSummary;
    this.buildMissingBindingCardOptions = buildMissingBindingCardOptions;
    this.formatRuntimeError = formatRuntimeError;
  }

  async handleOpenCommand(event, parsed) {
    const cwd = normalizeString(parsed.args.cwd);
    await this.ensureDirectoryExists(cwd);

    const existing = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (existing) {
      if (existing.cwd !== cwd) {
        await this.respond(
          event,
          `当前会话已经固定绑定目录，不能改成新目录。\n\n${this.formatBindingSummary(existing)}`,
          { reply_source: "daemon_control_open_reject" },
        );
        return;
      }

      await this.ensureWorker(existing);
      await this.respond(
        event,
        `当前会话已经绑定，已按原目录恢复或保持原会话。\n\n${this.formatBindingSummary(existing)}`,
        { reply_source: "daemon_control_open_existing" },
      );
      return;
    }

    const workerID = randomUUID();
    const claudeSessionID = randomUUID();
    const pluginDataDir = resolveWorkerPluginDataDir(event.session_id, this.env);
    const created = await this.bindingRegistry.createBinding({
      aibot_session_id: event.session_id,
      claude_session_id: claudeSessionID,
      cwd,
      worker_id: workerID,
      worker_status: "starting",
      plugin_data_dir: pluginDataDir,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_started_at: Date.now(),
      last_stopped_at: 0,
    });

    await this.workerProcessManager.spawnWorker({
      aibotSessionID: created.aibot_session_id,
      cwd: created.cwd,
      pluginDataDir: created.plugin_data_dir,
      claudeSessionID: created.claude_session_id,
      workerID: created.worker_id,
      bridgeURL: this.bridgeServer.getURL(),
      bridgeToken: this.bridgeServer.token,
    });

    await this.respond(
      event,
      `已新建目录会话。\n\n${this.formatBindingSummary(created)}`,
      { reply_source: "daemon_control_open_created" },
    );
  }

  async handleStatusCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...this.buildMissingBindingCardOptions(),
        replySource: "daemon_control_status_missing",
      });
      return;
    }
    await this.respond(event, this.formatBindingSummary(binding), {
      reply_source: "daemon_control_status",
    });
  }

  async handleWhereCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...this.buildMissingBindingCardOptions(),
        replySource: "daemon_control_where_missing",
      });
      return;
    }
    const text = `当前目录: ${binding.cwd}`;
    await this.respond(event, text, {
      reply_source: "daemon_control_where",
    });
  }

  async handleStopCommand(event) {
    const binding = this.bindingRegistry.getByAibotSessionID(event.session_id);
    if (!binding) {
      await this.respondWithOpenWorkspaceCard(event, {
        ...this.buildMissingBindingCardOptions(),
        replySource: "daemon_control_stop_missing",
      });
      return;
    }

    if (binding.worker_id) {
      await this.workerProcessManager.stopWorker(binding.worker_id);
    }
    await this.bindingRegistry.markWorkerStopped(event.session_id, {
      updatedAt: Date.now(),
      lastStoppedAt: Date.now(),
    });
    await this.respond(event, `已停止当前会话对应的 Claude。\n\n${this.formatBindingSummary({
      ...binding,
      worker_status: "stopped",
    })}`, {
      reply_source: "daemon_control_stop",
    });
  }

  async handleControlCommand(event, parsed) {
    if (!parsed.ok) {
      if (parsed.command === "open") {
        await this.respondWithOpenWorkspaceCard(event, {
          summaryText: parsed.error,
          replySource: "daemon_control_invalid",
        });
        return true;
      }
      await this.respond(event, parsed.error, {
        reply_source: "daemon_control_invalid",
      });
      return true;
    }

    try {
      switch (parsed.command) {
        case "open":
          await this.handleOpenCommand(event, parsed);
          return true;
        case "status":
          await this.handleStatusCommand(event);
          return true;
        case "where":
          await this.handleWhereCommand(event);
          return true;
        case "stop":
          await this.handleStopCommand(event);
          return true;
        default:
          return false;
      }
    } catch (error) {
      const message = this.formatRuntimeError(error, "命令执行失败。");
      if (parsed.command === "open") {
        await this.respondWithOpenWorkspaceCard(event, {
          summaryText: message,
          detailText: "发送 open <目录> 来创建会话。",
          replySource: "daemon_control_open_error",
        });
        return true;
      }
      await this.respond(event, message, {
        reply_source: "daemon_control_error",
      });
      return true;
    }
  }
}
