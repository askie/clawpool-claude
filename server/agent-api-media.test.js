import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolveAgentAPIPresignURL, uploadReplyFileToAgentMedia } from "./agent-api-media.js";

test("agent api media resolves presign url from websocket url", () => {
  assert.equal(
    resolveAgentAPIPresignURL("wss://grix-claude.example.com/v1/agent-api/ws?agent_id=9"),
    "https://grix-claude.example.com/v1/agent-api/oss/presign",
  );
  assert.equal(
    resolveAgentAPIPresignURL("ws://localhost:8080/v1/agent-api/ws"),
    "http://localhost:8080/v1/agent-api/oss/presign",
  );
});

test("agent api media uploads local file through presign", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-agent-media-"));
  const filePath = path.join(dir, "report.pdf");
  await writeFile(filePath, Buffer.from("demo-pdf"), "utf8");

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
    });

    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              upload_url: "https://oss.example.com/upload/report.pdf?sig=1",
              media_access_url: "https://cdn.example.com/media/report.pdf",
            },
          });
        },
      };
    }

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return "";
      },
    };
  };

  const uploaded = await uploadReplyFileToAgentMedia({
    wsURL: "wss://grix-claude.example.com/v1/agent-api/ws?agent_id=9",
    apiKey: "ak_test",
    sessionID: "chat-1",
    filePath,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://grix-claude.example.com/v1/agent-api/oss/presign");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer ak_test");
  assert.match(String(calls[0].body), /"session_id":"chat-1"/);
  assert.equal(calls[1].url, "https://oss.example.com/upload/report.pdf?sig=1");
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].headers["Content-Type"], "application/pdf");
  assert.equal(uploaded.file_name, "report.pdf");
  assert.equal(uploaded.attachment_type, "file");
  assert.equal(uploaded.access_url, "https://cdn.example.com/media/report.pdf");
  assert.deepEqual(uploaded.extra, {
    media_url: "https://cdn.example.com/media/report.pdf",
    attachment_type: "file",
    file_name: "report.pdf",
    content_type: "application/pdf",
    attachments: [
      {
        media_url: "https://cdn.example.com/media/report.pdf",
        attachment_type: "file",
        file_name: "report.pdf",
        content_type: "application/pdf",
      },
    ],
  });
});
