function normalizeString(value) {
  return String(value ?? "").trim();
}

export function buildSessionActivityDispatchKey({
  sessionID = "",
  kind = "composing",
  refEventID = "",
  refMsgID = "",
} = {}) {
  const normalizedSessionID = normalizeString(sessionID);
  const normalizedKind = normalizeString(kind) || "composing";
  const normalizedRefEventID = normalizeString(refEventID);
  const normalizedRefMsgID = normalizeString(refMsgID);

  if (normalizedRefEventID) {
    return `event:${normalizedRefEventID}`;
  }
  if (normalizedRefMsgID) {
    return `session:${normalizedSessionID}|kind:${normalizedKind}|msg:${normalizedRefMsgID}`;
  }
  return `session:${normalizedSessionID}|kind:${normalizedKind}`;
}

export function createSessionActivityDispatcher(sendFn) {
  if (typeof sendFn !== "function") {
    throw new Error("session activity dispatcher requires a send function");
  }

  const tails = new Map();

  return async function dispatchSessionActivity(payload) {
    const key = buildSessionActivityDispatchKey(payload);
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => sendFn(payload));
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.finally(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    return next;
  };
}
