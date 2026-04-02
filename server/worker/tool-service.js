import { randomUUID } from "node:crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { uploadReplyFileToAgentMedia } from "../agent-api-media.js";
import {
  resolveOutboundTextChunkLimit,
  splitTextForAibotProtocol,
} from "../protocol-text.js";
import { buildAccessStatusBizCard } from "../claude-card-payload.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value);
  return normalized || "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter((item) => item);
}

function mergeRecords(...records) {
  return Object.assign({}, ...records);
}

function toolTextResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

const toolDefinitions = [
  {
    name: "reply",
    description: "Send a visible message back to the chat for this grix-claude event.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "The target chat/session id from the <channel> tag.",
        },
        event_id: {
          type: "string",
          description: "The Aibot event_id from the <channel> tag.",
        },
        text: {
          type: "string",
          description: "The visible reply text to send.",
        },
        files: {
          type: "array",
          description: "Optional absolute local file paths. Each file is uploaded through Agent API OSS presign before sending.",
          items: {
            type: "string",
          },
        },
        reply_to: {
          type: "string",
          description: "Optional message_id to quote instead of the inbound trigger message.",
        },
      },
      required: ["chat_id", "event_id"],
    },
  },
  {
    name: "delete_message",
    description: "Delete a previously sent message in the same grix-claude chat.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["chat_id", "message_id"],
    },
  },
  {
    name: "complete",
    description: "Finish an event without sending a visible reply so the backend does not time out.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        status: { type: "string", enum: ["responded", "canceled", "failed"] },
        code: { type: "string" },
        msg: { type: "string" },
      },
      required: ["event_id", "status"],
    },
  },
  {
    name: "status",
    description: "Show grix-claude configuration, access policy, daemon bridge status, and startup hints.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "access_pair",
    description: "Approve a pending sender pairing code and add that sender to the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "access_deny",
    description: "Deny a pending sender pairing code and clear it from pending state.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    name: "allow_sender",
    description: "Add a sender_id directly to the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "remove_sender",
    description: "Remove a sender_id from the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "allow_approver",
    description: "Add a sender_id to the Claude remote approval allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "remove_approver",
    description: "Remove a sender_id from the Claude remote approval allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        sender_id: { type: "string" },
      },
      required: ["sender_id"],
    },
  },
  {
    name: "access_policy",
    description: "Update the sender access policy for this channel.",
    inputSchema: {
      type: "object",
      properties: {
        policy: { type: "string", enum: ["allowlist", "open", "disabled"] },
      },
      required: ["policy"],
    },
  },
];

export class WorkerToolService {
  constructor({
    mcp,
    bridge,
    configStore,
    accessStore,
    approvalStore,
    elicitationStore,
    permissionRelayService = null,
    eventState,
    messageRuntime,
    logger,
  }) {
    this.mcp = mcp;
    this.bridge = bridge;
    this.configStore = configStore;
    this.accessStore = accessStore;
    this.approvalStore = approvalStore;
    this.elicitationStore = elicitationStore;
    this.permissionRelayService = permissionRelayService;
    this.eventState = eventState;
    this.messageRuntime = messageRuntime;
    this.logger = logger;
  }

  async buildStatusPayload() {
    return {
      config: this.configStore.getStatus(),
      access: this.accessStore.getStatus(),
      approvals: this.permissionRelayService?.getStatus?.() ?? await this.approvalStore.getStatus(),
      questions: await this.elicitationStore.getStatus(),
      connection: this.bridge.getConnectionStatus(),
      hints: this.bridge.buildStatusHints(),
    };
  }

