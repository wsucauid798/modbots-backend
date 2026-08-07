import type { Pool } from "pg";
import {
  actorFromRow,
  selectColumns as actorColumns,
} from "./actors.js";
import type { Actor, ActorRow } from "./actors.js";

export interface RoomOverview {
  room: {
    id: string;
    name: string;
    description: string;
    capacity: number | null;
    sortOrder: number;
    capabilities: string[];
    actorsOnline: number;
    peopleOnline: number;
    chatBotsOnline: number;
    modBotsOnline: number;
  };
  moderation: {
    proposalsPending: number;
    proposalsAccepted: number;
    proposalsRejected: number;
  };
}

export interface RoomSummary {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  sortOrder: number;
  capabilities: string[];
  actorsOnline: number;
  peopleOnline: number;
  chatBotsOnline: number;
  modBotsOnline: number;
}

export interface RoomEvent {
  sequence: string;
  type: string;
  actorId: string | null;
  payload: unknown;
  occurredAt: string;
}

export interface RoomRepository {
  listRooms(): Promise<RoomSummary[]>;
  getOverview(roomId: string): Promise<RoomOverview | null>;
  listRoster(roomId: string): Promise<Actor[] | null>;
  listEvents(
    roomId: string,
    options: { after: number; limit: number },
  ): Promise<RoomEvent[] | null>;
  listRecentEvents(
    roomId: string,
    options: { limit: number },
  ): Promise<RoomEvent[] | null>;
}

interface OverviewRow {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  sort_order: number;
  capabilities: string[];
  actors_online: string;
  people_online: string;
  chat_bots_online: string;
  mod_bots_online: string;
  proposals_pending: string;
  proposals_accepted: string;
  proposals_rejected: string;
}

interface RoomSummaryRow {
  id: string;
  name: string;
  description: string;
  capacity: number | null;
  sort_order: number;
  capabilities: string[];
  actors_online: string;
  people_online: string;
  chat_bots_online: string;
  mod_bots_online: string;
}

interface EventRow {
  sequence: string;
  event_type: string;
  actor_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

export class PostgresRoomRepository implements RoomRepository {
  public constructor(
    private readonly database: Pool,
    private readonly uppsBaseUrl: string,
  ) {}

