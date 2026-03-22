import test from "node:test";
import assert from "node:assert/strict";
import { parseApprovalDecisionCommand } from "./approval-command.js";

test("approval command parser handles allow and deny", () => {
  const allow = parseApprovalDecisionCommand("/clawpool-claude-approval req-1 allow");
  assert.equal(allow.matched, true);
  assert.equal(allow.ok, true);
  assert.equal(allow.request_id, "req-1");
  assert.deepEqual(allow.resolution, { type: "allow" });

  const deny = parseApprovalDecisionCommand("/clawpool-claude-approval req-2 deny not safe");
  assert.equal(deny.matched, true);
  assert.equal(deny.ok, true);
  assert.equal(deny.request_id, "req-2");
  assert.deepEqual(deny.resolution, {
    type: "deny",
    reason: "not safe",
  });
});

test("approval command parser handles allow-rule and invalid input", () => {
  const withRule = parseApprovalDecisionCommand("/clawpool-claude-approval req-3 allow-rule 2");
  assert.equal(withRule.matched, true);
  assert.equal(withRule.ok, true);
  assert.deepEqual(withRule.resolution, {
    type: "allow-rule",
    suggestion_index: 2,
  });

  const invalid = parseApprovalDecisionCommand("/clawpool-claude-approval req-3 allow-rule nope");
  assert.equal(invalid.matched, true);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /usage:/);
});
