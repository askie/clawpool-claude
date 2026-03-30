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

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function resolvePersistedWorkerPid(binding) {
  const bindingPid = normalizePid(binding?.worker_pid);
  if (bindingPid > 0) {
    return bindingPid;
  }
  return 0;
}

function resolveRecordInteractionAt(record) {
  const updatedAt = Number(record?.updated_at ?? 0);
  const composingAt = Number(record?.last_composing_at ?? 0);
  const normalizedUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
  const normalizedComposingAt = Number.isFinite(composingAt) && composingAt > 0 ? composingAt : 0;
  return Math.max(normalizedUpdatedAt, normalizedComposingAt);
}

function resolveHookActivityAt(pingPayload) {
  const hookEventName = normalizeString(
    pingPayload?.hook_latest_event?.hook_event_name,
  );
  if (hookEventName === "Stop") {
    return 0;
  }
  const hookActivityAt = Number(pingPayload?.hook_last_activity_at ?? 0);
  if (!Number.isFinite(hookActivityAt) || hookActivityAt <= 0) {
    return 0;
  }
  return hookActivityAt;
}

function buildMcpHealthContext(pingPayload, {
  latestInteractionAt = 0,
  inFlightCount = 0,
} = {}) {
  const mcpLastActivityAt = normalizeTimestamp(pingPayload?.mcp_last_activity_at);
  const hookLastActivityAt = resolveHookActivityAt(pingPayload);
  return {
    inFlightCount,
    latestInteractionAt: normalizeTimestamp(latestInteractionAt),
    mcpLastActivityAt,
    hookLastActivityAt,
    activityAt: Math.max(mcpLastActivityAt, hookLastActivityAt),
  };
}

export class WorkerHealthInspector {
  constructor({
    getPendingEventsForSession,
    mcpInteractionIdleMs = 0,
    mcpResultTimeoutMs = 0,
  } = {}) {
    this.getPendingEventsForSession = typeof getPendingEventsForSession === "function"
      ? getPendingEventsForSession
      : () => [];
    this.mcpInteractionIdleMs = Number.isFinite(Number(mcpInteractionIdleMs))
      ? Math.max(0, Math.floor(Number(mcpInteractionIdleMs)))
      : 0;
    this.mcpResultTimeoutMs = Number.isFinite(Number(mcpResultTimeoutMs))
      ? Math.max(0, Math.floor(Number(mcpResultTimeoutMs)))
      : 0;
  }

