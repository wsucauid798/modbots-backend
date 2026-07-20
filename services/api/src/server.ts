import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase, migrateDatabase } from "./database.js";
import { loadInferenceManifest } from "./inference-manifest.js";
import { SessionWriteAuthorizer } from "./domain/auth.js";
import { CommandService } from "./domain/commands.js";
import { ModerationPolicy } from "./domain/moderation-policy.js";
import { JetStreamOutboxPublisher } from "./events/outbox-publisher.js";
import { PostgresActorRepository } from "./repositories/actors.js";
import { PostgresContentRepository } from "./repositories/content.js";
import { PostgresCredentialRepository } from "./repositories/credentials.js";
import { PostgresModerationRepository } from "./repositories/moderation.js";
import {
  MediaObjectStorage,
  PostgresMediaRepository,
} from "./repositories/media.js";
import { PostgresRoomRepository } from "./repositories/rooms.js";
import { PostgresSessionRepository } from "./repositories/sessions.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const database = createDatabase(config.database);
  const publisher = new JetStreamOutboxPublisher(database, config.natsUrl);
  const actors = new PostgresActorRepository(database, config.upps.publicUrl);
  const sessions = new PostgresSessionRepository(
    database,
    config.auth.sessionTtlDays,
  );
  const media = new PostgresMediaRepository(
    database,
    new MediaObjectStorage(config.objectStorage),
  );
  const app = buildApp({
    accountUrl: config.auth.accountUrl,
    actors,
    auth: new SessionWriteAuthorizer(sessions, actors, config.auth.mode),
    commands: new CommandService(
      database,
      new ModerationPolicy(config.moderation),
      config.upps.publicUrl,
    ),
    content: new PostgresContentRepository(database),
    credentials: new PostgresCredentialRepository(database),
    database,
    moderation: new PostgresModerationRepository(database),
    media,
    inferenceManifest: loadInferenceManifest(config.inference.manifestPath),
    publisher,
    rooms: new PostgresRoomRepository(database, config.upps.publicUrl),
    sessions,
  });

  try {
    await migrateDatabase(database);
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    app.log.error(error);
    await database.end();
    process.exit(1);
  }
};

void start();
