import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { writeJSONFileAtomic } from "./json-file.js";

test("writeJSONFileAtomic writes private file mode when supported", async () => {
  if (process.platform === "win32") {
    return;
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grix-json-mode-"));
  const filePath = path.join(tempDir, "config.json");
  await writeJSONFileAtomic(filePath, {
    value: "secret",
  }, {
    mode: 0o600,
  });
  const details = await stat(filePath);
  assert.equal(details.mode & 0o777, 0o600);
});

test("writeJSONFileAtomic tolerates concurrent writes to the same target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grix-json-concurrent-"));
  const filePath = path.join(tempDir, "state.json");

  await Promise.all([
    writeJSONFileAtomic(filePath, { value: "first" }),
    writeJSONFileAtomic(filePath, { value: "second" }),
    writeJSONFileAtomic(filePath, { value: "third" }),
  ]);

  const stored = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(typeof stored.value, "string");
  assert.equal(["first", "second", "third"].includes(stored.value), true);
});
