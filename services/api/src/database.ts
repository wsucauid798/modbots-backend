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

const actorIdentityMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS handle text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS retired_at timestamptz;

  CREATE UNIQUE INDEX IF NOT EXISTS actors_handle_idx
    ON actors (handle)
    WHERE handle IS NOT NULL;
`;

const actorDiscriminatorMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS discriminator text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS registered boolean NOT NULL DEFAULT false;

  -- Adopt legacy client-supplied slug ids as handles so upgraded databases
  -- do not grow duplicate actors on the next find-or-create.
  UPDATE actors
  SET handle = id
  WHERE handle IS NULL
    AND retired_at IS NULL
    AND id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$'
    AND id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM actors other WHERE other.handle = actors.id
    );

  -- Adopt handles for the named development chat bots created before the
  -- handle column existed.
  UPDATE actors
  SET handle = adopt.handle
  FROM (VALUES
    ('Arwen', 'arwen'),
    ('Jacob', 'jacob'),
    ('Ru', 'ru-bot'),
    ('Felix', 'felix'),
    ('Bob', 'bob')
  ) AS adopt(display_name, handle)
  WHERE actors.handle IS NULL
    AND actors.retired_at IS NULL
    AND actors.actor_type = 'chat_bot'
    AND actors.display_name = adopt.display_name
    AND NOT EXISTS (
      SELECT 1 FROM actors other WHERE other.handle = adopt.handle
    );

  -- Assign discriminators to existing humans: random per name, starting at
  -- 4 digits and widening when a name's space fills.
  DO $$
  DECLARE
    human record;
    candidate text;
    width integer;
  BEGIN
    FOR human IN
      SELECT id, display_name
      FROM actors
      WHERE actor_type = 'human' AND discriminator IS NULL
      ORDER BY created_at
    LOOP
      width := 4;
      LOOP
        candidate := lpad(
          floor(random() * (10 ^ width))::bigint::text, width, '0'
        );

        IF NOT EXISTS (
          SELECT 1 FROM actors
          WHERE actor_type = 'human'
            AND display_name = human.display_name
            AND discriminator = candidate
        ) THEN
          UPDATE actors SET discriminator = candidate WHERE id = human.id;
          EXIT;
        END IF;

        IF (
          SELECT count(*) FROM actors
          WHERE actor_type = 'human'
            AND display_name = human.display_name
            AND length(discriminator) = width
        ) >= (10 ^ width) * 0.9 THEN
          width := width + 1;
        END IF;
      END LOOP;
    END LOOP;
  END $$;

  -- Humans always carry a discriminator; bots never do.
  ALTER TABLE actors ADD CONSTRAINT actors_discriminator_by_type
    CHECK ((actor_type = 'human') = (discriminator IS NOT NULL));

  -- A human identity (name plus discriminator) is unique, including retired
  -- actors, so a rendered identity is never reused.
  CREATE UNIQUE INDEX IF NOT EXISTS actors_human_identity_idx
    ON actors (display_name, discriminator)
    WHERE actor_type = 'human';

  -- Bot names are unique across chat bots and mod bots together. Retiring a
  -- bot frees its name.
  CREATE UNIQUE INDEX IF NOT EXISTS actors_bot_name_idx
    ON actors (lower(display_name))
    WHERE actor_type IN ('chat_bot', 'mod_bot') AND retired_at IS NULL;
`;

const contentItemsMigration = `
  CREATE TABLE IF NOT EXISTS content_items (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id),
    room_sequence bigint NOT NULL,
    actor_id text NOT NULL REFERENCES actors(id),
    lifecycle_state text NOT NULL DEFAULT 'published'
      CHECK (lifecycle_state IN ('published', 'edited', 'removed')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    reply_to jsonb,
    addressed_to jsonb NOT NULL DEFAULT '[]'::jsonb,
    parts jsonb NOT NULL,
    refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, room_sequence)
  );

  CREATE INDEX IF NOT EXISTS content_items_room_order_idx
    ON content_items (room_id, room_sequence);

  -- Backfill: represent existing text messages as published content items
  -- with one text part, so the content projection covers the full history.
  INSERT INTO content_items (
    id, room_id, room_sequence, actor_id, lifecycle_state, revision,
    parts, refs, created_at, updated_at
  )
  SELECT
    gen_random_uuid()::text,
    room_id,
    sequence,
    actor_id,
    'published',
    1,
    jsonb_build_array(
      jsonb_build_object(
        'partId', 'part-1',
        'kind', 'text',
        'text', payload->>'content'
      )
    ),
    '[]'::jsonb,
    occurred_at,
    occurred_at
  FROM room_events
  WHERE event_type = 'message_posted'
    AND actor_id IS NOT NULL
    AND coalesce(payload->>'content', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM content_items existing
      WHERE existing.room_id = room_events.room_id
        AND existing.room_sequence = room_events.sequence
    );
`;

