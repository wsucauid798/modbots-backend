import type { Pool } from "pg";

export interface CredentialRepository {
  setPassword(actorId: string, passwordHash: string): Promise<void>;
  passwordHashFor(actorId: string): Promise<string | null>;
}

export class PostgresCredentialRepository implements CredentialRepository {
  public constructor(private readonly database: Pool) {}

  public async setPassword(
    actorId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.database.query(
      `
        INSERT INTO actor_credentials (actor_id, password_hash)
        VALUES ($1, $2)
        ON CONFLICT (actor_id) DO UPDATE
        SET password_hash = EXCLUDED.password_hash, updated_at = now()
      `,
      [actorId, passwordHash],
    );
  }

  public async passwordHashFor(actorId: string): Promise<string | null> {
    const result = await this.database.query<{ password_hash: string }>(
      `SELECT password_hash FROM actor_credentials WHERE actor_id = $1`,
      [actorId],
    );

    return result.rows[0]?.password_hash ?? null;
  }
}
