import type { PoolClient } from "pg";
import { badRequest } from "../domain/errors.js";
import type { RoomEvent } from "../repositories/rooms.js";

interface EventRow {
  sequence: string;
  event_type: string;
  actor_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

const subjectToken = (roomId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(roomId)) {
    throw badRequest(
      "invalid_room_id",
      "Room IDs may only contain letters, numbers, underscores, and hyphens",
    );
  }

  return roomId;
};

export const appendRoomEvent = async (
  client: PoolClient,
  input: {
    roomId: string;
    type: string;
    actorId: string | null;
    payload: unknown;
  },
): Promise<RoomEvent> => {
  const result = await client.query<EventRow>(
    `
      INSERT INTO room_events (room_id, event_type, actor_id, payload)
      VALUES ($1, $2, $3, $4)
      RETURNING
        sequence::text,
        event_type,
        actor_id,
        payload,
        occurred_at
    `,
    [input.roomId, input.type, input.actorId, input.payload],
  );
  const row = result.rows[0]!;
  const event: RoomEvent = {
    sequence: row.sequence,
    type: row.event_type,
    actorId: row.actor_id,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
  const subject = `rooms.${subjectToken(input.roomId)}.events.${input.type}`;

  await client.query(
    `
      INSERT INTO event_outbox (
        room_event_sequence,
        subject,
        payload
      )
      VALUES ($1, $2, $3)
    `,
    [
      event.sequence,
      subject,
      {
        roomId: input.roomId,
        event,
      },
    ],
  );

  return event;
};