const moderationTargetsMigration = `
  ALTER TABLE moderation_proposals ADD COLUMN IF NOT EXISTS target jsonb;
  ALTER TABLE moderation_proposals
    ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

  -- Backfill typed targets: legacy proposals targeted message event
  -- sequences, and those messages are now content items.
  UPDATE moderation_proposals
  SET target = jsonb_build_object(
    'targetType', 'content_item',
    'contentItemId', content_items.id
  )
  FROM content_items
  WHERE moderation_proposals.target IS NULL
    AND moderation_proposals.target_event_sequence IS NOT NULL
    AND content_items.room_id = moderation_proposals.room_id
    AND content_items.room_sequence = moderation_proposals.target_event_sequence;
`;

const participationPolicyMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS policy_version_accepted text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS policy_accepted_at timestamptz;
`;

const sessionsMigration = `
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES actors(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS sessions_actor_idx
    ON sessions (actor_id);
`;

const roomNameCleanupMigration = `
  -- The single room is called Room. The identifier stays global-lobby; ids
  -- are internal and never shown. The room description column was a mistake
  -- (the description is client copy, not room data) and is dropped.
  ALTER TABLE rooms DROP COLUMN IF EXISTS description;

  UPDATE rooms
  SET name = 'Room'
  WHERE id = 'global-lobby' AND name = 'Global Lobby';
`;

const ruleCitationsMigration = `
  ALTER TABLE moderation_proposals ADD COLUMN IF NOT EXISTS rule_id text;
  ALTER TABLE moderation_proposals ADD COLUMN IF NOT EXISTS rules_version text;
`;

const credentialsMigration = `
  CREATE TABLE IF NOT EXISTS actor_credentials (
    actor_id text PRIMARY KEY REFERENCES actors(id),
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

const profilePicturesMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_picture_id text;

  UPDATE actors
  SET profile_picture_id = CASE handle
    WHEN 'arwen' THEN 'resident-arwen'
    WHEN 'bob' THEN 'resident-bob'
    WHEN 'felix' THEN 'resident-felix'
    WHEN 'iris' THEN 'resident-iris'
    WHEN 'jacob' THEN 'resident-jacob'
    WHEN 'milo' THEN 'resident-milo'
    WHEN 'ru-bot' THEN 'resident-ru-bot'
    WHEN 'vera' THEN 'resident-vera'
    ELSE profile_picture_id
  END
  WHERE actor_type IN ('chat_bot', 'mod_bot')
    AND profile_picture_id IS NULL;
`;

const contentAddressingMigration = `
  ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS addressed_to jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

const mediaAssetsMigration = `
  CREATE TABLE IF NOT EXISTS media_assets (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id),
    owner_actor_id text NOT NULL REFERENCES actors(id),
    media_kind text NOT NULL
      CHECK (media_kind IN ('image', 'audio', 'video', 'file')),
    original_filename text NOT NULL,
    declared_media_type text NOT NULL,
    detected_media_type text,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    sha256 text,
    storage_object_key text NOT NULL UNIQUE,
    lifecycle_state text NOT NULL DEFAULT 'initiated'
      CHECK (lifecycle_state IN (
        'initiated', 'uploaded', 'quarantined', 'processing', 'published',
        'rejected', 'deleted'
      )),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    deleted_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS media_assets_room_created_idx
    ON media_assets (room_id, created_at);
`;

const actorProfilesMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_bio text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_pronouns text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_location text;
  ALTER TABLE actors
    ADD COLUMN IF NOT EXISTS profile_links text[] NOT NULL DEFAULT '{}';
`;

const actorStatusMigration = `
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_status_mode text;
  ALTER TABLE actors ADD COLUMN IF NOT EXISTS profile_status_text text;
`;

const roomDirectoryMigration = `
  ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
  ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity integer;
  ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
  ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';

  INSERT INTO rooms (
    id, name, description, capacity, sort_order, capabilities
  )
  VALUES
    (
      'global-lobby',
      'Main Square',
      'The main social room for general conversation.',
      NULL,
      1,
      '{}'
    ),
    (
      'share-show-off',
      'Share & Show-off',
      'Share music, movies, artwork, and other creative projects with others.',
      NULL,
      2,
      '{synchronized_media}'
    ),
    (
      'education',
      'Education',
      'All things teaching and learning.',
      NULL,
      3,
      '{}'
    ),
    (
      'sports',
      'Sports',
      'All things sports.',
      NULL,
      4,
      '{}'
    ),
    (
      'chill-play',
      'Chill & Play',
      'A relaxed room for conversation and simple games people can play together.',
      NULL,
      5,
      '{games}'
    ),
    (
      'science-technology',
      'Science & Technology',
      'All things science and technology.',
      NULL,
      6,
      '{}'
    )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    capacity = EXCLUDED.capacity,
    sort_order = EXCLUDED.sort_order,
    capabilities = EXCLUDED.capabilities;
`;

const outboxNotificationMigration = `
  CREATE OR REPLACE FUNCTION notify_event_outbox_inserted()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM pg_notify('event_outbox_inserted', '');
    RETURN NULL;
  END;
  $$;

  DROP TRIGGER IF EXISTS event_outbox_inserted_notification ON event_outbox;
  CREATE TRIGGER event_outbox_inserted_notification
  AFTER INSERT ON event_outbox
  FOR EACH STATEMENT
  EXECUTE FUNCTION notify_event_outbox_inserted();
`;

const gamesMigration = `
  CREATE TABLE IF NOT EXISTS game_sessions (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES rooms(id),
    game_type text NOT NULL CHECK (game_type IN ('tic_tac_toe')),
    state text NOT NULL CHECK (state IN ('waiting', 'active', 'won', 'draw', 'cancelled')),
    player_x_actor_id text NOT NULL REFERENCES actors(id),
    player_o_actor_id text REFERENCES actors(id),
    board jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null]'::jsonb,
    next_mark text CHECK (next_mark IN ('X', 'O')),
    winner_actor_id text REFERENCES actors(id),
    winning_line jsonb,
    rematch_of_session_id text REFERENCES game_sessions(id),
    rematch_session_id text REFERENCES game_sessions(id),
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS game_sessions_room_state_idx
    ON game_sessions (room_id, state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS game_spectators (
    session_id text NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    actor_id text NOT NULL REFERENCES actors(id),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, actor_id)
  );

  CREATE TABLE IF NOT EXISTS game_rematch_votes (
    session_id text NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    actor_id text NOT NULL REFERENCES actors(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, actor_id)
  );

  CREATE TABLE IF NOT EXISTS game_participant_statuses (
    session_id text NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
    actor_id text NOT NULL REFERENCES actors(id),
    previous_mode text,
    previous_text text,
    participation_role text NOT NULL CHECK (participation_role IN ('player', 'spectator')),
    PRIMARY KEY (session_id, actor_id)
  );
`;

const mediaStatusRoomsMigration = `
  UPDATE rooms
  SET capabilities = array_append(capabilities, 'media_status')
  WHERE id IN ('share-show-off', 'chill-play')
    AND NOT capabilities @> ARRAY['media_status'];
`;

const migrations = [
  { version: 1, sql: initialMigration },
  { version: 2, sql: outboxMigration },
  { version: 3, sql: actorIdentityMigration },
  { version: 4, sql: actorDiscriminatorMigration },
  { version: 5, sql: contentItemsMigration },
  { version: 6, sql: moderationTargetsMigration },
  { version: 7, sql: participationPolicyMigration },
  { version: 8, sql: sessionsMigration },
  { version: 11, sql: roomNameCleanupMigration },
  { version: 12, sql: ruleCitationsMigration },
  { version: 13, sql: credentialsMigration },
  { version: 14, sql: profilePicturesMigration },
  { version: 15, sql: contentAddressingMigration },
  { version: 16, sql: mediaAssetsMigration },
  { version: 17, sql: actorProfilesMigration },
  { version: 18, sql: outboxNotificationMigration },
  { version: 19, sql: actorStatusMigration },
  { version: 20, sql: roomDirectoryMigration },
  { version: 21, sql: gamesMigration },
  { version: 22, sql: mediaStatusRoomsMigration },
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