  listInFlightSessionEvents(sessionID) {
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return [];
    }
    return this.getPendingEventsForSession(normalizedSessionID).filter((record) => {
      const deliveryState = normalizeString(record.delivery_state);
      return deliveryState === "dispatching" || deliveryState === "delivered";
    });
  }

  inspectWorkerIdentityHealth(binding, runtime, pingPayload) {
    if (!pingPayload || typeof pingPayload !== "object") {
      return { ok: true };
    }

    const expectedWorkerID = normalizeString(binding?.worker_id);
    const reportedWorkerID = normalizeString(pingPayload?.worker_id);
    if (expectedWorkerID && reportedWorkerID && expectedWorkerID !== reportedWorkerID) {
      return {
        ok: false,
        reason: "worker_id_mismatch",
        expectedWorkerID,
        reportedWorkerID,
      };
    }

    const expectedSessionID = normalizeString(binding?.aibot_session_id);
    const reportedSessionID = normalizeString(pingPayload?.aibot_session_id);
    if (expectedSessionID && reportedSessionID && expectedSessionID !== reportedSessionID) {
      return {
        ok: false,
        reason: "aibot_session_mismatch",
        expectedSessionID,
        reportedSessionID,
      };
    }

    const expectedClaudeSessionID = normalizeString(binding?.claude_session_id);
    const reportedClaudeSessionID = normalizeString(pingPayload?.claude_session_id);
    if (expectedClaudeSessionID && reportedClaudeSessionID && expectedClaudeSessionID !== reportedClaudeSessionID) {
      return {
        ok: false,
        reason: "claude_session_mismatch",
        expectedClaudeSessionID,
        reportedClaudeSessionID,
      };
    }

    const expectedPid = resolvePersistedWorkerPid(binding);
    if (expectedPid > 0) {
      const reportedPid = normalizePid(pingPayload?.pid ?? pingPayload?.worker_pid);
      if (reportedPid <= 0) {
        return {
          ok: false,
          reason: "worker_pid_missing",
          expectedPid,
        };
      }
      if (reportedPid !== expectedPid) {
        return {
          ok: false,
          reason: "worker_pid_mismatch",
          expectedPid,
          reportedPid,
        };
      }
    }

    return { ok: true };
  }

  inspectMcpInteractionHealth(binding, pingPayload, { now = Date.now() } = {}) {
    const baseContext = buildMcpHealthContext(pingPayload);
    if (normalizeString(binding?.worker_status) !== "ready") {
      return { ok: true, ...baseContext };
    }

    if (pingPayload && Object.hasOwn(pingPayload, "mcp_ready") && pingPayload.mcp_ready === false) {
      return {
        ok: false,
        reason: "mcp_not_ready",
        ...baseContext,
      };
    }

    if (this.mcpInteractionIdleMs <= 0) {
      return { ok: true, ...baseContext };
    }

    const sessionID = normalizeString(binding?.aibot_session_id);
    const inFlightRecords = this.listInFlightSessionEvents(sessionID);
    const latestInteractionAt = inFlightRecords.reduce((latest, record) => {
      return Math.max(latest, resolveRecordInteractionAt(record));
    }, 0);
    const context = buildMcpHealthContext(pingPayload, {
      latestInteractionAt,
      inFlightCount: inFlightRecords.length,
    });
    if (inFlightRecords.length === 0) {
      return { ok: true, ...context };
    }

    const graceFromPendingActivity = (reason) => {
      if (!Number.isFinite(latestInteractionAt) || latestInteractionAt <= 0) {
        return {
          ok: false,
          reason,
          ...context,
        };
      }
      const idleSinceActivityMs = Math.max(0, now - latestInteractionAt);
      if (idleSinceActivityMs <= this.mcpInteractionIdleMs) {
        return { ok: true, ...context };
      }
      return {
        ok: false,
        reason,
        idleMs: idleSinceActivityMs,
        ...context,
      };
    };

    const activityAt = context.activityAt;
    if (!Number.isFinite(activityAt) || activityAt <= 0) {
      return graceFromPendingActivity("mcp_activity_missing");
    }

    if (Number.isFinite(latestInteractionAt) && latestInteractionAt > 0 && activityAt < latestInteractionAt) {
      return graceFromPendingActivity("mcp_activity_before_event_activity");
    }

    const idleMs = Math.max(0, now - activityAt);
    if (idleMs > this.mcpInteractionIdleMs) {
      return {
        ok: false,
        reason: "mcp_activity_stale",
        idleMs,
        ...context,
      };
    }
    return { ok: true, ...context };
  }

  describeMcpResultTimeoutRecord(
    record,
    now = Date.now(),
    { latestMcpActivityAt = 0 } = {},
  ) {
    const updatedAt = normalizeTimestamp(record?.updated_at);
    const lastComposingAt = normalizeTimestamp(record?.last_composing_at);
    const latestActivityAt = normalizeTimestamp(latestMcpActivityAt);
    const hasRecordUpdatedAt = updatedAt > 0;
    const hasLatestActivity = latestActivityAt > 0;
    const effectiveActivityAt = Math.max(
      hasRecordUpdatedAt ? updatedAt : 0,
      hasLatestActivity ? latestActivityAt : 0,
    );
    return {
      eventID: normalizeString(record?.eventID ?? record?.event_id),
      sessionID: normalizeString(record?.sessionID ?? record?.session_id),
      deliveryState: normalizeString(record?.delivery_state),
      updatedAt,
      lastComposingAt,
      recordInteractionAt: resolveRecordInteractionAt(record),
      latestMcpActivityAt: latestActivityAt,
      effectiveActivityAt,
      idleMs: effectiveActivityAt > 0 ? Math.max(0, now - effectiveActivityAt) : 0,
      timedOut: (!hasRecordUpdatedAt && !hasLatestActivity)
        || (
          effectiveActivityAt > 0
          && this.mcpResultTimeoutMs > 0
          && now - effectiveActivityAt > this.mcpResultTimeoutMs
        ),
    };
  }

  listTimedOutMcpResultRecords(
    sessionID,
    now = Date.now(),
    { latestMcpActivityAt = 0 } = {},
  ) {
    if (this.mcpResultTimeoutMs <= 0) {
      return [];
    }
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSessionID) {
      return [];
    }
    return this.getPendingEventsForSession(normalizedSessionID).filter((record) => {
      const details = this.describeMcpResultTimeoutRecord(record, now, {
        latestMcpActivityAt,
      });
      if (details.deliveryState !== "dispatching" && details.deliveryState !== "delivered") {
        return false;
      }
      return details.timedOut;
    });
  }
}
