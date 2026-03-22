import test from "node:test";
import assert from "node:assert/strict";
import { ResultTimeoutManager } from "./result-timeout.js";

test("result timeout manager fires timeout callback", async () => {
  const fired = [];
  const manager = new ResultTimeoutManager({
    defaultResultTimeoutMs: 20,
    onTimeout: async (eventID) => {
      fired.push(eventID);
    },
  });

  manager.arm("evt-1");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fired, ["evt-1"]);
});

test("result timeout manager cancels armed timer", async () => {
  const fired = [];
  const manager = new ResultTimeoutManager({
    defaultResultTimeoutMs: 20,
    onTimeout: async (eventID) => {
      fired.push(eventID);
    },
  });

  manager.arm("evt-2");
  manager.cancel("evt-2");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fired, []);
});
