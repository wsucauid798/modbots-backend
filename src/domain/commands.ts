import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../database.js";
import type { Actor, ActorType } from "../repositories/actors.js";
import type {
  ModerationProposal,
  ModerationProposalStatus,
} from "../repositories/moderation.js";
import type { RoomEvent } from "../repositories/rooms.js";
import {
  badRequest,
  conflict,
  notFound,
} from "./errors.js";
import { ModerationPolicy } from "./moderation-policy.js";

interface EventRow {
  sequence: string;
  event_type: string;
  actor_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

interface ActorRow {
  id: string;
  display_name: string;
  actor_type: ActorType;
  created_at: Date;
}

interface ProposalRow {
  id: string;
  room_id: string;
  mod_bot_id: string;
  target_event_sequence: string | null;
  action: string;
  confidence: number;
  rationale: unknown;
  model_version: string;
  status: ModerationProposalStatus;
  created_at: Date;
  resolved_at: Date | null;
}

export interface CreateActorCommand {
  id: string;
  displayName: string;
  type: ActorType;
}

export interface PresenceCommand {
  roomId: string;
  actorId: string;
  state: "joined" | "left";
}

export interface PostMessageCommand {
  roomId: string;
  actorId: string;
  content: string;
}

export interface CreateModerationProposalCommand {
  roomId: string;
  modBotId: string;
  targetEventSequence: string;
  action: string;
  confidence: number;
  rationale: unknown;
  modelVersion: string;
}

export interface DecideModerationProposalCommand {
  roomId: string;
  proposalId: string;
  reviewerActorId: string;
  decision: "accepted" | "rejected";
}

export interface CommandHandler {
  createActor(command: CreateActorCommand): Promise<Actor>;
  setPresence(command: PresenceCommand): Promise<RoomEvent>;
  postMessage(command: PostMessageCommand): Promise<RoomEvent>;
  createModerationProposal(
    command: CreateModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }>;
  decideModerationProposal(
    command: DecideModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }>;
}

const actorFromRow = (actor: ActorRow): Actor => ({
  id: actor.id,
  displayName: actor.display_name,
  type: actor.actor_type,
  createdAt: actor.created_at.toISOString(),
});

const proposalFromRow = (proposal: ProposalRow): ModerationProposal => ({
  id: proposal.id,
  roomId: proposal.room_id,
  modBotId: proposal.mod_bot_id,
  targetEventSequence: proposal.target_event_sequence,
  action: proposal.action,
  confidence: proposal.confidence,
  rationale: proposal.rationale,
  modelVersion: proposal.model_version,
  status: proposal.status,
  createdAt: proposal.created_at.toISOString(),
  resolvedAt: proposal.resolved_at?.toISOString() ?? null,
});

const eventFromRow = (event: EventRow): RoomEvent => ({
  sequence: event.sequence,
  type: event.event_type,
  actorId: event.actor_id,
  payload: event.payload,
  occurredAt: event.occurred_at.toISOString(),
});

const requireRoom = async (
  client: PoolClient,
  roomId: string,
): Promise<void> => {
  const room = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
    [roomId],
  );

  if (!room.rows[0]?.exists) {
    throw notFound("room_not_found", `Room '${roomId}' does not exist`);
  }
};

const requireActor = async (
  client: PoolClient,
  actorId: string,
): Promise<ActorRow> => {
  const result = await client.query<ActorRow>(
    `
      SELECT id, display_name, actor_type, created_at
      FROM actors
      WHERE id = $1
    `,
    [actorId],
  );
  const actor = result.rows[0];

  if (actor === undefined) {
    throw notFound("actor_not_found", `Actor '${actorId}' does not exist`);
  }

  return actor;
};

