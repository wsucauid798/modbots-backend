import type { Pool } from "pg";

export type ActorType = "human" | "chat_bot" | "mod_bot";

const residentProfilePictureIds: Record<string, string> = {
  arwen: "resident-arwen",
  bob: "resident-bob",
  felix: "resident-felix",
  iris: "resident-iris",
  jacob: "resident-jacob",
  milo: "resident-milo",
  "ru-bot": "resident-ru-bot",
  vera: "resident-vera",
};

export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  discriminator: string | null;
  registered: boolean;
  display: string;
  profilePictureId: string | null;
  profilePictureUrl: string | null;
  type: ActorType;
  policyVersionAccepted: string | null;
  policyAcceptedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

export interface ActorRepository {
  getById(actorId: string): Promise<Actor | null>;
  getByHandle(handle: string): Promise<Actor | null>;
  recordPolicyAcceptance(
    actorId: string,
    policyVersion: string,
  ): Promise<Actor | null>;
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

export const residentProfilePictureId = (
  handle: string | null,
  actorType: ActorType,
): string | null =>
  actorType === "human" || handle === null
    ? null
    : (residentProfilePictureIds[handle] ?? null);

export const renderActorProfilePictureUrl = (
  profilePictureId: string | null,
  uppsBaseUrl: string,
): string | null =>
  profilePictureId === null
    ? null
    : new URL(
        `/profile-pictures/${encodeURIComponent(profilePictureId)}`,
        uppsBaseUrl,
      ).toString();

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

const selectColumns = `id, handle, display_name, discriminator, registered, actor_type, profile_picture_id, policy_version_accepted, policy_accepted_at, retired_at, created_at`;

export class PostgresActorRepository implements ActorRepository {
  public constructor(
    private readonly database: Pool,
    private readonly uppsBaseUrl: string,
  ) {}

  public async getById(actorId: string): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `SELECT ${selectColumns} FROM actors WHERE id = $1`,
      [actorId],
    );
    const actor = result.rows[0];

    return actor === undefined ? null : actorFromRow(actor, this.uppsBaseUrl);
  }

  public async getByHandle(handle: string): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `SELECT ${selectColumns} FROM actors WHERE handle = $1`,
      [handle],
    );
    const actor = result.rows[0];

    return actor === undefined ? null : actorFromRow(actor, this.uppsBaseUrl);
  }

  public async recordPolicyAcceptance(
    actorId: string,
    policyVersion: string,
  ): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `
        UPDATE actors
        SET policy_version_accepted = $2, policy_accepted_at = now()
        WHERE id = $1
        RETURNING ${selectColumns}
      `,
      [actorId, policyVersion],
    );
    const actor = result.rows[0];

    return actor === undefined ? null : actorFromRow(actor, this.uppsBaseUrl);
  }

}
