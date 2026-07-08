import type {
  ContentAddress,
  ContentItemReference,
  ContentLifecycleState,
  ContentPart,
  ContentRelationship,
} from "../repositories/content.js";
import type { RoomEvent } from "../repositories/rooms.js";

// A rebuilt projection of one content item, derived purely from room events.
export interface ReplayedContentItem {
  contentItemId: string;
  roomSequence: string;
  actorId: string;
  createdAt: string;
  updatedAt: string;
  lifecycleState: ContentLifecycleState;
  revision: number;
  replyTo?: ContentItemReference;
  addressedTo: ContentAddress[];
  parts: ContentPart[];
  references: ContentRelationship[];
}

const payloadRecord = (event: RoomEvent): Record<string, unknown> =>
  typeof event.payload === "object" &&
  event.payload !== null &&
  !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};

// Rebuild the content projection for one room from its ordered event history.
// `message_posted` is the legacy alias for posting one text part. Events that
// predate the content migration carry no contentItemId; those items are keyed
// by room sequence because their projection identifiers are assigned by the
// migration backfill rather than by the event.
export const replayContentItems = (
  events: RoomEvent[],
): Map<string, ReplayedContentItem> => {
  const items = new Map<string, ReplayedContentItem>();

  for (const event of events) {
    const payload = payloadRecord(event);

    if (event.type === "message_posted" && event.actorId !== null) {
      const content = payload.content;

      if (typeof content !== "string" || content.length === 0) {
        continue;
      }

      const contentItemId =
        typeof payload.contentItemId === "string"
          ? payload.contentItemId
          : `sequence:${event.sequence}`;

      items.set(contentItemId, {
        contentItemId,
        roomSequence: event.sequence,
        actorId: event.actorId,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        lifecycleState: "published",
        revision: 1,
        addressedTo: (payload.addressedTo ?? []) as ContentAddress[],
        parts: [{ partId: "part-1", kind: "text", text: content }],
        references: [],
      });
      continue;
    }

    if (event.type === "content_posted" && event.actorId !== null) {
      const contentItemId = payload.contentItemId;

      if (typeof contentItemId !== "string") {
        continue;
      }

      items.set(contentItemId, {
        contentItemId,
        roomSequence: event.sequence,
        actorId: event.actorId,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        lifecycleState: "published",
        revision: 1,
        ...(payload.replyTo === undefined
          ? {}
          : { replyTo: payload.replyTo as ContentItemReference }),
        addressedTo: (payload.addressedTo ?? []) as ContentAddress[],
        parts: (payload.parts ?? []) as ContentPart[],
        references: (payload.references ?? []) as ContentRelationship[],
      });
      continue;
    }

    if (event.type === "content_edited") {
      const contentItemId = payload.contentItemId;

      if (typeof contentItemId !== "string") {
        continue;
      }

      const item = items.get(contentItemId);

      if (item === undefined || item.lifecycleState === "removed") {
        continue;
      }

      item.lifecycleState = "edited";
      item.revision =
        typeof payload.revision === "number"
          ? payload.revision
          : item.revision + 1;
      item.parts = (payload.parts ?? item.parts) as ContentPart[];
      item.updatedAt = event.occurredAt;
      continue;
    }

    if (event.type === "content_removed") {
      const contentItemId = payload.contentItemId;

      if (typeof contentItemId !== "string") {
        continue;
      }

      const item = items.get(contentItemId);

      if (item === undefined) {
        continue;
      }

      item.lifecycleState = "removed";
      item.updatedAt = event.occurredAt;
    }
  }

  return items;
};
