import { randomBytes } from "node:crypto";
import { ensurePluginDataDir } from "./paths.js";
import { readJSONFile, writeJSONFileAtomic } from "./json-file.js";

const defaultAccess = Object.freeze({
  schema_version: 2,
  policy: "allowlist",
  allowlist: {},
  approver_allowlist: {},
  pending_pairs: {},
});

const pairingTTLMS = 10 * 60 * 1000;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizePolicy(value) {
  const normalized = normalizeString(value);
  if (normalized === "open" || normalized === "disabled" || normalized === "allowlist") {
    return normalized;
  }
  return "allowlist";
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let result = "";
  for (const byte of bytes) {
    result += alphabet[byte % alphabet.length];
  }
  return result;
}

function pruneExpiredPairs(state, now = Date.now()) {
  for (const [code, entry] of Object.entries(state.pending_pairs ?? {})) {
    const expiresAt = Number(entry?.expires_at ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete state.pending_pairs[code];
    }
  }
}

function listAllowlistEntries(state) {
  return Object.values(state.allowlist ?? {})
    .map((entry) => ({
      sender_id: normalizeString(entry?.sender_id),
      paired_at: Number(entry?.paired_at ?? 0),
    }))
    .filter((entry) => entry.sender_id)
    .sort((left, right) => left.sender_id.localeCompare(right.sender_id));
}

function listApproverEntries(state) {
  return Object.values(state.approver_allowlist ?? {})
    .map((entry) => ({
      sender_id: normalizeString(entry?.sender_id),
      added_at: Number(entry?.added_at ?? 0),
    }))
    .filter((entry) => entry.sender_id)
    .sort((left, right) => left.sender_id.localeCompare(right.sender_id));
}

function listPendingPairs(state) {
  return Object.entries(state.pending_pairs ?? {})
    .map(([code, entry]) => ({
      code: normalizeString(code),
      sender_id: normalizeString(entry?.sender_id),
      session_id: normalizeString(entry?.session_id),
      expires_at: Number(entry?.expires_at ?? 0),
    }))
    .filter((entry) => entry.code && entry.sender_id && entry.session_id)
    .sort((left, right) => left.code.localeCompare(right.code));
}

function ensureShape(input = {}) {
  const state = cloneJSON(defaultAccess);
  if (Number(input.schema_version ?? 0) !== defaultAccess.schema_version) {
    return state;
  }
  state.policy = normalizePolicy(input.policy);
  state.allowlist = {};
  state.approver_allowlist = {};
  state.pending_pairs = {};

  for (const [senderID, entry] of Object.entries(input.allowlist ?? {})) {
    const normalizedSenderID = normalizeString(senderID || entry?.sender_id);
    if (!normalizedSenderID) {
      continue;
    }
    state.allowlist[normalizedSenderID] = {
      sender_id: normalizedSenderID,
      paired_at: Number(entry?.paired_at ?? Date.now()),
    };
  }

  for (const [code, entry] of Object.entries(input.pending_pairs ?? {})) {
    const normalizedCode = normalizeString(code).toUpperCase();
    const senderID = normalizeString(entry?.sender_id);
    const sessionID = normalizeString(entry?.session_id);
    const expiresAt = Number(entry?.expires_at ?? 0);
    if (!normalizedCode || !senderID || !sessionID || !Number.isFinite(expiresAt)) {
      continue;
    }
    state.pending_pairs[normalizedCode] = {
      sender_id: senderID,
      session_id: sessionID,
      expires_at: Math.floor(expiresAt),
    };
  }

  for (const [senderID, entry] of Object.entries(input.approver_allowlist ?? {})) {
    const normalizedSenderID = normalizeString(senderID || entry?.sender_id);
    if (!normalizedSenderID) {
      continue;
    }
    state.approver_allowlist[normalizedSenderID] = {
      sender_id: normalizedSenderID,
      added_at: Number(entry?.added_at ?? Date.now()),
    };
  }

  pruneExpiredPairs(state);
  return state;
}

