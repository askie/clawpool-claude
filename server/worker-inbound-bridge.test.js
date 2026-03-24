import test from "node:test";
import assert from "node:assert/strict";
import { WorkerInboundBridgeServer } from "./worker/inbound-bridge-server.js";

test("worker inbound bridge server responds to ping", async () => {
  const server = new WorkerInboundBridgeServer({
    token: "token-ping",
  });
  await server.start();

  try {
    const response = await fetch(`${server.getURL()}/v1/worker/ping`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-ping",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.ts, "number");
  } finally {
    await server.stop();
  }
});
