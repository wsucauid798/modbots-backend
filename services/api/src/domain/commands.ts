import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../database.js";
import { roomRules } from "./rules.js";
import {
  renderActorProfilePictureUrl,
  renderActorDisplay,
  residentProfilePictureId,
} from "../repositories/actors.js";
import type { Actor, ActorType } from "../repositories/actors.js";
import { contentItemFromRow } from "../repositories/content.js";
import type {
  ContentItem,
  ContentItemReference,
  ContentItemRow,
  ContentPart,
  ContentRelationship,
} from "../repositories/content.js";
import type {
  ModerationEvidence,
  ModerationProposal,
  ModerationProposalStatus,
  ModerationTarget,
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
  handle: string | null;
  display_name: string;
  discriminator: string | null;
  registered: boolean;
  actor_type: ActorType;
  profile_picture_id: string | null;
  policy_version_accepted: string | null;
  policy_accepted_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
}

interface ProposalRow {
  id: string;
  room_id: string;
  mod_bot_id: string;
  target: ModerationTarget | null;
  target_event_sequence: string | null;
  evidence: ModerationEvidence[];
  action: string;
  rule_id: string | null;
  rules_version: string | null;
  confidence: number;
  rationale: unknown;
  model_version: string;
  status: ModerationProposalStatus;
  created_at: Date;
  resolved_at: Date | null;
}

export interface CreateActorCommand {
  displayName: string;
  type: ActorType;
  handle?: string;
  registered?: boolean;
  policyVersionAccepted?: string;
}

export interface RenameActorCommand {
  actorId: string;
  displayName: string;
}

export interface RetireActorCommand {
  actorId: string;
}

export interface RestoreActorCommand {
  actorId: string;
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
  replyTo?: ContentItemReference;
}

export interface ContentPartInput {
  kind: "text";
  text: string;
  language?: string;
  partId?: string;
}

export interface PostContentCommand {
  roomId: string;
  actorId: string;
  parts: ContentPartInput[];
  replyTo?: ContentItemReference;
  references?: ContentRelationship[];
}

export interface EditContentCommand {
  roomId: string;
  contentItemId: string;
  actorId: string;
  parts: ContentPartInput[];
}

export interface RemoveContentCommand {
  roomId: string;
  contentItemId: string;
  actorId: string;
}

export interface CreateModerationProposalCommand {
  roomId: string;
  modBotId: string;
  target?: ModerationTarget;
  targetEventSequence?: string;
  evidence?: ModerationEvidence[];
  action: string;
  ruleId?: string;
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
  renameActor(command: RenameActorCommand): Promise<Actor>;
  retireActor(command: RetireActorCommand): Promise<Actor>;
  restoreActor(command: RestoreActorCommand): Promise<Actor>;
  setPresence(command: PresenceCommand): Promise<RoomEvent>;
  postMessage(command: PostMessageCommand): Promise<RoomEvent>;
  postContent(
    command: PostContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }>;
  editContent(
    command: EditContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }>;
  removeContent(
    command: RemoveContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }>;
  createModerationProposal(
    command: CreateModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }>;
  decideModerationProposal(
    command: DecideModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }>;
}

const actorFromRow = (actor: ActorRow, uppsBaseUrl: string): Actor => ({
  id: actor.id,
  handle: actor.handle,
  displayName: actor.display_name,
  discriminator: actor.discriminator,
  registered: actor.registered,
  display: renderActorDisplay(actor),
  profilePictureId: actor.profile_picture_id,
  profilePictureUrl: renderActorProfilePictureUrl(
    actor.profile_picture_id,
    uppsBaseUrl,
  ),
  type: actor.actor_type,
  policyVersionAccepted: actor.policy_version_accepted,
  policyAcceptedAt: actor.policy_accepted_at?.toISOString() ?? null,
  retiredAt: actor.retired_at?.toISOString() ?? null,
  createdAt: actor.created_at.toISOString(),
});

const actorColumns = `id, handle, display_name, discriminator, registered, actor_type, profile_picture_id, policy_version_accepted, policy_accepted_at, retired_at, created_at`;

const uniqueViolation = (error: unknown): string | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    const constraint = (error as { constraint?: string }).constraint;
    return constraint ?? "unknown";
  }

  return null;
};

const discriminatorStartWidth = 4;
const discriminatorMaxWidth = 8;
const discriminatorAttemptsPerWidth = 25;

