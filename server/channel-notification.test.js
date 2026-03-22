import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChannelNotificationParams,
  shouldReplayRestoredEvent,
} from "./channel-notification.js";

test("buildChannelNotificationParams preserves stored inbound meta", () => {
  const params = buildChannelNotificationParams({
    event_id: "evt-1",
    session_id: "sess-1",
    msg_id: "101",
    sender_id: "201",
    quoted_message_id: "99",
    session_type: "2",
    msg_type: "1",
    message_created_at: 1700000000000,
    mention_user_ids: ["301", "302"],
    owner_id: "401",
    agent_id: "501",
    extra_json: "{\"key\":\"value\"}",
    attachments_json: "[{\"media_url\":\"https://cdn.example.com/a.png\"}]",
    attachment_count: "1",
    biz_card_json: "{\"name\":\"card\"}",
    channel_data_json: "{\"source\":\"clawpool-claude\"}",
    content: "hello",
  });

  assert.equal(params.content, "hello");
  assert.equal(params.meta.chat_id, "sess-1");
  assert.equal(params.meta.event_id, "evt-1");
  assert.equal(params.meta.event_type, "group_message");
  assert.equal(params.meta.msg_type, "1");
  assert.equal(params.meta.mention_user_ids, "301,302");
  assert.equal(params.meta.owner_id, "401");
  assert.equal(params.meta.agent_id, "501");
  assert.equal(params.meta.attachment_count, "1");
  assert.equal(params.meta.ts, "2023-11-14T22:13:20.000Z");
});

test("shouldReplayRestoredEvent only replays unresolved acked events without terminal intent", () => {
  assert.equal(shouldReplayRestoredEvent({
    event_id: "evt-replay",
    acked: true,
  }), true);

  assert.equal(shouldReplayRestoredEvent({
    event_id: "evt-intent",
    acked: true,
    result_intent: {
      status: "responded",
    },
  }), false);

  assert.equal(shouldReplayRestoredEvent({
    event_id: "evt-complete",
    acked: true,
    completed: {
      status: "responded",
    },
  }), false);

  assert.equal(shouldReplayRestoredEvent({
    event_id: "evt-unacked",
    acked: false,
  }), false);
});
