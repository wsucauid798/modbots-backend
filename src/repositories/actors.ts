import type { Pool } from "pg";

export type ActorType = "human" | "chat_bot" | "mod_bot";

export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  discriminator: string | null;
  registered: boolean;
  display: string;
  type: ActorType;
  policyVersionAccepted: string | null;
  policyAcceptedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export interface ActorRepository {
  getById(actorId: string): Promise<Actor | null>;
  getByHandle(handle: string): Promise<Actor | null>;
}

interface ActorRow {
  id: string;
  handle: string | null;
  display_name: string;
  discriminator: string | null;
  registered: boolean;
  actor_type: ActorType;
  policy_version_accepted: string | null;
  policy_accepted_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
}

// Humans are always rendered with their discriminator, never as a bare name.
// The separator encodes registration: '#' for registered, '-' for guests.
// Bots are rendered as their bare unique name.
export const renderActorDisplay = (actor: {
  display_name: string;
  discriminator: string | null;
  registered: boolean;
  actor_type: ActorType;
}): string => {
  if (actor.actor_type !== "human" || actor.discriminator === null) {
    return actor.display_name;
  }

  const separator = actor.registered ? "#" : "-";
  return `${actor.display_name}${separator}${actor.discriminator}`;
};

const actorFromRow = (actor: ActorRow): Actor => ({
  id: actor.id,
  handle: actor.handle,
  displayName: actor.display_name,
  discriminator: actor.discriminator,
  registered: actor.registered,
  display: renderActorDisplay(actor),
  type: actor.actor_type,
  policyVersionAccepted: actor.policy_version_accepted,
  policyAcceptedAt: actor.policy_accepted_at?.toISOString() ?? null,
  retiredAt: actor.retired_at?.toISOString() ?? null,
  createdAt: actor.created_at.toISOString(),
});

const selectColumns = `id, handle, display_name, discriminator, registered, actor_type, policy_version_accepted, policy_accepted_at, retired_at, created_at`;

export class PostgresActorRepository implements ActorRepository {
  public constructor(private readonly database: Pool) {}

  public async getById(actorId: string): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `SELECT ${selectColumns} FROM actors WHERE id = $1`,
      [actorId],
    );
    const actor = result.rows[0];

    return actor === undefined ? null : actorFromRow(actor);
  }

  public async getByHandle(handle: string): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `SELECT ${selectColumns} FROM actors WHERE handle = $1`,
      [handle],
    );
    const actor = result.rows[0];

    return actor === undefined ? null : actorFromRow(actor);
  }
}
