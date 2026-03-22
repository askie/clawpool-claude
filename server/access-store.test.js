import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { AccessStore } from "./access-store.js";

test("allowlist policy auto-binds the first sender when allowlist is empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-access-"));
  const store = new AccessStore(path.join(dir, "access.json"));
  await store.load();

  assert.equal(store.getPolicy(), "allowlist");
  assert.equal(store.isSenderAllowed("1001"), false);

  const bootstrapped = await store.bootstrapFirstSender("1001");
  assert.equal(bootstrapped.bootstrapped, true);
  assert.equal(bootstrapped.sender_id, "1001");
  assert.equal(bootstrapped.policy, "allowlist");
  assert.equal(store.isSenderAllowed("1001"), true);
  assert.equal(store.isSenderAllowlisted("1001"), true);
});

test("allowlist policy blocks unknown sender after the first sender was auto-bound", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-access-"));
  const store = new AccessStore(path.join(dir, "access.json"));
  await store.load();

  await store.bootstrapFirstSender("1001");

  assert.equal(store.isSenderAllowed("1002"), false);

  const pair = await store.issuePairingCode({
    senderID: "1002",
    sessionID: "u_9992_u_1002",
  });
  assert.match(pair.code, /^[A-Z0-9]{6}$/);

  const approved = await store.approvePairing(pair.code);
  assert.equal(approved.sender_id, "1002");
  assert.equal(store.isSenderAllowed("1002"), true);
});

test("open policy allows unknown sender", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-access-"));
  const store = new AccessStore(path.join(dir, "access.json"));
  await store.load();
  await store.setPolicy("open");

  assert.equal(store.isSenderAllowed("9999"), true);
  assert.equal(store.isSenderAllowlisted("9999"), false);
});

test("open policy can bootstrap first sender into allowlist and lock policy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-access-"));
  const store = new AccessStore(path.join(dir, "access.json"));
  await store.load();
  await store.setPolicy("open");

  const bootstrapped = await store.bootstrapFirstSender("9999", {
    lockPolicyToAllowlist: true,
  });
  assert.equal(bootstrapped.bootstrapped, true);
  assert.equal(bootstrapped.sender_id, "9999");
  assert.equal(bootstrapped.policy, "allowlist");
  assert.equal(store.getPolicy(), "allowlist");
  assert.equal(store.isSenderAllowed("9999"), true);
  assert.equal(store.isSenderAllowlisted("9999"), true);

  const second = await store.bootstrapFirstSender("1000", {
    lockPolicyToAllowlist: true,
  });
  assert.equal(second.bootstrapped, false);
  assert.equal(store.isSenderAllowed("1000"), false);
});

test("access store exposes detailed status and sender management", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clawpool-claude-access-"));
  const store = new AccessStore(path.join(dir, "access.json"));
  await store.load();

  await store.allowSender("2001");
  await store.allowApprover("2001");
  const pair = await store.issuePairingCode({
    senderID: "3001",
    sessionID: "u_9992_u_3001",
  });

  let status = store.getStatus();
  assert.deepEqual(
    status.allowlist.map((entry) => entry.sender_id),
    ["2001"],
  );
  assert.deepEqual(
    status.approver_allowlist.map((entry) => entry.sender_id),
    ["2001"],
  );
  assert.deepEqual(
    status.pending_pairs.map((entry) => entry.code),
    [pair.code],
  );

  const denied = await store.denyPairing(pair.code);
  assert.equal(denied.sender_id, "3001");

  status = store.getStatus();
  assert.equal(status.pending_pair_count, 0);

  const removed = await store.removeSender("2001");
  assert.equal(removed.removed, true);
  assert.equal(store.isSenderAllowed("2001"), false);

  const removedApprover = await store.removeApprover("2001");
  assert.equal(removedApprover.removed, true);
  assert.equal(store.isSenderApprover("2001"), false);
});
