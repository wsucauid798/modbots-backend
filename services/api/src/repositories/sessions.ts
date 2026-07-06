import type { Pool } from "pg";
import {
  generateSessionToken,
  hashSessionToken,
  sessionExpiresAt,
} from "../domain/sessions.js";
import type { ActorType } from "./actors.js";

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export interface SessionActor {
  actorId: string;
  actorType: ActorType;
}

export interface SessionRepository {
  issue(actorId: string): Promise<IssuedSession>;
  resolve(token: string): Promise<SessionActor | null>;
  revoke(token: string): Promise<boolean>;
}

// A session resolves only while it is live: not expired, not revoked, and
// belonging to an actor that is not retired. Revoking uses the same
// definition, so a token that no longer resolves cannot be revoked either.
const liveSessionConditions = `
  sessions.token_hash = $1
  AND sessions.revoked_at IS NULL
  AND sessions.expires_at > now()
  AND actors.retired_at IS NULL
`;

export class PostgresSessionRepository implements SessionRepository {
  public constructor(
    private readonly database: Pool,
    private readonly ttlDays: number,
  ) {}

  public async issue(actorId: string): Promise<IssuedSession> {
    const token = generateSessionToken();
    const result = await this.database.query<{ expires_at: Date }>(
      `
        INSERT INTO sessions (token_hash, actor_id, expires_at)
        VALUES ($1, $2, $3)
        RETURNING expires_at
      `,
      [hashSessionToken(token), actorId, sessionExpiresAt(this.ttlDays)],
    );

    return {
      token,
      expiresAt: result.rows[0]!.expires_at.toISOString(),
    };
  }

  public async resolve(token: string): Promise<SessionActor | null> {
    const result = await this.database.query<{
      actor_id: string;
      actor_type: ActorType;
    }>(
      `
        SELECT sessions.actor_id, actors.actor_type
        FROM sessions
        JOIN actors ON actors.id = sessions.actor_id
        WHERE ${liveSessionConditions}
      `,
      [hashSessionToken(token)],
    );
    const session = result.rows[0];

    return session === undefined
      ? null
      : { actorId: session.actor_id, actorType: session.actor_type };
  }

  public async revoke(token: string): Promise<boolean> {
    const result = await this.database.query(
      `
        UPDATE sessions
        SET revoked_at = now()
        FROM actors
        WHERE actors.id = sessions.actor_id
          AND ${liveSessionConditions}
      `,
      [hashSessionToken(token)],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
