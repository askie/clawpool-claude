import test from "node:test";
import assert from "node:assert/strict";
import { buildElicitationHookOutput } from "./elicitation-response.js";

test("elicitation response builds accept content from indexed answers", () => {
  const output = buildElicitationHookOutput({
    fields: [
      {
        key: "environment",
        title: "Environment",
        prompt: "Choose an environment.",
        type: "string",
        kind: "enum",
        options: ["prod", "staging"],
        multi_select: false,
      },
      {
        key: "approve",
        title: "Approve",
        prompt: "Choose yes or no.",
        type: "boolean",
        kind: "boolean",
        options: ["yes", "no"],
        multi_select: false,
      },
      {
        key: "targets",
        title: "Targets",
        prompt: "Choose one or more targets.",
        type: "array",
        kind: "enum_array",
        options: ["api", "worker"],
        multi_select: true,
      },
    ],
  }, {
    type: "map",
    entries: [
      { key: "1", value: "prod" },
      { key: "2", value: "yes" },
      { key: "3", value: "api, worker" },
    ],
  });

  assert.equal(output.action, "accept");
  assert.deepEqual(output.content, {
    environment: "prod",
    approve: true,
    targets: ["api", "worker"],
  });
});

test("elicitation response rejects incomplete answers", () => {
  assert.throws(() => {
    buildElicitationHookOutput({
      fields: [
        { key: "a", title: "A", kind: "string" },
        { key: "b", title: "B", kind: "string" },
      ],
    }, {
      type: "map",
      entries: [{ key: "1", value: "x" }],
    });
  }, /expected 2 answers/);
});
