import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuestionPromptsFromFields,
  deriveSupportedElicitationFields,
} from "./elicitation-schema.js";

test("elicitation schema derives supported flat required fields", () => {
  const result = deriveSupportedElicitationFields({
    type: "object",
    required: ["environment", "confirm", "tags"],
    properties: {
      environment: {
        type: "string",
        title: "Environment",
        description: "Pick a deployment environment.",
        enum: ["production", "staging"],
      },
      confirm: {
        type: "boolean",
        title: "Confirm",
      },
      tags: {
        type: "array",
        title: "Tags",
        items: {
          type: "string",
          enum: ["api", "worker"],
        },
      },
    },
  });

  assert.equal(result.supported, true);
  assert.equal(result.fields.length, 3);
  assert.equal(result.fields[0].kind, "enum");
  assert.equal(result.fields[1].kind, "boolean");
  assert.equal(result.fields[2].kind, "enum_array");

  const questions = buildQuestionPromptsFromFields(result.fields);
  assert.equal(questions.length, 3);
  assert.equal(questions[0].header, "Environment");
  assert.equal(questions[1].options[0].label, "yes");
  assert.equal(questions[2].multiSelect, true);
});

test("elicitation schema rejects optional and nested fields", () => {
  const optional = deriveSupportedElicitationFields({
    type: "object",
    required: ["required_only"],
    properties: {
      required_only: { type: "string" },
      optional_field: { type: "string" },
    },
  });
  assert.equal(optional.supported, false);
  assert.match(optional.reason, /optional/i);

  const nested = deriveSupportedElicitationFields({
    type: "object",
    required: ["details"],
    properties: {
      details: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    },
  });
  assert.equal(nested.supported, false);
  assert.match(nested.reason, /not supported/i);
});
