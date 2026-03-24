import test from "node:test";
import assert from "node:assert/strict";
import { WorkerControlClient } from "./daemon/worker-control-client.js";

test("worker control client ping sends authenticated request", async () => {
  const calls = [];
  const client = new WorkerControlClient({
    controlURL: "http://127.0.0.1:9010",
    token: "token-1",
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.ping();

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9010/v1/worker/ping");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer token-1");
});

test("worker control client ping throws api error payload", async () => {
  const client = new WorkerControlClient({
    controlURL: "http://127.0.0.1:9010",
    token: "token-1",
    async fetchImpl() {
      return new Response(JSON.stringify({ error: "bridge_down" }), {
        status: 503,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  await assert.rejects(
    () => client.ping(),
    /bridge_down/u,
  );
});
