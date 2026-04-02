import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseControlCommand } from "./daemon/control-command.js";

test("parseControlCommand parses open command with cwd", () => {
  const parsed = parseControlCommand("open ./repo");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "open");
  assert.equal(parsed.args.cwd, path.resolve("./repo"));
});

test("parseControlCommand parses namespaced commands", () => {
  assert.equal(parseControlCommand("/grix status").command, "status");
  assert.equal(parseControlCommand("grix where").command, "where");
  assert.equal(parseControlCommand("grix stop").command, "stop");
});

test("parseControlCommand rejects open without cwd", () => {
  const parsed = parseControlCommand("open");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /缺少目录路径/u);
});
