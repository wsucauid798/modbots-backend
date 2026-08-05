import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEvent } from "./platform.js";
import {
  startupConversationWindowMs,
  startupEventsFor,
} from "./startup-history.js";

const now = Date.parse("2026-08-05T12:00:00.000Z");

const event = (
  sequence: string,
  type: string,
  occurredAt: string,
): RoomEvent => ({
  sequence,
  type,
  actorId: "actor-1",
  payload: {},
  occurredAt,
});

test("keeps room state history while dropping stale conversation", () => {
  const staleTime = new Date(
    now - startupConversationWindowMs - 1,
  ).toISOString();
  const freshTime = new Date(
    now - startupConversationWindowMs,
  ).toISOString();
  const events = [
    event("1", "actor_joined", staleTime),
    event("2", "actor_muted", staleTime),
    event("3", "message_posted", staleTime),
    event("4", "content_posted", "not-a-date"),
    event("5", "message_posted", freshTime),
  ];

  assert.deepEqual(
    startupEventsFor(events, now).map((item) => item.sequence),
    ["1", "2", "5"],
  );
});
