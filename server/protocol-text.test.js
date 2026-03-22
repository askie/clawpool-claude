import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOutboundTextChunkLimit,
  splitTextForAibotProtocol,
} from "./protocol-text.js";

test("resolveOutboundTextChunkLimit clamps oversized values", () => {
  assert.equal(resolveOutboundTextChunkLimit(5000), 2000);
  assert.equal(resolveOutboundTextChunkLimit(undefined), 1200);
});

test("splitTextForAibotProtocol respects preferred rune limit", () => {
  const chunks = splitTextForAibotProtocol("a".repeat(2500), 1200);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 1200);
  assert.equal(chunks[2].length, 100);
});

test("splitTextForAibotProtocol keeps emoji intact", () => {
  const chunks = splitTextForAibotProtocol("😀".repeat(5), 3);
  assert.deepEqual(chunks, ["😀😀😀", "😀😀"]);
});
