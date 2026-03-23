import test from "node:test";
import assert from "node:assert/strict";
import { ensureUserMcpServer } from "./mcp.js";

test("ensureUserMcpServer is exported", () => {
  assert.equal(typeof ensureUserMcpServer, "function");
});
