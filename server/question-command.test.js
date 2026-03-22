import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestionResponseCommand } from "./question-command.js";

test("question command parser handles single and indexed answers", () => {
  const single = parseQuestionResponseCommand("/clawpool-question req-1 use production");
  assert.equal(single.matched, true);
  assert.equal(single.ok, true);
  assert.equal(single.request_id, "req-1");
  assert.deepEqual(single.response, {
    type: "single",
    value: "use production",
  });

  const mapped = parseQuestionResponseCommand("/clawpool-question req-2 1=prod; 2=cn-hz");
  assert.equal(mapped.matched, true);
  assert.equal(mapped.ok, true);
  assert.deepEqual(mapped.response, {
    type: "map",
    entries: [
      { key: "1", value: "prod" },
      { key: "2", value: "cn-hz" },
    ],
  });
});

test("question command parser rejects malformed input", () => {
  const invalid = parseQuestionResponseCommand("/clawpool-question req-3 1=");
  assert.equal(invalid.matched, true);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /usage:/);
});
