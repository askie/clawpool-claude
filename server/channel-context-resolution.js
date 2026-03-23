import { resolveTranscriptClawpoolChannelContext } from "./transcript-channel-context.js";

function buildUnresolvedResult(reason, { sessionStatus = "", transcriptStatus = "" } = {}) {
  return {
    status: "unresolved",
    context: null,
    source: "",
    reason,
    session_status: sessionStatus,
    transcript_status: transcriptStatus,
  };
}

export async function resolveHookChannelContext({
  sessionContextStore,
  sessionID,
  transcriptPath,
  workingDir,
  maxAgeMs,
}) {
  const sessionInspection = await sessionContextStore.inspectMatchingContext({
    sessionID,
    transcriptPath,
    workingDir,
    maxAgeMs,
  });
  if (sessionInspection.status === "matched" && sessionInspection.context?.chat_id) {
    return {
      status: "resolved",
      context: sessionInspection.context,
      source: "session_context",
      reason: "",
      session_status: sessionInspection.status,
      transcript_status: "",
    };
  }

  const transcriptResolution = await resolveTranscriptClawpoolChannelContext(transcriptPath);
  if (transcriptResolution.status === "resolved" && transcriptResolution.context?.chat_id) {
    return {
      status: "resolved",
      context: transcriptResolution.context,
      source: "transcript_fallback",
      reason: "",
      session_status: sessionInspection.status,
      transcript_status: transcriptResolution.status,
    };
  }

  if (transcriptResolution.status === "ambiguous") {
    return buildUnresolvedResult("transcript_ambiguous", {
      sessionStatus: sessionInspection.status,
      transcriptStatus: transcriptResolution.status,
    });
  }

  if (sessionInspection.status === "stale") {
    return buildUnresolvedResult("session_context_stale", {
      sessionStatus: sessionInspection.status,
      transcriptStatus: transcriptResolution.status,
    });
  }

  if (sessionInspection.status === "transcript_mismatch") {
    return buildUnresolvedResult("session_context_transcript_mismatch", {
      sessionStatus: sessionInspection.status,
      transcriptStatus: transcriptResolution.status,
    });
  }

  if (sessionInspection.status === "cwd_mismatch") {
    return buildUnresolvedResult("session_context_cwd_mismatch", {
      sessionStatus: sessionInspection.status,
      transcriptStatus: transcriptResolution.status,
    });
  }

  return buildUnresolvedResult("no_channel_context", {
    sessionStatus: sessionInspection.status,
    transcriptStatus: transcriptResolution.status,
  });
}