const randomDiscriminator = (width: number): string =>
  String(Math.floor(Math.random() * 10 ** width)).padStart(width, "0");

const proposalFromRow = (proposal: ProposalRow): ModerationProposal => ({
  id: proposal.id,
  roomId: proposal.room_id,
  modBotId: proposal.mod_bot_id,
  target: proposal.target,
  targetEventSequence: proposal.target_event_sequence,
  evidence: proposal.evidence,
  action: proposal.action,
  ruleId: proposal.rule_id,
  rulesVersion: proposal.rules_version,
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
      SELECT id, handle, display_name, discriminator, registered,
        actor_type, retired_at, created_at
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

const requireActiveActor = async (
  client: PoolClient,
  actorId: string,
): Promise<ActorRow> => {
  const actor = await requireActor(client, actorId);

  if (actor.retired_at !== null) {
    throw conflict(
      "actor_retired",
      `Actor '${actorId}' is retired and cannot act in rooms`,
    );
  }

  return actor;
};

const isOnline = async (
  client: PoolClient,
  roomId: string,
  actorId: string,
): Promise<boolean> => {
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

  return result.rows[0]?.event_type === "actor_joined";
};

const requireOnline = async (
  client: PoolClient,
  roomId: string,
  actorId: string,
): Promise<void> => {
  if (!(await isOnline(client, roomId, actorId))) {
    throw conflict(
      "actor_not_in_room",
      `Actor '${actorId}' must join room '${roomId}' first`,
    );
  }
};

// Mute state is derived from the event history, like presence: the latest
// actor_muted or actor_unmuted event for the actor in the room decides.
const isMuted = async (
  client: PoolClient,
  roomId: string,
  actorId: string,
): Promise<boolean> => {
  const result = await client.query<{ event_type: string }>(
    `
      SELECT event_type
      FROM room_events
      WHERE room_id = $1
        AND actor_id = $2
        AND event_type IN ('actor_muted', 'actor_unmuted')
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [roomId, actorId],
  );

  return result.rows[0]?.event_type === "actor_muted";
};

const requireNotMuted = async (
  client: PoolClient,
  roomId: string,
  actorId: string,
): Promise<void> => {
  if (await isMuted(client, roomId, actorId)) {
    throw conflict(
      "actor_muted",
      `Actor '${actorId}' is muted in room '${roomId}'`,
    );
  }
};

const contentColumns = `
  id, room_id, room_sequence::text, actor_id, lifecycle_state, revision,
  reply_to, parts, refs, created_at, updated_at
`;

const maxContentParts = 64;
const maxContentTextLength = 65_536;
const maxContentReferences = 64;

// Validate part inputs and assign stable part identifiers. On edit,
// `existingParts` lets an input keep a part identifier from the current
// revision; identifiers never come from thin air.
const buildContentParts = (
  inputs: ContentPartInput[],
  existingParts: ContentPart[] | null,
): ContentPart[] => {
  if (inputs.length === 0 || inputs.length > maxContentParts) {
    throw badRequest(
      "invalid_content_parts",
      `'parts' must contain 1 to ${maxContentParts} parts`,
    );
  }

  const existingIds = new Set(
    (existingParts ?? []).map((part) => part.partId),
  );
  const usedIds = new Set<string>();

  return inputs.map((input) => {
    if (
      typeof input.text !== "string" ||
      input.text.trim().length === 0 ||
      input.text.length > maxContentTextLength
    ) {
      throw badRequest(
        "invalid_content_parts",
        `Each text part must contain 1 to ${maxContentTextLength} characters`,
      );
    }

    let partId: string;

    if (input.partId !== undefined) {
      if (!existingIds.has(input.partId)) {
        throw badRequest(
          "invalid_part_id",
          `Part '${input.partId}' does not exist in the current revision`,
        );
      }

      partId = input.partId;
    } else {
      partId = randomUUID();
    }

    if (usedIds.has(partId)) {
      throw badRequest(
        "invalid_part_id",
        `Part '${partId}' appears more than once`,
      );
    }

    usedIds.add(partId);

    return {
      partId,
      kind: "text" as const,
      text: input.text,
      ...(input.language === undefined ? {} : { language: input.language }),
    };
  });
};

const getContentItemRow = async (
  client: PoolClient,
  roomId: string,
  contentItemId: string,
  options: { forUpdate: boolean } = { forUpdate: false },
): Promise<ContentItemRow | null> => {
  const result = await client.query<ContentItemRow>(
    `
      SELECT ${contentColumns}
      FROM content_items
      WHERE room_id = $1 AND id = $2
      ${options.forUpdate ? "FOR UPDATE" : ""}
    `,
    [roomId, contentItemId],
  );

  return result.rows[0] ?? null;
};

const requireContentTarget = async (
  client: PoolClient,
  roomId: string,
  contentItemId: string,
  contentPartId?: string,
): Promise<void> => {
  const row = await getContentItemRow(client, roomId, contentItemId);

  if (row === null) {
    throw notFound(
      "content_item_not_found",
      `Content item '${contentItemId}' does not exist in this room`,
    );
  }

  if (
    contentPartId !== undefined &&
    !row.parts.some((part) => part.partId === contentPartId)
  ) {
    throw notFound(
      "content_part_not_found",
      `Part '${contentPartId}' does not exist on content item '${contentItemId}'`,
    );
  }
};

const requireReferences = async (
  client: PoolClient,
  roomId: string,
  references: ContentRelationship[],
): Promise<void> => {
  if (references.length > maxContentReferences) {
    throw badRequest(
      "invalid_content_references",
      `'references' must contain at most ${maxContentReferences} entries`,
    );
  }

  for (const reference of references) {
    const target = reference.target;

    if (target.targetType === "content_item") {
      await requireContentTarget(client, roomId, target.contentItemId);
    } else if (target.targetType === "content_part") {
      await requireContentTarget(
        client,
        roomId,
        target.contentItemId,
        target.contentPartId,
      );
    } else {
      // Media assets and voice entities are valid contract targets but do
      // not exist in the system yet.
      throw conflict(
        "reference_target_not_available",
        `'${target.targetType}' targets are not available until that entity type is implemented`,
      );
    }
  }
};

const proposalColumns = `
  id, room_id, mod_bot_id, target, target_event_sequence::text, evidence,
  action, rule_id, rules_version, confidence, rationale, model_version,
  status, created_at, resolved_at
`;

// Resolve and validate the subject of a moderation proposal. Typed targets
// must exist in the same room; the legacy event-sequence path resolves to the
// content item that event produced. Content targets keep the legacy sequence
// column populated for older readers.
const resolveModerationTarget = async (
  client: PoolClient,
  roomId: string,
  command: CreateModerationProposalCommand,
): Promise<{ target: ModerationTarget; targetEventSequence: string | null }> => {
  if (command.target !== undefined) {
    const target = command.target;

    if (target.targetType === "actor") {
      await requireActor(client, target.actorId);
      return { target, targetEventSequence: null };
    }

    if (
      target.targetType === "content_item" ||
      target.targetType === "content_part"
    ) {
      await requireContentTarget(
        client,
        roomId,
        target.contentItemId,
        target.targetType === "content_part" ? target.contentPartId : undefined,
      );
      const row = await getContentItemRow(client, roomId, target.contentItemId);

      return { target, targetEventSequence: row?.room_sequence ?? null };
    }

    throw conflict(
      "target_type_not_available",
      `'${target.targetType}' targets are not available until that entity type is implemented`,
    );
  }

  if (command.targetEventSequence !== undefined) {
    const row = await client.query<{ id: string }>(
      `
        SELECT id FROM content_items
        WHERE room_id = $1 AND room_sequence = $2
      `,
      [roomId, command.targetEventSequence],
    );
    const contentItemId = row.rows[0]?.id;

    if (contentItemId === undefined) {
      throw notFound(
        "target_event_not_found",
        `Event '${command.targetEventSequence}' does not correspond to room content`,
      );
    }

    return {
      target: { targetType: "content_item", contentItemId },
      targetEventSequence: command.targetEventSequence,
    };
  }

  throw badRequest(
    "invalid_moderation_target",
    "A proposal requires 'target' or the legacy 'targetEventSequence'",
  );
};

const requireModerationEvidence = async (
  client: PoolClient,
  roomId: string,
  evidence: ModerationEvidence[],
): Promise<void> => {
  if (evidence.length > maxContentReferences) {
    throw badRequest(
      "invalid_moderation_evidence",
      `'evidence' must contain at most ${maxContentReferences} entries`,
    );
  }

  for (const entry of evidence) {
    const target = entry.target;

    if (target.targetType === "actor") {
      await requireActor(client, target.actorId);
    } else if (target.targetType === "content_item") {
      await requireContentTarget(client, roomId, target.contentItemId);
    } else if (target.targetType === "content_part") {
      await requireContentTarget(
        client,
        roomId,
        target.contentItemId,
        target.contentPartId,
      );
    } else {
      throw conflict(
        "target_type_not_available",
        `'${target.targetType}' evidence is not available until that entity type is implemented`,
      );
    }
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
    private readonly uppsBaseUrl: string,
  ) {}

  public async createActor(command: CreateActorCommand): Promise<Actor> {
    const isHuman = command.type === "human";
    let width = discriminatorStartWidth;
    let attemptsAtWidth = 0;

    while (true) {
      const discriminator = isHuman ? randomDiscriminator(width) : null;

      try {
        const result = await this.database.query<ActorRow>(
          `
            INSERT INTO actors (
              id, handle, display_name, discriminator, registered, actor_type,
              profile_picture_id, policy_version_accepted, policy_accepted_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8,
              CASE WHEN $8::text IS NULL THEN NULL ELSE now() END
            )
            RETURNING ${actorColumns}
          `,
          [
            randomUUID(),
            command.handle ?? null,
            command.displayName,
            discriminator,
            command.registered ?? false,
            command.type,
            residentProfilePictureId(command.handle ?? null, command.type),
            command.policyVersionAccepted ?? null,
          ],
        );

        return actorFromRow(result.rows[0]!, this.uppsBaseUrl);
      } catch (error) {
        const constraint = uniqueViolation(error);

        if (constraint === "actors_handle_idx") {
          throw conflict(
            "actor_handle_taken",
            `Handle '${command.handle}' is already in use`,
          );
        }

        if (constraint === "actors_bot_name_idx") {
          throw conflict(
            "bot_name_taken",
            `A bot named '${command.displayName}' already exists`,
          );
        }

        if (constraint === "actors_human_identity_idx" && isHuman) {
          attemptsAtWidth += 1;

          if (attemptsAtWidth >= discriminatorAttemptsPerWidth) {
            if (width >= discriminatorMaxWidth) {
              throw conflict(
                "discriminator_space_exhausted",
                `No discriminator is available for '${command.displayName}'`,
              );
            }

            width += 1;
            attemptsAtWidth = 0;
          }

          continue;
        }

        throw error;
      }
    }
  }

  public async renameActor(command: RenameActorCommand): Promise<Actor> {
    const existing = await this.database.query<ActorRow>(
      `SELECT ${actorColumns} FROM actors WHERE id = $1`,
      [command.actorId],
    );
    const actor = existing.rows[0];

    if (actor === undefined) {
      throw notFound(
        "actor_not_found",
        `Actor '${command.actorId}' does not exist`,
      );
    }

    if (actor.display_name === command.displayName) {
      return actorFromRow(actor, this.uppsBaseUrl);
    }

    const isHuman = actor.actor_type === "human";
    let width = discriminatorStartWidth;
    let attemptsAtWidth = 0;

    // A human identity is the name and discriminator pair, so a renamed human
    // receives a fresh discriminator under the new name.
    while (true) {
      const discriminator = isHuman ? randomDiscriminator(width) : null;

      try {
        const result = await this.database.query<ActorRow>(
          `
            UPDATE actors
            SET display_name = $2, discriminator = COALESCE($3, discriminator)
            WHERE id = $1
            RETURNING ${actorColumns}
          `,
          [command.actorId, command.displayName, discriminator],
        );

        return actorFromRow(result.rows[0]!, this.uppsBaseUrl);
      } catch (error) {
        const constraint = uniqueViolation(error);

        if (constraint === "actors_bot_name_idx") {
          throw conflict(
            "bot_name_taken",
            `A bot named '${command.displayName}' already exists`,
          );
        }

        if (constraint === "actors_human_identity_idx" && isHuman) {
          attemptsAtWidth += 1;

          if (attemptsAtWidth >= discriminatorAttemptsPerWidth) {
            if (width >= discriminatorMaxWidth) {
              throw conflict(
                "discriminator_space_exhausted",
                `No discriminator is available for '${command.displayName}'`,
              );
            }

            width += 1;
            attemptsAtWidth = 0;
          }

          continue;
        }

        throw error;
      }
    }
  }

  public async retireActor(command: RetireActorCommand): Promise<Actor> {
    return withTransaction(this.database, async (client) => {
      const updated = await client.query<ActorRow>(
        `
          UPDATE actors
          SET retired_at = COALESCE(retired_at, now())
          WHERE id = $1
          RETURNING ${actorColumns}
        `,
        [command.actorId],
      );
      const actor = updated.rows[0];

      if (actor === undefined) {
        throw notFound(
          "actor_not_found",
          `Actor '${command.actorId}' does not exist`,
        );
      }

      // Leave every room the actor is currently in, so retiring removes them
      // from live presence without rewriting history.
      const activeRooms = await client.query<{ room_id: string }>(
        `
          SELECT room_id
          FROM (
            SELECT
              room_id,
              event_type,
              ROW_NUMBER() OVER (
                PARTITION BY room_id ORDER BY sequence DESC
              ) AS rn
            FROM room_events
            WHERE actor_id = $1
              AND event_type IN ('actor_joined', 'actor_left')
          ) latest
          WHERE rn = 1 AND event_type = 'actor_joined'
        `,
        [command.actorId],
      );

      for (const row of activeRooms.rows) {
        await appendEvent(client, {
          roomId: row.room_id,
          type: "actor_left",
          actorId: command.actorId,
          payload: { reason: "retired" },
        });
      }

      return actorFromRow(actor, this.uppsBaseUrl);
    });
  }

  public async restoreActor(command: RestoreActorCommand): Promise<Actor> {
    try {
      const result = await this.database.query<ActorRow>(
        `
          UPDATE actors
          SET retired_at = NULL
          WHERE id = $1
          RETURNING ${actorColumns}
        `,
        [command.actorId],
      );
      const actor = result.rows[0];

      if (actor === undefined) {
        throw notFound(
          "actor_not_found",
          `Actor '${command.actorId}' does not exist`,
        );
      }

      return actorFromRow(actor, this.uppsBaseUrl);
    } catch (error) {
      // A retired bot's name may have been reused while it was retired.
      if (uniqueViolation(error) === "actors_bot_name_idx") {
        throw conflict(
          "bot_name_taken",
          "The bot's name was reused while it was retired",
        );
      }

      throw error;
    }
  }

  public async setPresence(command: PresenceCommand): Promise<RoomEvent> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);

      // A retired actor may still leave a room, but never join one.
      if (command.state === "joined") {
        await requireActiveActor(client, command.actorId);
      } else {
        await requireActor(client, command.actorId);
      }

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
      const actor = await requireActiveActor(client, command.actorId);

      await requireOnline(client, command.roomId, command.actorId);
      await requireNotMuted(client, command.roomId, command.actorId);

      if (command.replyTo !== undefined) {
        await requireContentTarget(
          client,
          command.roomId,
          command.replyTo.contentItemId,
          command.replyTo.contentPartId,
        );
      }

      // Compatibility path: the event stays message_posted for existing text
      // clients, while the same transaction materializes the message as a
      // content item with one text part.
      const contentItemId = randomUUID();
      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: "message_posted",
        actorId: command.actorId,
        payload: {
          content: command.content,
          contentItemId,
          ...(command.replyTo === undefined
            ? {}
            : { replyTo: command.replyTo }),
          authorRegistered: actor.registered,
        },
      });

      await client.query(
        `
          INSERT INTO content_items (
            id, room_id, room_sequence, actor_id, reply_to, parts,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        `,
        [
          contentItemId,
          command.roomId,
          event.sequence,
          command.actorId,
          command.replyTo === undefined
            ? null
            : JSON.stringify(command.replyTo),
          JSON.stringify([
            { partId: randomUUID(), kind: "text", text: command.content },
          ]),
          event.occurredAt,
        ],
      );

      return event;
    });
  }

  public async postContent(
    command: PostContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      const actor = await requireActiveActor(client, command.actorId);

      await requireOnline(client, command.roomId, command.actorId);
      await requireNotMuted(client, command.roomId, command.actorId);

      const parts = buildContentParts(command.parts, null);
      const references = command.references ?? [];

      if (command.replyTo !== undefined) {
        await requireContentTarget(
          client,
          command.roomId,
          command.replyTo.contentItemId,
          command.replyTo.contentPartId,
        );
      }

      await requireReferences(client, command.roomId, references);

      const contentItemId = randomUUID();
      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: "content_posted",
        actorId: command.actorId,
        payload: {
          contentItemId,
          lifecycleState: "published",
          revision: 1,
          parts,
          ...(command.replyTo === undefined
            ? {}
            : { replyTo: command.replyTo }),
          references,
          authorRegistered: actor.registered,
        },
      });

      const inserted = await client.query<ContentItemRow>(
        `
          INSERT INTO content_items (
            id, room_id, room_sequence, actor_id, reply_to, parts, refs,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          RETURNING ${contentColumns}
        `,
        [
          contentItemId,
          command.roomId,
          event.sequence,
          command.actorId,
          command.replyTo === undefined
            ? null
            : JSON.stringify(command.replyTo),
          JSON.stringify(parts),
          JSON.stringify(references),
          event.occurredAt,
        ],
      );

      return {
        contentItem: contentItemFromRow(inserted.rows[0]!),
        event,
      };
    });
  }

  public async editContent(
    command: EditContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      await requireActiveActor(client, command.actorId);
      await requireOnline(client, command.roomId, command.actorId);
      await requireNotMuted(client, command.roomId, command.actorId);

      const row = await getContentItemRow(
        client,
        command.roomId,
        command.contentItemId,
        { forUpdate: true },
      );

      if (row === null) {
        throw notFound(
          "content_item_not_found",
          `Content item '${command.contentItemId}' does not exist in this room`,
        );
      }

      if (row.actor_id !== command.actorId) {
        throw conflict(
          "actor_cannot_edit_content",
          "Only the author can edit a content item",
        );
      }

      if (row.lifecycle_state === "removed") {
        throw conflict(
          "content_item_removed",
          "Removed content cannot be edited",
        );
      }

      const parts = buildContentParts(command.parts, row.parts);
      const revision = row.revision + 1;
      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: "content_edited",
        actorId: command.actorId,
        payload: {
          contentItemId: command.contentItemId,
          revision,
          parts,
        },
      });

      const updated = await client.query<ContentItemRow>(
        `
          UPDATE content_items
          SET parts = $3, revision = $4, lifecycle_state = 'edited',
            updated_at = $5
          WHERE room_id = $1 AND id = $2
          RETURNING ${contentColumns}
        `,
        [
          command.roomId,
          command.contentItemId,
          JSON.stringify(parts),
          revision,
          event.occurredAt,
        ],
      );

      return {
        contentItem: contentItemFromRow(updated.rows[0]!),
        event,
      };
    });
  }

  public async removeContent(
    command: RemoveContentCommand,
  ): Promise<{ contentItem: ContentItem; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      await requireActiveActor(client, command.actorId);
      await requireOnline(client, command.roomId, command.actorId);

      const row = await getContentItemRow(
        client,
        command.roomId,
        command.contentItemId,
        { forUpdate: true },
      );

      if (row === null) {
        throw notFound(
          "content_item_not_found",
          `Content item '${command.contentItemId}' does not exist in this room`,
        );
      }

      if (row.actor_id !== command.actorId) {
        throw conflict(
          "actor_cannot_remove_content",
          "Only the author can remove a content item",
        );
      }

      if (row.lifecycle_state === "removed") {
        throw conflict(
          "content_item_removed",
          "The content item is already removed",
        );
      }

      const event = await appendEvent(client, {
        roomId: command.roomId,
        type: "content_removed",
        actorId: command.actorId,
        payload: {
          contentItemId: command.contentItemId,
        },
      });

      const updated = await client.query<ContentItemRow>(
        `
          UPDATE content_items
          SET lifecycle_state = 'removed', updated_at = $3
          WHERE room_id = $1 AND id = $2
          RETURNING ${contentColumns}
        `,
        [command.roomId, command.contentItemId, event.occurredAt],
      );

      return {
        contentItem: contentItemFromRow(updated.rows[0]!),
        event,
      };
    });
  }

  public async createModerationProposal(
    command: CreateModerationProposalCommand,
  ): Promise<{ proposal: ModerationProposal; event: RoomEvent }> {
    return withTransaction(this.database, async (client) => {
      await requireRoom(client, command.roomId);
      const modBot = await requireActiveActor(client, command.modBotId);

      if (modBot.actor_type !== "mod_bot") {
        throw conflict(
          "actor_cannot_moderate",
          "Only mod bots can create moderation proposals",
        );
      }

      await requireOnline(client, command.roomId, command.modBotId);

      const { target, targetEventSequence } = await resolveModerationTarget(
        client,
        command.roomId,
        command,
      );
      const evidence = command.evidence ?? [];
      await requireModerationEvidence(client, command.roomId, evidence);
      this.moderationPolicy.assertTargetAllowed(command.action, target);

      const proposalResult = await client.query<ProposalRow>(
        `
          INSERT INTO moderation_proposals (
            id,
            room_id,
            mod_bot_id,
            target,
            target_event_sequence,
            evidence,
            action,
            rule_id,
            rules_version,
            confidence,
            rationale,
            model_version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING ${proposalColumns}
        `,
        [
          randomUUID(),
          command.roomId,
          command.modBotId,
          JSON.stringify(target),
          targetEventSequence,
          JSON.stringify(evidence),
          command.action,
          command.ruleId ?? null,
          command.ruleId === undefined ? null : roomRules.version,
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
          target: proposal.target,
          targetEventSequence: proposal.targetEventSequence,
          evidence: proposal.evidence,
          action: proposal.action,
          ...(proposal.ruleId === null
            ? {}
            : { ruleId: proposal.ruleId, rulesVersion: proposal.rulesVersion }),
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
      const reviewer = await requireActiveActor(client, command.reviewerActorId);

      if (reviewer.actor_type !== "human") {
        throw conflict(
          "actor_cannot_review_moderation",
          "Only human actors can review moderation proposals",
        );
      }

      const proposalResult = await client.query<ProposalRow>(
        `
          SELECT ${proposalColumns}
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
          RETURNING ${proposalColumns}
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
          target: proposal.target,
          targetEventSequence: proposal.targetEventSequence,
          action: proposal.action,
          ...(proposal.ruleId === null
            ? {}
            : { ruleId: proposal.ruleId, rulesVersion: proposal.rulesVersion }),
          reviewedBy: command.reviewerActorId,
        },
      });

      // An accepted content deletion is enforced through the policy gate:
      // the targeted content transitions to removed as part of the same
      // decision transaction.
      if (
        command.decision === "accepted" &&
        proposal.action === "delete_message" &&
        proposal.target !== null &&
        (proposal.target.targetType === "content_item" ||
          proposal.target.targetType === "content_part")
      ) {
        const row = await getContentItemRow(
          client,
          command.roomId,
          proposal.target.contentItemId,
          { forUpdate: true },
        );

        if (row !== null && row.lifecycle_state !== "removed") {
          const removal = await appendEvent(client, {
            roomId: command.roomId,
            type: "content_removed",
            actorId: command.reviewerActorId,
            payload: {
              contentItemId: row.id,
              reason: "moderation",
              proposalId: proposal.id,
            },
          });

          await client.query(
            `
              UPDATE content_items
              SET lifecycle_state = 'removed', updated_at = $3
              WHERE room_id = $1 AND id = $2
            `,
            [command.roomId, row.id, removal.occurredAt],
          );
        }
      }

      // Accepted actor actions are enforced through the same gate. Mute
      // state derives from actor_muted and actor_unmuted events; removal
      // reuses the presence vocabulary.
      if (
        command.decision === "accepted" &&
        proposal.target !== null &&
        proposal.target.targetType === "actor"
      ) {
        const targetActorId = proposal.target.actorId;
        const enforcementPayload = {
          reason: "moderation",
          proposalId: proposal.id,
          reviewedBy: command.reviewerActorId,
        };

        if (
          proposal.action === "mute_actor" &&
          !(await isMuted(client, command.roomId, targetActorId))
        ) {
          await appendEvent(client, {
            roomId: command.roomId,
            type: "actor_muted",
            actorId: targetActorId,
            payload: enforcementPayload,
          });
        } else if (
          proposal.action === "unmute_actor" &&
          (await isMuted(client, command.roomId, targetActorId))
        ) {
          await appendEvent(client, {
            roomId: command.roomId,
            type: "actor_unmuted",
            actorId: targetActorId,
            payload: enforcementPayload,
          });
        } else if (
          proposal.action === "remove_actor" &&
          (await isOnline(client, command.roomId, targetActorId))
        ) {
          await appendEvent(client, {
            roomId: command.roomId,
            type: "actor_left",
            actorId: targetActorId,
            payload: enforcementPayload,
          });
        }
      }

      return { proposal, event };
    });
  }
}
