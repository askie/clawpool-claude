const currentVersion = 1;

export function buildMessageCardEnvelope(type, payload) {
  return {
    version: currentVersion,
    type,
    payload,
  };
}