export class AccessStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = cloneJSON(defaultAccess);
  }

  async load() {
    await ensurePluginDataDir();
    const stored = await readJSONFile(this.filePath, defaultAccess);
    this.state = ensureShape(stored);
    return this.getStatus();
  }

  getStatus() {
    pruneExpiredPairs(this.state);
    const allowlist = listAllowlistEntries(this.state);
    const approver_allowlist = listApproverEntries(this.state);
    const pending_pairs = listPendingPairs(this.state);
    return {
      policy: this.state.policy,
      allowlist_count: allowlist.length,
      approver_count: approver_allowlist.length,
      pending_pair_count: pending_pairs.length,
      allowlist,
      approver_allowlist,
      pending_pairs,
    };
  }

  getPolicy() {
    pruneExpiredPairs(this.state);
    return this.state.policy;
  }

  isSenderAllowed(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      return false;
    }
    const policy = this.getPolicy();
    if (policy === "open") {
      return true;
    }
    if (policy === "disabled") {
      return false;
    }
    return Object.hasOwn(this.state.allowlist, normalizedSenderID);
  }

  isSenderAllowlisted(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      return false;
    }
    return Object.hasOwn(this.state.allowlist, normalizedSenderID);
  }

  isSenderApprover(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      return false;
    }
    return Object.hasOwn(this.state.approver_allowlist, normalizedSenderID);
  }

  hasApprovers() {
    return listApproverEntries(this.state).length > 0;
  }

  hasAllowedSenders() {
    return listAllowlistEntries(this.state).length > 0;
  }

  async setPolicy(policy) {
    this.state.policy = normalizePolicy(policy);
    await this.save();
    return this.getStatus();
  }

  async issuePairingCode({ senderID, sessionID }) {
    const normalizedSenderID = normalizeString(senderID);
    const normalizedSessionID = normalizeString(sessionID);
    if (!normalizedSenderID || !normalizedSessionID) {
      throw new Error("senderID and sessionID are required");
    }

    const now = Date.now();
    pruneExpiredPairs(this.state, now);

    for (const [code, entry] of Object.entries(this.state.pending_pairs)) {
      if (
        normalizeString(entry.sender_id) === normalizedSenderID &&
        normalizeString(entry.session_id) === normalizedSessionID
      ) {
        return {
          code,
          sender_id: normalizedSenderID,
          session_id: normalizedSessionID,
          expires_at: entry.expires_at,
        };
      }
    }

    let code = generatePairingCode();
    while (Object.hasOwn(this.state.pending_pairs, code)) {
      code = generatePairingCode();
    }

    const pair = {
      sender_id: normalizedSenderID,
      session_id: normalizedSessionID,
      expires_at: now + pairingTTLMS,
    };
    this.state.pending_pairs[code] = pair;
    await this.save();
    return {
      code,
      ...pair,
    };
  }

  async approvePairing(code) {
    const normalizedCode = normalizeString(code).toUpperCase();
    if (!normalizedCode) {
      throw new Error("pairing code is required");
    }

    pruneExpiredPairs(this.state);
    const pending = this.state.pending_pairs[normalizedCode];
    if (!pending) {
      throw new Error("pairing code not found or expired");
    }

    const senderID = normalizeString(pending.sender_id);
    this.state.allowlist[senderID] = {
      sender_id: senderID,
      paired_at: Date.now(),
    };
    delete this.state.pending_pairs[normalizedCode];
    await this.save();
    return {
      sender_id: senderID,
      session_id: normalizeString(pending.session_id),
      policy: this.state.policy,
    };
  }

  async denyPairing(code) {
    const normalizedCode = normalizeString(code).toUpperCase();
    if (!normalizedCode) {
      throw new Error("pairing code is required");
    }

    pruneExpiredPairs(this.state);
    const pending = this.state.pending_pairs[normalizedCode];
    if (!pending) {
      throw new Error("pairing code not found or expired");
    }

    delete this.state.pending_pairs[normalizedCode];
    await this.save();
    return {
      code: normalizedCode,
      sender_id: normalizeString(pending.sender_id),
      session_id: normalizeString(pending.session_id),
      policy: this.state.policy,
    };
  }

  async allowSender(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      throw new Error("sender_id is required");
    }

    this.state.allowlist[normalizedSenderID] = {
      sender_id: normalizedSenderID,
      paired_at: Date.now(),
    };
    await this.save();
    return {
      sender_id: normalizedSenderID,
      policy: this.state.policy,
    };
  }

  async bootstrapFirstSender(senderID, { lockPolicyToAllowlist = false } = {}) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      throw new Error("sender_id is required");
    }
    if (this.state.policy === "disabled") {
      return {
        sender_id: normalizedSenderID,
        bootstrapped: false,
        policy: this.state.policy,
      };
    }
    if (this.hasAllowedSenders() || Object.hasOwn(this.state.allowlist, normalizedSenderID)) {
      return {
        sender_id: normalizedSenderID,
        bootstrapped: false,
        policy: this.state.policy,
      };
    }

    this.state.allowlist[normalizedSenderID] = {
      sender_id: normalizedSenderID,
      paired_at: Date.now(),
    };
    if (lockPolicyToAllowlist && this.state.policy === "open") {
      this.state.policy = "allowlist";
    }
    await this.save();
    return {
      sender_id: normalizedSenderID,
      bootstrapped: true,
      policy: this.state.policy,
    };
  }

  async allowApprover(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      throw new Error("sender_id is required");
    }

    this.state.approver_allowlist[normalizedSenderID] = {
      sender_id: normalizedSenderID,
      added_at: Date.now(),
    };
    await this.save();
    return {
      sender_id: normalizedSenderID,
      approver: true,
    };
  }

  async removeSender(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      throw new Error("sender_id is required");
    }

    delete this.state.allowlist[normalizedSenderID];
    await this.save();
    return {
      sender_id: normalizedSenderID,
      policy: this.state.policy,
      removed: true,
    };
  }

  async removeApprover(senderID) {
    const normalizedSenderID = normalizeString(senderID);
    if (!normalizedSenderID) {
      throw new Error("sender_id is required");
    }

    const removed = Object.hasOwn(this.state.approver_allowlist, normalizedSenderID);
    delete this.state.approver_allowlist[normalizedSenderID];
    await this.save();
    return {
      sender_id: normalizedSenderID,
      approver: true,
      removed,
    };
  }

  async save() {
    await ensurePluginDataDir();
    pruneExpiredPairs(this.state);
    await writeJSONFileAtomic(this.filePath, this.state);
  }
}
