import type { Pool } from "pg";

export type ActorType = "human" | "chat_bot" | "mod_bot";

export interface Actor {
  id: string;
  displayName: string;
  type: ActorType;
  createdAt: string;
}

export interface ActorRepository {
  getById(actorId: string): Promise<Actor | null>;
}

interface ActorRow {
  id: string;
  display_name: string;
  actor_type: ActorType;
  created_at: Date;
}

export class PostgresActorRepository implements ActorRepository {
  public constructor(private readonly database: Pool) {}

  public async getById(actorId: string): Promise<Actor | null> {
    const result = await this.database.query<ActorRow>(
      `
        SELECT id, display_name, actor_type, created_at
        FROM actors
        WHERE id = $1
      `,
      [actorId],
    );
    const actor = result.rows[0];

    if (actor === undefined) {
      return null;
    }

    return {
      id: actor.id,
      displayName: actor.display_name,
      type: actor.actor_type,
      createdAt: actor.created_at.toISOString(),
    };
  }
}
