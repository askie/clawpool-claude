import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInboundEventPayload } from "./inbound-event-meta.js";

test("normalize inbound event payload preserves structured message metadata", () => {
  const normalized = normalizeInboundEventPayload({
    event_id: "evt-1",
    event_type: "group_message",
    session_id: "chat-1",
    session_type: 2,
    msg_id: "1001",
    quoted_message_id: "1000",
    sender_id: "2001",
    owner_id: "3001",
    agent_id: "4001",
    msg_type: 2,
    mention_user_ids: ["3001"],
    content: "请看附件",
    extra: {
      media_url: "https://cdn.example.com/demo.png",
      attachment_type: "image",
      file_name: "demo.png",
      content_type: "image/png",
      biz_card: {
        version: 1,
        type: "exec_status",
        payload: {
          status: "running",
        },
      },
      channel_data: {
        "clawpool-claude": {
          execStatus: {
            status: "running",
          },
        },
      },
    },
  });

  assert.equal(normalized.msg_type, "2");
  assert.equal(normalized.attachment_count, "1");
  assert.deepEqual(JSON.parse(normalized.attachments_json), [
    {
      attachment_type: "image",
      media_url: "https://cdn.example.com/demo.png",
      file_name: "demo.png",
      content_type: "image/png",
    },
  ]);
  assert.equal(JSON.parse(normalized.biz_card_json).type, "exec_status");
  assert.equal(
    JSON.parse(normalized.channel_data_json)["clawpool-claude"].execStatus.status,
    "running",
  );
});

test("normalize inbound event payload prefers explicit attachments array", () => {
  const normalized = normalizeInboundEventPayload({
    event_id: "evt-2",
    session_id: "chat-2",
    msg_id: "2001",
    sender_id: "3001",
    attachments: [
      {
        attachment_type: "file",
        media_url: "https://cdn.example.com/report.pdf",
        file_name: "report.pdf",
        content_type: "application/pdf",
      },
      {
        attachment_type: "image",
        media_url: "https://cdn.example.com/demo.png",
        file_name: "demo.png",
        content_type: "image/png",
      },
    ],
    extra: {
      media_url: "https://cdn.example.com/legacy.png",
      attachment_type: "image",
    },
  });

  const attachments = JSON.parse(normalized.attachments_json);
  assert.equal(normalized.attachment_count, "2");
  assert.equal(attachments[0].file_name, "report.pdf");
  assert.equal(attachments[1].file_name, "demo.png");
});