  public async listRooms(): Promise<RoomSummary[]> {
    const result = await this.database.query<RoomSummaryRow>(
      `
        WITH latest_presence AS (
          SELECT DISTINCT ON (room_id, actor_id)
            room_id,
            actor_id,
            event_type
          FROM room_events
          WHERE actor_id IS NOT NULL
            AND event_type IN ('actor_joined', 'actor_left')
          ORDER BY room_id, actor_id, sequence DESC
        ),
        room_participants AS (
          SELECT latest_presence.room_id, latest_presence.actor_id
          FROM latest_presence
          JOIN actors ON actors.id = latest_presence.actor_id
          WHERE latest_presence.event_type = 'actor_joined'
            AND actors.actor_type <> 'mod_bot'
            AND actors.retired_at IS NULL

          UNION

          SELECT assignments.room_id, assignments.mod_bot_id
          FROM room_mod_bot_assignments assignments
          JOIN actors ON actors.id = assignments.mod_bot_id
          WHERE actors.actor_type = 'mod_bot'
            AND actors.retired_at IS NULL
        ),
        online_counts AS (
          SELECT
            room_participants.room_id,
            count(*) AS actors_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'human'
            ) AS people_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'chat_bot'
            ) AS chat_bots_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'mod_bot'
            ) AS mod_bots_online
          FROM room_participants
          JOIN actors ON actors.id = room_participants.actor_id
          GROUP BY room_participants.room_id
        )
        SELECT
          rooms.id,
          rooms.name,
          rooms.description,
          rooms.capacity,
          rooms.sort_order,
          rooms.capabilities,
          COALESCE(online_counts.actors_online, 0) AS actors_online,
          COALESCE(online_counts.people_online, 0) AS people_online,
          COALESCE(online_counts.chat_bots_online, 0) AS chat_bots_online,
          COALESCE(online_counts.mod_bots_online, 0) AS mod_bots_online
        FROM rooms
        LEFT JOIN online_counts ON online_counts.room_id = rooms.id
        ORDER BY rooms.sort_order, rooms.name
      `,
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      capacity: row.capacity,
      sortOrder: row.sort_order,
      capabilities: row.capabilities,
      actorsOnline: Number(row.actors_online),
      peopleOnline: Number(row.people_online),
      chatBotsOnline: Number(row.chat_bots_online),
      modBotsOnline: Number(row.mod_bots_online),
    }));
  }

  public async getOverview(roomId: string): Promise<RoomOverview | null> {
    const result = await this.database.query<OverviewRow>(
      `
        WITH latest_presence AS (
          SELECT DISTINCT ON (actor_id)
            actor_id,
            event_type
          FROM room_events
          WHERE room_id = $1
            AND actor_id IS NOT NULL
            AND event_type IN ('actor_joined', 'actor_left')
          ORDER BY actor_id, sequence DESC
        ),
        room_participants AS (
          SELECT latest_presence.actor_id
          FROM latest_presence
          JOIN actors ON actors.id = latest_presence.actor_id
          WHERE latest_presence.event_type = 'actor_joined'
            AND actors.actor_type <> 'mod_bot'
            AND actors.retired_at IS NULL

          UNION

          SELECT assignments.mod_bot_id
          FROM room_mod_bot_assignments assignments
          JOIN actors ON actors.id = assignments.mod_bot_id
          WHERE assignments.room_id = $1
            AND actors.actor_type = 'mod_bot'
            AND actors.retired_at IS NULL
        ),
        online_counts AS (
          SELECT
            count(*) AS actors_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'human'
            ) AS people_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'chat_bot'
            ) AS chat_bots_online,
            count(*) FILTER (
              WHERE actors.actor_type = 'mod_bot'
            ) AS mod_bots_online
          FROM room_participants
          JOIN actors ON actors.id = room_participants.actor_id
        ),
        moderation_counts AS (
          SELECT
            count(*) FILTER (WHERE status = 'pending') AS proposals_pending,
            count(*) FILTER (WHERE status = 'accepted') AS proposals_accepted,
            count(*) FILTER (WHERE status = 'rejected') AS proposals_rejected
          FROM moderation_proposals
          WHERE room_id = $1
        )
        SELECT
          rooms.id,
          rooms.name,
          rooms.description,
          rooms.capacity,
          rooms.sort_order,
          rooms.capabilities,
          online_counts.actors_online,
          online_counts.people_online,
          online_counts.chat_bots_online,
          online_counts.mod_bots_online,
          moderation_counts.proposals_pending,
          moderation_counts.proposals_accepted,
          moderation_counts.proposals_rejected
        FROM rooms
        CROSS JOIN online_counts
        CROSS JOIN moderation_counts
        WHERE rooms.id = $1
      `,
      [roomId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      room: {
        id: row.id,
        name: row.name,
        description: row.description,
        capacity: row.capacity,
        sortOrder: row.sort_order,
        capabilities: row.capabilities,
        actorsOnline: Number(row.actors_online),
        peopleOnline: Number(row.people_online),
        chatBotsOnline: Number(row.chat_bots_online),
        modBotsOnline: Number(row.mod_bots_online),
      },
      moderation: {
        proposalsPending: Number(row.proposals_pending),
        proposalsAccepted: Number(row.proposals_accepted),
        proposalsRejected: Number(row.proposals_rejected),
      },
    };
  }

  public async listRoster(roomId: string): Promise<Actor[] | null> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [roomId],
    );

    if (!room.rows[0]?.exists) {
      return null;
    }

    const result = await this.database.query<ActorRow>(
      `
        WITH latest_presence AS (
          SELECT DISTINCT ON (actor_id)
            actor_id,
            event_type
          FROM room_events
          WHERE room_id = $1
            AND actor_id IS NOT NULL
            AND event_type IN ('actor_joined', 'actor_left')
          ORDER BY actor_id, sequence DESC
        ),
        room_participants AS (
          SELECT latest_presence.actor_id
          FROM latest_presence
          JOIN actors ON actors.id = latest_presence.actor_id
          WHERE latest_presence.event_type = 'actor_joined'
            AND actors.actor_type <> 'mod_bot'
            AND actors.retired_at IS NULL

          UNION

          SELECT assignments.mod_bot_id
          FROM room_mod_bot_assignments assignments
          JOIN actors ON actors.id = assignments.mod_bot_id
          WHERE assignments.room_id = $1
            AND actors.actor_type = 'mod_bot'
            AND actors.retired_at IS NULL
        )
        SELECT ${actorColumns}
        FROM room_participants
        JOIN actors ON actors.id = room_participants.actor_id
        ORDER BY
          CASE actors.actor_type
            WHEN 'mod_bot' THEN 0
            WHEN 'chat_bot' THEN 1
            ELSE 2
          END,
          actors.display_name
      `,
      [roomId],
    );

    return result.rows.map((actor) =>
      actorFromRow(actor, this.uppsBaseUrl),
    );
  }

  public async listEvents(
    roomId: string,
    options: { after: number; limit: number },
  ): Promise<RoomEvent[] | null> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [roomId],
    );

    if (!room.rows[0]?.exists) {
      return null;
    }

    const result = await this.database.query<EventRow>(
      `
        SELECT sequence, event_type, actor_id, payload, occurred_at
        FROM room_events
        WHERE room_id = $1 AND sequence > $2
        ORDER BY sequence ASC
        LIMIT $3
      `,
      [roomId, options.after, options.limit],
    );

    return result.rows.map((event) => ({
      sequence: event.sequence,
      type: event.event_type,
      actorId: event.actor_id,
      payload: event.payload,
      occurredAt: event.occurred_at.toISOString(),
    }));
  }

  public async listRecentEvents(
    roomId: string,
    options: { limit: number },
  ): Promise<RoomEvent[] | null> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [roomId],
    );

    if (!room.rows[0]?.exists) {
      return null;
    }

    const result = await this.database.query<EventRow>(
      `
        SELECT sequence, event_type, actor_id, payload, occurred_at
        FROM (
          SELECT sequence, event_type, actor_id, payload, occurred_at
          FROM room_events
          WHERE room_id = $1
          ORDER BY sequence DESC
          LIMIT $2
        ) recent_events
        ORDER BY sequence ASC
      `,
      [roomId, options.limit],
    );

    return result.rows.map((event) => ({
      sequence: event.sequence,
      type: event.event_type,
      actorId: event.actor_id,
      payload: event.payload,
      occurredAt: event.occurred_at.toISOString(),
    }));
  }
}
