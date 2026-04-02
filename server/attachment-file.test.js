import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { buildAttachmentExtra, readReplyFile, resolveAttachmentType, resolveContentType } from "./attachment-file.js";

test("attachment file infers content type and attachment type", () => {
  assert.equal(resolveContentType("demo.png"), "image/png");
  assert.equal(resolveContentType("video.mp4"), "video/mp4");
  assert.equal(resolveContentType("report.pdf"), "application/pdf");
  assert.equal(resolveAttachmentType("image/png"), "image");
  assert.equal(resolveAttachmentType("video/mp4"), "video");
  assert.equal(resolveAttachmentType("application/pdf"), "file");
});

test("attachment file validates absolute local file path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grix-claude-attachment-file-"));
  const filePath = path.join(dir, "demo.png");
  await writeFile(filePath, Buffer.from("png"), "utf8");

  const file = await readReplyFile(filePath);
  assert.equal(file.file_name, "demo.png");
  assert.equal(file.content_type, "image/png");
  assert.equal(file.attachment_type, "image");

  assert.deepEqual(buildAttachmentExtra({
    attachmentType: file.attachment_type,
    fileName: file.file_name,
    accessURL: "https://cdn.example.com/demo.png",
    contentType: file.content_type,
  }), {
    media_url: "https://cdn.example.com/demo.png",
    attachment_type: "image",
    file_name: "demo.png",
    content_type: "image/png",
    attachments: [
      {
        media_url: "https://cdn.example.com/demo.png",
        attachment_type: "image",
        file_name: "demo.png",
        content_type: "image/png",
      },
    ],
  });
});

test("attachment file rejects relative paths", async () => {
  await assert.rejects(() => readReplyFile("demo.png"), /absolute path/);
});
