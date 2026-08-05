import type { RoomEvent } from "./platform.js";

const conversationalEventTypes = new Set([
  "message_posted",
  "content_posted",
]);

export const startupConversationWindowMs = 30 * 60_000;

// Presence and moderation history reconstruct current room state. Conversation
// history is different: after a long outage, old messages must not be loaded as
// though the speakers had said them moments before the runtime restarted.
export const startupEventsFor = (
  events: RoomEvent[],
  now: number,
): RoomEvent[] =>
  events.filter((event) => {
    if (!conversationalEventTypes.has(event.type)) {
      return true;
    }

    const occurredAt = Date.parse(event.occurredAt);

    return (
      Number.isFinite(occurredAt) &&
      occurredAt >= now - startupConversationWindowMs
    );
  });
