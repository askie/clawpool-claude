import test from "node:test";
import assert from "node:assert/strict";
import { terminateProcessTree } from "./process-control.js";

test("terminateProcessTree kills descendants before root via pid tree", async () => {
  const calls = [];
  const terminated = await terminateProcessTree(200, {
    platform: "linux",
    pidTreeImpl: async () => [200, 201, 202],
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid === 202) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    },
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [
    [201, "SIGTERM"],
    [202, "SIGTERM"],
    [200, "SIGTERM"],
  ]);
});

test("terminateProcessTree falls back to process group kill when pid tree lookup fails", async () => {
  const calls = [];
  const terminated = await terminateProcessTree(300, {
    platform: "linux",
    pidTreeImpl: async () => {
      throw new Error("pidtree unavailable");
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [[-300, "SIGTERM"]]);
});