  async handleReplyTool(args) {
    const chatID = normalizeString(args.chat_id);
    const eventID = normalizeString(args.event_id);
    const replyTo = normalizeOptionalString(args.reply_to);
    const text = String(args.text ?? "");
    const files = normalizeStringArray(args.files);
    this.logger.debug(
      `tool reply event=${eventID} chat=${chatID} reply_to=${replyTo} text=${JSON.stringify(text)} files=${files.length}`,
    );
    if (!chatID || !eventID || (!text.trim() && files.length === 0)) {
      throw new Error("reply requires chat_id, event_id, and at least one of text or files");
    }
    this.logger.trace?.({
      component: "worker.tool",
      stage: "reply_requested",
      event_id: eventID,
      session_id: chatID,
      reply_to: replyTo,
      text_chunks: text.trim() ? splitTextForAibotProtocol(text, resolveOutboundTextChunkLimit(
        this.configStore.getConnectionConfig()?.outboundTextChunkLimit,
        1200,
      )).length : 0,
      file_count: files.length,
    });

    const event = this.eventState.get(eventID);
    if (!event) {
      return toolTextResult("ignored: event not found");
    }
    if (event.session_id !== chatID) {
      throw new Error("chat_id does not match event session");
    }
    if (event.completed) {
      return toolTextResult("ignored: event already completed");
    }
    if (event.stopped) {
      return toolTextResult("ignored: event already stopped");
    }

    const connectionConfig = this.configStore.getConnectionConfig();
    if (!connectionConfig) {
      throw new Error("grix-claude is not configured");
    }

    const chunkLimit = resolveOutboundTextChunkLimit(
      connectionConfig.outboundTextChunkLimit,
      1200,
    );
    const chunks = splitTextForAibotProtocol(text, chunkLimit);
    let chunkIndex = 0;
    const sentMessageIDs = [];

    try {
      for (const chunk of chunks) {
        const current = this.eventState.get(eventID);
        if (!current || current.completed || current.stopped) {
          return toolTextResult("ignored: event no longer active");
        }
        chunkIndex += 1;
        const ack = await this.bridge.sendText({
          eventID,
          sessionID: chatID,
          text: chunk,
          quotedMessageID: replyTo || current.msg_id,
          clientMsgID: `${randomUUID()}_${chunkIndex}`,
          extra: {
            reply_source: "claude_channel",
          },
        });
        const messageID = normalizeOptionalString(ack.msg_id);
        if (messageID) {
          sentMessageIDs.push(messageID);
        }
      }

      for (const filePath of files) {
        const current = this.eventState.get(eventID);
        if (!current || current.completed || current.stopped) {
          return toolTextResult("ignored: event no longer active");
        }

        chunkIndex += 1;
        const upload = await uploadReplyFileToAgentMedia({
          wsURL: connectionConfig.wsURL,
          apiKey: connectionConfig.apiKey,
          sessionID: chatID,
          filePath,
        });
        const ack = await this.bridge.sendMedia({
          eventID,
          sessionID: chatID,
          mediaURL: upload.access_url,
          caption: upload.file_name,
          quotedMessageID: replyTo || current.msg_id,
          clientMsgID: `${randomUUID()}_${chunkIndex}`,
          extra: mergeRecords(
            {
              reply_source: "claude_channel",
            },
            upload.extra,
          ),
        });
        const messageID = normalizeOptionalString(ack.msg_id);
        if (messageID) {
          sentMessageIDs.push(messageID);
        }
      }
    } catch (error) {
      this.logger.trace?.({
        component: "worker.tool",
        stage: "reply_failed",
        event_id: eventID,
        session_id: chatID,
        error: error instanceof Error ? error.message : String(error),
      }, { level: "error" });
      const current = this.eventState.get(eventID);
      if (!current || current.completed || current.stopped) {
        return toolTextResult("ignored: event no longer active");
      }
      await this.messageRuntime.finalizeEventSafely(eventID, {
        status: "failed",
        code: "send_msg_failed",
        msg: String(error),
      }, "send_msg failure result send failed");
      throw error;
    }

    if (!await this.messageRuntime.finalizeEventSafely(eventID, {
      status: "responded",
    }, "reply terminal result failed")) {
      return toolTextResult("sent: backend finalization pending retry");
    }
    this.logger.trace?.({
      component: "worker.tool",
      stage: "reply_sent",
      event_id: eventID,
      session_id: chatID,
      message_count: sentMessageIDs.length,
      file_count: files.length,
    });
    if (sentMessageIDs.length === 1) {
      return toolTextResult(`sent (id: ${sentMessageIDs[0]})`);
    }
    if (sentMessageIDs.length > 1) {
      return toolTextResult(`sent ${sentMessageIDs.length} parts (ids: ${sentMessageIDs.join(", ")})`);
    }
    return toolTextResult("sent");
  }

