import test from "node:test";
import assert from "node:assert/strict";
import { buildAskUserQuestionUpdatedInput } from "./question-response.js";

test("question response builds AskUserQuestion updated input", () => {
  const updatedInput = buildAskUserQuestionUpdatedInput({
    questions: [
      {
        header: "Environment",
        question: "Which environment should I use?",
        options: [
          { label: "prod", description: "production" },
          { label: "staging", description: "staging" },
        ],
        multiSelect: false,
      },
      {
        header: "Region",
        question: "Which region should I deploy to?",
        options: [],
        multiSelect: false,
      },
    ],
  }, {
    type: "map",
    entries: [
      { key: "1", value: "prod" },
      { key: "2", value: "cn-hz" },
    ],
  });

  assert.deepEqual(updatedInput.answers, {
    "Which environment should I use?": "prod",
    "Which region should I deploy to?": "cn-hz",
  });
});

test("question response rejects incomplete answers", () => {
  assert.throws(() => {
    buildAskUserQuestionUpdatedInput({
      questions: [
        { question: "A?" },
        { question: "B?" },
      ],
    }, {
      type: "map",
      entries: [{ key: "1", value: "x" }],
    });
  }, /expected 2 answers/);
});
