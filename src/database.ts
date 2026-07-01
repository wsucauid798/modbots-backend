import { Pool, type PoolClient, type PoolConfig } from "pg";

const initialMigration = `
  CREATE TABLE IF NOT EXISTS actors (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    actor_type text NOT NULL
      CHECK (actor_type IN ('human', 'chat_bot', 'mod_bot')),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS room_events (
    sequence bigserial PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id),
    event_type text NOT NULL,
    actor_id text REFERENCES actors(id),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS room_events_room_sequence_idx
    ON room_events (room_id, sequence);

  CREATE TABLE IF NOT EXISTS moderation_proposals (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id),
    mod_bot_id text NOT NULL REFERENCES actors(id),
    target_event_sequence bigint REFERENCES room_events(sequence),
    action text NOT NULL,
    confidence double precision NOT NULL
      CHECK (confidence >= 0 AND confidence <= 1),
    rationale jsonb NOT NULL DEFAULT '{}'::jsonb,
    model_version text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS moderation_proposals_room_status_idx
    ON moderation_proposals (room_id, status);

  INSERT INTO rooms (id, name)
  VALUES ('global-lobby', 'Global Lobby')
  ON CONFLICT (id) DO NOTHING;
`;

const outboxMigration = `
  CREATE TABLE IF NOT EXISTS event_outbox (
    id bigserial PRIMARY KEY,
    room_event_sequence bigint NOT NULL UNIQUE REFERENCES room_events(sequence),
    subject text NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz
  );

  CREATE INDEX IF NOT EXISTS event_outbox_pending_idx
    ON event_outbox (available_at, id)
    WHERE published_at IS NULL;
`;

const migrations = [
  { version: 1, sql: initialMigration },
  { version: 2, sql: outboxMigration },
] as const;

export const createDatabase = (config: PoolConfig): Pool =>
  new Pool({
    ...config,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

export const migrateDatabase = async (database: Pool): Promise<void> => {
  const client = await database.connect();

  try {
    await client.query(
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version integer PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `,
    );
    await client.query("SELECT pg_advisory_lock($1)", [7_248_619]);

    for (const migration of migrations) {
      const applied = await client.query<{ exists: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1 FROM schema_migrations WHERE version = $1
          ) AS exists
        `,
        [migration.version],
      );

      if (applied.rows[0]?.exists) {
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [migration.version],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7_248_619]);
    client.release();
  }
};

export const withTransaction = async <Result>(
  database: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> => {
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