  async handleCompleteTool(args) {
    const eventID = normalizeString(args.event_id);
    const status = normalizeString(args.status);
    const code = normalizeOptionalString(args.code);
    const msg = normalizeOptionalString(args.msg);
    this.logger.debug(
      `tool complete event=${eventID} status=${status} code=${code} msg=${JSON.stringify(msg)}`,
    );
    if (!eventID || !status) {
      throw new Error("complete requires event_id and status");
    }
    this.logger.trace?.({
      component: "worker.tool",
      stage: "complete_requested",
      event_id: eventID,
      status,
      code,
    });
    if (!["responded", "canceled", "failed"].includes(status)) {
      throw new Error("complete status must be responded, canceled, or failed");
    }

    const event = this.eventState.get(eventID);
    if (!event) {
      return toolTextResult("ignored: event not found");
    }
    if (event.completed) {
      return toolTextResult("ignored: event already completed");
    }
    if (event.stopped) {
      return toolTextResult("ignored: event already stopped");
    }

    if (!await this.messageRuntime.finalizeEventSafely(eventID, {
      status,
      code,
      msg,
    }, "complete terminal result failed")) {
      return toolTextResult("completed: backend finalization pending retry");
    }
    this.logger.trace?.({
      component: "worker.tool",
      stage: "complete_sent",
      event_id: eventID,
      status,
      code,
    });
    return toolTextResult("completed");
  }

  async handleStatusTool() {
    return toolTextResult(await this.buildStatusPayload());
  }

  async handleDeleteMessageTool(args) {
    const chatID = normalizeString(args.chat_id);
    const messageID = normalizeString(args.message_id);
    this.logger.debug(`tool delete_message chat=${chatID} message=${messageID}`);
    if (!chatID || !messageID) {
      throw new Error("delete_message requires chat_id and message_id");
    }

    this.logger.trace?.({
      component: "worker.tool",
      stage: "delete_message_requested",
      session_id: chatID,
      msg_id: messageID,
    });
    await this.bridge.deleteMessage(chatID, messageID);
    return toolTextResult(`deleted (${messageID})`);
  }

  async notifyApprovedSender(sessionID) {
    try {
      await this.messageRuntime.sendAccessStatusMessage(
        sessionID,
        "Paired! Say hi to Claude.",
        `pair_ok_${randomUUID()}`,
        buildAccessStatusBizCard({
          summary: "Paired! Say hi to Claude.",
          status: "success",
        }),
      );
      return true;
    } catch (error) {
      this.logger.error(`pairing confirmation send failed session=${sessionID}: ${String(error)}`);
      return false;
    }
  }

  async notifyDeniedSender(sessionID, code) {
    try {
      await this.messageRuntime.sendAccessStatusMessage(
        sessionID,
        `Pairing request ${code} was denied. Ask the Claude Code user to request a new pairing code if you still need access.`,
        `pair_denied_${randomUUID()}`,
        buildAccessStatusBizCard({
          summary: `Pairing request ${code} was denied. Ask the Claude Code user to request a new pairing code if you still need access.`,
          status: "warning",
          referenceID: code,
        }),
      );
      return true;
    } catch (error) {
      this.logger.error(`pairing denial send failed session=${sessionID}: ${String(error)}`);
      return false;
    }
  }

