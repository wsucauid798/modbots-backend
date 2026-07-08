import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomEvent } from "../repositories/rooms.js";
import { replayContentItems } from "./content-replay.js";

const event = (partial: Partial<RoomEvent> & Pick<RoomEvent, "sequence" | "type">): RoomEvent => ({
  actorId: "actor-1",
  payload: {},
  occurredAt: "2026-01-01T00:00:00.000Z",
  ...partial,
});

describe("replayContentItems", () => {
  it("rebuilds legacy messages as published text content items", () => {
    const items = replayContentItems([
      event({
        sequence: "5",
        type: "message_posted",
        payload: {
          content: "Hello",
          contentItemId: "content-a",
          addressedTo: [{ targetType: "actor", actorId: "actor-2" }],
        },
      }),
    ]);

    const item = items.get("content-a");
    assert.ok(item);
    assert.equal(item.lifecycleState, "published");
    assert.equal(item.revision, 1);
    assert.deepEqual(item.parts, [
      { partId: "part-1", kind: "text", text: "Hello" },
    ]);
    assert.deepEqual(item.addressedTo, [
      { targetType: "actor", actorId: "actor-2" },
    ]);
  });

  it("keys pre-migration messages by room sequence", () => {
    const items = replayContentItems([
      event({
        sequence: "3",
        type: "message_posted",
        payload: { content: "Old message" },
      }),
    ]);

    assert.ok(items.get("sequence:3"));
  });

  it("applies posts, edits, and removal in order", () => {
    const items = replayContentItems([
      event({
        sequence: "10",
        type: "content_posted",
        payload: {
          contentItemId: "content-b",
          lifecycleState: "published",
          revision: 1,
          addressedTo: [{ targetType: "room" }],
          parts: [{ partId: "p1", kind: "text", text: "First" }],
          references: [],
        },
      }),
      event({
        sequence: "11",
        type: "content_edited",
        occurredAt: "2026-01-01T00:01:00.000Z",
        payload: {
          contentItemId: "content-b",
          revision: 2,
          parts: [{ partId: "p1", kind: "text", text: "First, edited" }],
        },
      }),
      event({
        sequence: "12",
        type: "content_removed",
        occurredAt: "2026-01-01T00:02:00.000Z",
        payload: { contentItemId: "content-b" },
      }),
    ]);

    const item = items.get("content-b");
    assert.ok(item);
    assert.equal(item.revision, 2);
    assert.equal(item.lifecycleState, "removed");
    assert.equal(item.parts[0]?.text, "First, edited");
    assert.deepEqual(item.addressedTo, [{ targetType: "room" }]);
    assert.equal(item.updatedAt, "2026-01-01T00:02:00.000Z");
    assert.equal(item.createdAt, "2026-01-01T00:00:00.000Z");
  });

  it("ignores edits to removed content", () => {
    const items = replayContentItems([
      event({
        sequence: "20",
        type: "content_posted",
        payload: {
          contentItemId: "content-c",
          parts: [{ partId: "p1", kind: "text", text: "Text" }],
          references: [],
        },
      }),
      event({
        sequence: "21",
        type: "content_removed",
        payload: { contentItemId: "content-c" },
      }),
      event({
        sequence: "22",
        type: "content_edited",
        payload: {
          contentItemId: "content-c",
          revision: 2,
          parts: [{ partId: "p1", kind: "text", text: "Sneaky edit" }],
        },
      }),
    ]);

    const item = items.get("content-c");
    assert.ok(item);
    assert.equal(item.lifecycleState, "removed");
    assert.equal(item.parts[0]?.text, "Text");
  });
});