const requireOnline = async (
  client: PoolClient,
  roomId: string,
  actorId: string,
): Promise<void> => {
  const result = await client.query<{ event_type: string }>(
    `
      SELECT event_type
      FROM room_events
      WHERE room_id = $1
        AND actor_id = $2
        AND event_type IN ('actor_joined', 'actor_left')
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [roomId, actorId],
  );

  if (result.rows[0]?.event_type !== "actor_joined") {
    throw conflict(
      "actor_not_in_room",
      `Actor '${actorId}' must join room '${roomId}' first`,
    );
  }
};

const subjectToken = (roomId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(roomId)) {
    throw badRequest(
      "invalid_room_id",
      "Room IDs may only contain letters, numbers, underscores, and hyphens",
    );
  }

  return roomId;
};

const appendEvent = async (
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
  const event = eventFromRow(result.rows[0]!);
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

export class CommandService implements CommandHandler {
  public constructor(
    private readonly database: Pool,
    private readonly moderationPolicy: ModerationPolicy,
  ) {}

  public async createActor(command: CreateActorCommand): Promise<Actor> {
    try {
      const result = await this.database.query<ActorRow>(
        `
          INSERT INTO actors (id, display_name, actor_type)
          VALUES ($1, $2, $3)
          RETURNING id, display_name, actor_type, created_at
        `,
        [command.id, command.displayName, command.type],
      );

      return actorFromRow(result.rows[0]!);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw conflict(
          "actor_already_exists",
          `Actor '${command.id}' already exists`,
        );
      }

      throw error;
    }
  }

  public async setPresence(command: PresenceCommand): Promise<RoomEvent> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      await requireActor(client, command.actorId);

      return appendEvent(client, {
        roomId: command.roomId,
        type: command.state === "joined" ? "actor_joined" : "actor_left",
        actorId: command.actorId,
        payload: {},
      });
    });
  }

  public async postMessage(command: PostMessageCommand): Promise<RoomEvent> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      const actor = await requireActor(client, command.actorId);

      if (actor.actor_type === "mod_bot") {
        throw conflict(
          "actor_cannot_post_messages",
          "Mod bots cannot post room messages",
        );
      }

      await requireOnline(client, command.roomId, command.actorId);

      return appendEvent(client, {
        roomId: command.roomId,
        type: "message_posted",
        actorId: command.actorId,
        payload: {
          content: command.content,
        },
      });
    });
  }

  public async createModerationProposal(
    command: CreateModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      const modBot = await requireActor(client, command.modBotId);

      if (modBot.actor_type !== "mod_bot") {
        throw conflict(
          "actor_cannot_moderate",
          "Only mod bots can create moderation proposals",
        );
      }

      await requireOnline(client, command.roomId, command.modBotId);

      const target = await client.query<{ exists: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM room_events
            WHERE room_id = $1 AND sequence = $2
          ) AS exists
        `,
        [command.roomId, command.targetEventSequence],
      );

      if (!target.rows[0]?.exists) {
        throw notFound(
          "target_event_not_found",
          `Event '${command.targetEventSequence}' does not exist in this room`,
        );
      }

      const proposalResult = await client.query<ProposalRow>(
        `
          INSERT INTO moderation_proposals (
            id,
            room_id,
            mod_bot_id,
            target_event_sequence,
            action,
            confidence,
            rationale,
            model_version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            id,
            room_id,
            mod_bot_id,
            target_event_sequence::text,
            action,
            confidence,
            rationale,
            model_version,
            status,
            created_at,
            resolved_at
        `,
        [
          randomUUID(),
          command.roomId,
          command.modBotId,
          command.targetEventSequence,
          command.action,
          command.confidence,
          command.rationale,
          command.modelVersion,
        ],
      );
      const proposal = proposalFromRow(proposalResult.rows[0]!);
      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: "moderation_proposal_created",
        actorId: command.modBotId,
        payload: {
          proposalId: proposal.id,
          targetEventSequence: proposal.targetEventSequence,
          action: proposal.action,
          confidence: proposal.confidence,
          rationale: proposal.rationale,
          modelVersion: proposal.modelVersion,
        },
      });

      return { proposal, event };
    });
  }

  public async decideModerationProposal(
    command: DecideModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      const reviewer = await requireActor(client, command.reviewerActorId);

      if (reviewer.actor_type !== "human") {
        throw conflict(
          "actor_cannot_review_moderation",
          "Only human actors can review moderation proposals",
        );
      }

      const proposalResult = await client.query<ProposalRow>(
        `
          SELECT
            id,
            room_id,
            mod_bot_id,
            target_event_sequence::text,
            action,
            confidence,
            rationale,
            model_version,
            status,
            created_at,
            resolved_at
          FROM moderation_proposals
          WHERE id = $1 AND room_id = $2
          FOR UPDATE
        `,
        [command.proposalId, command.roomId],
      );
      const existing = proposalResult.rows[0];

      if (existing === undefined) {
        throw notFound(
          "moderation_proposal_not_found",
          `Proposal '${command.proposalId}' does not exist in this room`,
        );
      }

      if (existing.status !== "pending") {
        throw conflict(
          "moderation_proposal_already_resolved",
          `Proposal '${command.proposalId}' has already been resolved`,
        );
      }

      if (command.decision === "accepted") {
        this.moderationPolicy.assertCanAccept(existing);
      }

      const updatedResult = await client.query<ProposalRow>(
        `
          UPDATE moderation_proposals
          SET status = $1, resolved_at = now()
          WHERE id = $2
          RETURNING
            id,
            room_id,
            mod_bot_id,
            target_event_sequence::text,
            action,
            confidence,
            rationale,
            model_version,
            status,
            created_at,
            resolved_at
        `,
        [command.decision, command.proposalId],
      );
      const proposal = proposalFromRow(updatedResult.rows[0]!);
      const eventType =
        command.decision === "accepted"
          ? "moderation_action_applied"
          : "moderation_proposal_rejected";
      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: eventType,
        actorId: command.reviewerActorId,
        payload: {
          proposalId: proposal.id,
          targetEventSequence: proposal.targetEventSequence,
          action: proposal.action,
          reviewedBy: command.reviewerActorId,
        },
      });

      return { proposal, event };
    });
  }
}
