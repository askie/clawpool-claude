function normalizeString(value) {
  return String(value ?? "").trim();
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

    const expectedPid = Number(runtime?.pid ?? binding?.worker_pid ?? 0);
    if (Number.isFinite(expectedPid) && expectedPid > 0) {
      const reportedPid = Number(pingPayload?.pid ?? pingPayload?.worker_pid ?? 0);
      if (!Number.isFinite(reportedPid) || reportedPid <= 0) {
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
    if (normalizeString(binding?.worker_status) !== "ready") {
      return { ok: true };
    }

    if (pingPayload && Object.hasOwn(pingPayload, "mcp_ready") && pingPayload.mcp_ready === false) {
      return {
        ok: false,
        reason: "mcp_not_ready",
      };
    }

    if (this.mcpInteractionIdleMs <= 0) {
      return { ok: true };
    }

    const sessionID = normalizeString(binding?.aibot_session_id);
    const inFlightRecords = this.listInFlightSessionEvents(sessionID);
    if (inFlightRecords.length === 0) {
      return { ok: true };
    }

    const latestDispatchAt = inFlightRecords.reduce((latest, record) => {
      const updatedAt = Number(record.updated_at ?? 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
        return latest;
      }
      return Math.max(latest, updatedAt);
    }, 0);

    const graceFromDispatch = (reason) => {
      if (!Number.isFinite(latestDispatchAt) || latestDispatchAt <= 0) {
        return {
          ok: false,
          reason,
        };
      }
      const idleSinceDispatchMs = Math.max(0, now - latestDispatchAt);
      if (idleSinceDispatchMs <= this.mcpInteractionIdleMs) {
        return { ok: true };
      }
      return {
        ok: false,
        reason,
        idleMs: idleSinceDispatchMs,
      };
    };

    const activityAt = Number(pingPayload?.mcp_last_activity_at ?? 0);
    if (!Number.isFinite(activityAt) || activityAt <= 0) {
      return graceFromDispatch("mcp_activity_missing");
    }

    if (Number.isFinite(latestDispatchAt) && latestDispatchAt > 0 && activityAt < latestDispatchAt) {
      return graceFromDispatch("mcp_activity_before_dispatch");
    }

    const idleMs = Math.max(0, now - activityAt);
    if (idleMs > this.mcpInteractionIdleMs) {
      return {
        ok: false,
        reason: "mcp_activity_stale",
        idleMs,
      };
    }
    return { ok: true };
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
    const latestActivityAt = Number(latestMcpActivityAt);
    const hasLatestActivity = Number.isFinite(latestActivityAt) && latestActivityAt > 0;
    return this.getPendingEventsForSession(normalizedSessionID).filter((record) => {
      const deliveryState = normalizeString(record.delivery_state);
      if (deliveryState !== "dispatching" && deliveryState !== "delivered") {
        return false;
      }
      const updatedAt = Number(record.updated_at ?? 0);
      const hasRecordUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0;
      if (!hasRecordUpdatedAt && !hasLatestActivity) {
        return true;
      }
      const effectiveActivityAt = Math.max(
        hasRecordUpdatedAt ? updatedAt : 0,
        hasLatestActivity ? latestActivityAt : 0,
      );
      return now - effectiveActivityAt > this.mcpResultTimeoutMs;
    });
  }
}