  async handleAccessPairTool(args) {
    const result = await this.accessStore.approvePairing(args.code);
    const pairing_notice_sent = await this.notifyApprovedSender(result.session_id);
    return toolTextResult({
      ...result,
      pairing_notice_sent,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleAccessDenyTool(args) {
    const result = await this.accessStore.denyPairing(args.code);
    const pairing_notice_sent = await this.notifyDeniedSender(result.session_id, result.code);
    return toolTextResult({
      ...result,
      pairing_notice_sent,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleAllowSenderTool(args) {
    const result = await this.accessStore.allowSender(args.sender_id);
    return toolTextResult({
      ...result,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleAllowApproverTool(args) {
    const result = await this.accessStore.allowApprover(args.sender_id);
    return toolTextResult({
      ...result,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleRemoveSenderTool(args) {
    const result = await this.accessStore.removeSender(args.sender_id);
    return toolTextResult({
      ...result,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleRemoveApproverTool(args) {
    const result = await this.accessStore.removeApprover(args.sender_id);
    return toolTextResult({
      ...result,
      hints: this.bridge.buildStatusHints(),
    });
  }

  async handleAccessPolicyTool(args) {
    const result = await this.accessStore.setPolicy(args.policy);
    return toolTextResult({
      ...result,
      hints: this.bridge.buildStatusHints(),
    });
  }

  registerHandlers() {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.trace?.({
        component: "worker.tool",
        stage: "mcp_list_tools_received",
        tool_count: toolDefinitions.length,
      });
      await this.bridge.reportWorkerReadyOnce();
      this.logger.trace?.({
        component: "worker.tool",
        stage: "mcp_list_tools_completed",
        tool_count: toolDefinitions.length,
      });
      return {
        tools: toolDefinitions,
      };
    });

    this.mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = normalizeString(request.params.name);
      const args = request.params.arguments ?? {};
      this.logger.trace?.({
        component: "worker.tool",
        stage: "mcp_call_tool_received",
        tool_name: name,
        event_id: normalizeOptionalString(args.event_id),
        session_id: normalizeOptionalString(args.chat_id),
      });
      await this.bridge.reportWorkerReadyOnce();

      try {
        let result;
        switch (name) {
          case "reply":
            result = await this.handleReplyTool(args);
            break;
          case "delete_message":
            result = await this.handleDeleteMessageTool(args);
            break;
          case "complete":
            result = await this.handleCompleteTool(args);
            break;
          case "status":
            result = await this.handleStatusTool();
            break;
          case "access_pair":
            result = await this.handleAccessPairTool(args);
            break;
          case "access_deny":
            result = await this.handleAccessDenyTool(args);
            break;
          case "allow_sender":
            result = await this.handleAllowSenderTool(args);
            break;
          case "remove_sender":
            result = await this.handleRemoveSenderTool(args);
            break;
          case "allow_approver":
            result = await this.handleAllowApproverTool(args);
            break;
          case "remove_approver":
            result = await this.handleRemoveApproverTool(args);
            break;
          case "access_policy":
            result = await this.handleAccessPolicyTool(args);
            break;
          default:
            throw new Error(`unknown tool: ${name}`);
        }
        this.logger.trace?.({
          component: "worker.tool",
          stage: "mcp_call_tool_completed",
          tool_name: name,
          event_id: normalizeOptionalString(args.event_id),
          session_id: normalizeOptionalString(args.chat_id),
        });
        return result;
      } catch (error) {
        this.logger.trace?.({
          component: "worker.tool",
          stage: "mcp_call_tool_failed",
          tool_name: name,
          event_id: normalizeOptionalString(args.event_id),
          session_id: normalizeOptionalString(args.chat_id),
          error: error instanceof Error ? error.message : String(error),
        }, { level: "error" });
        throw error;
      }
    });
  }
}
